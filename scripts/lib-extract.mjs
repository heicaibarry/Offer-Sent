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

/* ------------------------------------------------------------------ *
 * 截止日期抽取（endsAt）
 *
 * 背景：站点把「活动是否过期」完全押在 endsAt 上——没有 endsAt 的活动
 * 永远不会下架、永远显示「进行中」。实测线上 39 条活动只有 6 条带日期，
 * 等于过期机制只覆盖了 15% 的数据，用户可能看到早就结束的"优惠"。
 *
 * 所以这里做两层：
 *   1) LLM 提取时把 endsAt 列为必填语义（prompt 里写死抽取规则）；
 *   2) LLM 没给出日期时，用本地正则从 title/detail/window 原文里兜底抽一次。
 * 仍然抽不到就保持 null —— 宁可标"时间未标明"，也不编造日期。
 * ------------------------------------------------------------------ */

const CN_MONTH = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };

// 一个日期片段：2026年10月7日 / 2026-10-07 / 10月7日 / 10/7 / 10-7
const D_PAT =
  "(?:(\\d{4})\\s*[年\\-/.]\\s*)?(\\d{1,2}|十[一二]?|[一二三四五六七八九])\\s*[月\\-/.]\\s*(\\d{1,2})\\s*日?";

function cnToNum(s) {
  if (s == null) return null;
  if (/^\d+$/.test(s)) return Number(s);
  return CN_MONTH[s] ?? null;
}

