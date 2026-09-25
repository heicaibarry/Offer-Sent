/**
 * LLM 自动收录公共库：官方页面正文 → 结构化活动 JSON → 过滤后可直接并入 products.json。
 * 供 crawl.mjs（监控页有变化时提取）和 discover.mjs（--auto 收录高分新候选页）共用。
 *
 * 设计要点：
 *   - 未配置 GLM_API_KEY 时 hasLLM() 为 false，调用方整体跳过，其余功能不受影响；
 *   - Prompt 强约束「只提取页面明确存在的活动，没有就返回 []」，并附已有活动清单防重复；
 *   - 入库前过滤：endsAt 已过期/非法的丢弃、标题与已有活动去重、每页限量，防幻觉刷库。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const LLM_KEY = process.env.GLM_API_KEY || "";
export const LLM_MODEL = process.env.LLM_MODEL || "glm-4.5-flash";
export const LLM_BASE = (process.env.LLM_BASE || "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/, "");

export const hasLLM = () => Boolean(LLM_KEY);

/** 标题归一化：只留中英文和数字，小写 */
export function normalizeTitle(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
}

/** 字符三元组集合，用于中文标题的模糊相似度 */
function trigrams(s) {
  const set = new Set();
  for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 与任一已有标题完全相同 / 互相包含 / 三元组 Jaccard ≥ 0.4 即视为重复 */
export function isDuplicateTitle(title, existingTitles) {
  const n = normalizeTitle(title);
  if (!n) return true;
  const g = trigrams(n);
  return (existingTitles || []).some((t) => {
    const m = normalizeTitle(t);
    if (!m) return false;
    if (n === m || n.includes(m) || m.includes(n)) return true;
    return jaccard(g, trigrams(m)) >= 0.4;
  });
}

/** 组装提取用的 Prompt */
function buildPrompt(productName, url, pageText, existingTitles) {
  return [
    `你是优惠活动数据录入员。下面是「${productName}」官方页面（${url}）的正文。`,
    "请提取页面中正在进行、未过期的优惠/活动信息，严格输出 JSON 数组，每个元素形如：",
    '{"title":"一句话活动名","detail":"活动内容/力度/参与方式，60字内","window":"时间或适用范围，没有则留空","endsAt":"截止日期 YYYY-MM-DD，页面没写就是 null"}',
    "要求：",
    "- 定价表、功能介绍、文档内容不算活动，不要收；",
    "- 邀请返利、裂变奖励、新用户礼、注册送额度、签到赠送、限时折扣、节日活动等运营活动都是要收录的目标，即使长期有效也要收；",
    "- 只收录页面上明确存在的活动，禁止编造、禁止推测；",
    "- 页面没有上述任何活动时返回 []；",
    "- 只输出纯 JSON 数组，不要 markdown 代码块，不要解释。",
    `已有活动（这些不要再收录）：${existingTitles.length ? existingTitles.join("；") : "无"}`,
    "=== 页面正文 ===",
    pageText.slice(0, 12000),
  ].join("\n");
}

/**
 * 调 LLM 提取活动。返回归一化后的 promo 数组（可能为空），API/解析失败会抛错。
 * promos 元素：{ title, detail, window, endsAt, source, firstSeen, auto }
 */
export async function llmExtract({ productName, url, pageText, existingTitles, todayISO }) {
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.2,
      max_tokens: 1500,
      messages: [
        { role: "system", content: "你是严谨的数据录入员，只输出 JSON。" },
        { role: "user", content: buildPrompt(productName, url, pageText, existingTitles) },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  let out = data.choices?.[0]?.message?.content || "[]";
  out = out.replace(/```(json)?/gi, "").trim();
  const s = out.indexOf("[");
  const e = out.lastIndexOf("]");
  if (s === -1 || e <= s) return [];
  const arr = JSON.parse(out.slice(s, e + 1));
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof x.title === "string" && x.title.trim())
    .map((x) => ({
      title: String(x.title).trim().slice(0, 80),
      detail: String(x.detail || "").trim().slice(0, 160),
      window: String(x.window || "").trim().slice(0, 60),
      endsAt: /^\d{4}-\d{2}-\d{2}$/.test(String(x.endsAt || "")) ? x.endsAt : null,
      source: url,
      firstSeen: todayISO,
      auto: "llm",
    }));
}

/**
 * 入库前过滤：去掉重复标题、已过期/明显错误的条目，限量 max。
 * 返回可直接 append 进 product.promos 的数组。
 */
export function filterNewPromos(promos, existingTitles, { max = 5 } = {}) {
  const seen = [...(existingTitles || [])];
  const out = [];
  const now = Date.now();
  for (const p of promos || []) {
    if (out.length >= max) break;
    if (isDuplicateTitle(p.title, seen)) continue;
    if (p.endsAt) {
      const t = Date.parse(`${p.endsAt}T23:59:59+08:00`);
      if (!Number.isFinite(t) || t < now) continue; // 已过期或日期非法，不收
    }
    out.push(p);
    seen.push(p.title);
  }
  return out;
}

/** 供脚本读取 products.json（含 updatedAt/policy 元信息） */
export function readProducts(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "products.json"), "utf8"));
}