/** 把一次正则匹配解析成 YYYY-MM-DD；缺年份时按「最接近今天」补全 */
function toISO(y, m, d, todayMs) {
  const mon = cnToNum(m);
  const day = cnToNum(d);
  if (!mon || !day || mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  const pad = (n) => String(n).padStart(2, "0");
  if (y) return `${y}-${pad(mon)}-${pad(day)}`;
  const year = new Date(todayMs).getUTCFullYear();
  const mk = (yy) => Date.parse(`${yy}-${pad(mon)}-${pad(day)}T00:00:00+08:00`);
  const thisYear = mk(year);
  if (!Number.isFinite(thisYear)) return null;
  // 已经过去很久（>60 天）说明写的是跨年活动的次年日期
  const useYear = thisYear < todayMs - 60 * 864e5 ? year + 1 : year;
  return `${useYear}-${pad(mon)}-${pad(day)}`;
}

/**
 * 从活动文本里抽截止日期。只在出现明确时间语义时抽，抽不到返回 null。
 * 优先级：区间结束日 > 「截止/截至/止于 X」 > 不猜。
 * 「领完即止」「长期有效」这类没有具体日期的，明确返回 null（由调用方标 endsUnknown）。
 */
export function guessEndsAt(text, todayISO) {
  if (!text) return null;
  const t = String(text);
  const todayMs = Date.parse(`${todayISO}T00:00:00+08:00`);
  if (!Number.isFinite(todayMs)) return null;

  // 1) 区间：「6/10–11/8」「9月15日-10月30日」→ 取结束日
  const rangeRe = new RegExp(`${D_PAT}\\s*(?:–|—|~|～|至|到|--?)\\s*${D_PAT}`, "g");
  let best = null;
  for (const m of t.matchAll(rangeRe)) {
    const iso = toISO(m[4], m[5], m[6], todayMs);
    if (iso) best = iso;
  }
  if (best) return best;

  // 2) 单个日期，但必须跟在时间引导词后面，避免把「注册送 2000 万 tokens」这类数字误当日期
  const singleRe = new RegExp(`(?:截止|截至|止于|结束于|活动时间|活动期间|持续至)\\s*(?:到|于)?\\s*${D_PAT}`, "g");
  for (const m of t.matchAll(singleRe)) {
    const iso = toISO(m[1], m[2], m[3], todayMs);
    if (iso) best = iso;
  }
  return best;
}

// 文本里出现这些词却没有解析出日期 → 说明这是个有期限的活动，只是页面没写清
const LIMITED_HINT = /限时|限量|截止|截至|止于|领完即止|先到先得|活动期间|活动时间|抢购|倒计时/;

/** 组装提取用的 Prompt */
function buildPrompt(productName, url, pageText, existingTitles, todayISO) {
  return [
    `你是优惠活动数据录入员。今天是 ${todayISO}。下面是「${productName}」官方页面（${url}）的正文。请完成两件事：`,
    "",
    "一、提取页面中正在进行、未过期的优惠/活动信息，严格输出 JSON 数组，每个元素形如：",
    '{"title":"一句话活动名","detail":"活动内容/力度/参与方式，60字内","window":"时间或适用范围，没有则留空","endsAt":"截止日期 YYYY-MM-DD，没有就 null","timeHint":"页面原文里的时间描述，原样摘录，没有就留空"}',
    "",
    "【endsAt 抽取规则，优先级最高，务必逐条执行】",
    "- 页面写了活动区间的（如「活动时间 6/10–11/8」「9月15日—10月30日」「9/15–10/30」），endsAt 取区间的**结束日**；",
    "- 页面写了「截止/截至/止于/结束于 X月X日」的，endsAt 取该日；",
    "- 月份日期没写年份的，按最接近今天的年份补全（跨年活动补次年）；",
    "- 只写了开始日、没写结束日 → endsAt 必须是 null；",
    "- 写了「领完即止」「长期有效」「长期」「永久」等没有具体日期的 → endsAt 必须是 null，并在 timeHint 里原样摘录该说法；",
    "- **绝对不要为了填空而编造日期**。页面没写日期就写 null，这是正确答案，不是失败。",
    "二、对照下方「已有活动」清单：如果页面上某个已有活动被明确标注了「已结束」「已过期」「活动已下线」等结束标记，额外输出一个元素：",
    '{"remove":"该活动在已有活动清单里的标题"}',
    "要求：",
    "- 定价表、功能介绍、文档内容不算活动，不要收；",
    "- 邀请返利、裂变奖励、新用户礼、注册送额度、签到赠送、限时折扣、节日活动等运营活动都是要收录的目标，即使长期有效也要收；",
    "- 只收录页面上明确存在的活动，禁止编造、禁止推测；",
    "- remove 只允许在页面出现明确的结束标记时使用，页面没提结束就不要输出；",
    "- 页面没有任何活动、也没有任何结束标记时返回 []；",
    "- 只输出纯 JSON 数组，不要 markdown 代码块，不要解释。",
    `已有活动（提取时不要重复收录；若页面标注了结束，用 remove 输出）：${existingTitles.length ? existingTitles.join("；") : "无"}`,
    "=== 页面正文 ===",
    pageText.slice(0, 12000),
  ].join("\n");
}

/**
 * 调 LLM 提取活动。返回 { promos, removals }：
 *   - promos:   归一化后的新活动数组（title/detail/window/endsAt/source/firstSeen/auto）
 *   - removals: 页面明确标注已结束的已有活动标题数组
 * API/解析失败会抛错。
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
        { role: "user", content: buildPrompt(productName, url, pageText, existingTitles, todayISO) },
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
  if (!Array.isArray(arr)) return { promos: [], removals: [] };
  const promos = arr
    .filter((x) => x && typeof x.title === "string" && x.title.trim())
    .map((x) => {
      const title = String(x.title).trim().slice(0, 80);
      const detail = String(x.detail || "").trim().slice(0, 160);
      const window = String(x.window || "").trim().slice(0, 60);
      const timeHint = String(x.timeHint || "").trim().slice(0, 80);
      // LLM 没给出合法日期时，用本地正则从原文兜底再抽一次（区间结束日 / 「截止 X 月 X 日」）
      let endsAt = /^\d{4}-\d{2}-\d{2}$/.test(String(x.endsAt || "")) ? x.endsAt : null;
      if (!endsAt) endsAt = guessEndsAt(`${title} ${detail} ${window} ${timeHint}`, todayISO);
      // 有「限时/领完即止」这类字样却拿不到日期 → 显式标注，
      // 前端据此显示「时间未标明」，而不是把它当成长期有效
      const endsUnknown = !endsAt && LIMITED_HINT.test(`${title} ${detail} ${window} ${timeHint}`);
      return {
        title,
        detail,
        window,
        endsAt,
        ...(endsUnknown ? { endsUnknown: true } : {}),
        ...(timeHint ? { timeHint } : {}),
        source: url,
        firstSeen: todayISO,
        auto: "llm",
      };
    });
  const removals = arr
    .filter((x) => x && typeof x.remove === "string" && x.remove.trim())
    .map((x) => String(x.remove).trim())
    .slice(0, 5);
  return { promos, removals };
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

/**
 * 失效移除：把 LLM 报告的「页面已标注结束」标题模糊匹配回现有活动。
 * 只匹配 source 等于当前页面的活动（别的页面收录的活动不由本页判断），限量 max。
 * 返回应删除的 promo 数组（直接从 promos 数组里剔除即可）。
 */
export function pickRemovals(removalTitles, existingPromos, pageUrl, { max = 3 } = {}) {
  const out = [];
  for (const t of removalTitles || []) {
    if (out.length >= max) break;
    const hit = (existingPromos || []).find(
      (x) => x.source === pageUrl && isDuplicateTitle(t, [x.title]) && !out.includes(x)
    );
    if (hit) out.push(hit);
  }
  return out;
}

/** 供脚本读取 products.json（含 updatedAt/policy 元信息） */
export function readProducts(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "products.json"), "utf8"));
}
