/**
 * 定时抓取各官方定价页 → 内容指纹 diff → 变更则记录并推送提醒。
 *
 * 用法：
 *   node scripts/crawl.mjs              # 正常运行（受 everyHours 间隔控制）
 *   node scripts/crawl.mjs --baseline   # 只刷新基线指纹，不记录变更、不推送
 *   node scripts/crawl.mjs --only trae-pricing,trae-student   # 只跑指定源（逗号分隔多个）
 *
 * 推送渠道（可选，配了才推）：
 *   WECHAT_WEBHOOK   企业微信群机器人 webhook 地址
 *   PUSHPLUS_TOKEN   pushplus.plus 的 token
 *
 * 首次运行时所有源只记录基线，不产生变更记录。
 * SPA 页面（renderer: "browser"）需要 playwright：npm i -D playwright && npx playwright install chromium
 * 未安装时自动降级为普通 HTTP 抓取（可能拿不到渲染后的价格，但页面文案变化仍可感知）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { hasLLM, llmExtract, filterNewPromos, pickRemovals, readProducts } from "./lib-extract.mjs";

// CRAWL_PROXY_URL：可选的 HTTP 代理（http://user:pass@host:port）。
// Trae 等站点对海外数据中心 IP 做地理/指纹拦截，配一个国内代理即可在 Actions 上抓通；
// 代理只作用于官方站抓取（fetch + browser 渲染），不影响推送通道。
const PROXY_URL = process.env.CRAWL_PROXY_URL || "";
let proxyDispatcher;
if (PROXY_URL) {
  try {
    const { ProxyAgent } = await import("undici");
    proxyDispatcher = new ProxyAgent(PROXY_URL);
    console.log(`已启用抓取代理: ${PROXY_URL.replace(/\/\/[^@]*@/, "//***@")}`);
  } catch (e) {
    console.log(`代理初始化失败（忽略，直连抓取）: ${e.message}`);
  }
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const SNAP_DIR = path.join(DATA, "snapshots");

const SOURCES = JSON.parse(fs.readFileSync(path.join(DATA, "sources.json"), "utf8")).sources;
const PRODUCTS = JSON.parse(fs.readFileSync(path.join(DATA, "products.json"), "utf8")).products;
const STATE_FILE = path.join(DATA, "crawl-state.json");
const CHANGES_FILE = path.join(DATA, "changes.json");

const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
const changes = JSON.parse(fs.readFileSync(CHANGES_FILE, "utf8"));

const BASELINE = process.argv.includes("--baseline");
const onlyIdx = process.argv.indexOf("--only");
// 支持逗号分隔多源：--only trae-pricing,trae-student（本地补抓反爬源时用）
const ONLY_LIST =
  onlyIdx > -1
    ? process.argv[onlyIdx + 1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
// --backfill=id1,id2：跳过指纹 diff，直接抓这些源跑 LLM 提取并收录新活动。
// 用途：给刚上线的自动收录「补课」——把开启提取之前漏掉的历史页面变化补录进数据。
const backfillEqArg = process.argv.find((a) => a.startsWith("--backfill="));
const backfillIdx = process.argv.indexOf("--backfill");
const BACKFILL_LIST = backfillEqArg
  ? backfillEqArg
      .slice("--backfill=".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : backfillIdx > -1
    ? (process.argv[backfillIdx + 1] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// 正文过短说明拿到的是空页 / JS 外壳 / 反爬拦截页，不能拿它当内容基线。
// 曾经把空串写成基线，导致该源的指纹永远是 sha1("")，之后再也不会报变更（假"无变化"）。
const MIN_TEXT = 200;
// 差异片段过短多半是时间戳、访问量之类的噪声，不值得记一条变更
const MIN_EXCERPT = 20;
// 正文拿不到时的第三通道：r.jina.ai 渲染代理（对部分反爬站有效；READER_ENABLED=0 关闭）
const READER_ENABLED = process.env.READER_ENABLED !== "0";
const READER_BASE = (process.env.READER_BASE || "https://r.jina.ai/").replace(/\/?$/, "/");
// 单轮自动收录的总上限，防止某次大面积改版把 LLM 输出全量灌进数据
const MAX_AUTO_PER_RUN = Number(process.env.MAX_AUTO_PER_RUN || 10);

// ===== 抓取健康度自检 =====
// 背景：SPA 定价页在 playwright 不可用时降级成 fetch，只能拿到空壳/骨架，
// 此后指纹恒定、再也不会报「有变化」——表面「核对成功」，实际已经瞎了。
// 判据：连续 STUCK_ALERT 轮指纹不变，且正文短于 DEGRADED_MAX_CHARS
// （正常定价页通常几千字，200~800 字基本就是骨架页），判定为疑似降级。
const STUCK_ALERT = Number(process.env.STUCK_ALERT || 6);
const DEGRADED_MAX_CHARS = Number(process.env.DEGRADED_MAX_CHARS || 800);

const productName = (id) => PRODUCTS.find((p) => p.slug === id)?.name || id;
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

/* ------------------------------------------------------------------ *
 * 活动区块指纹（与整页指纹解耦）
 *
 * 为什么需要单独一份：页面变更「记不记一条 changes」是有节流的 ——
 * 「差异与已记录的一致」和「差异片段过短」两种情况都会被跳过（防轮播图、
 * 访问计数器刷屏）。但这两道节流会连带把「活动区真的换了」一起挡掉，
 * 结果就是：页面变了、活动变了，却永远不触发 LLM 收录。
 * 实测 9-28~9-30 的 workbuddy / modelscope / minimax 就是这么被吞掉的。
 *
 * 解耦方式：只看「像优惠」的句子算一份独立指纹，它变了就必须提取，
 * 与整页那段噪声差异记不记录无关。
 * ------------------------------------------------------------------ */
const DEAL_LINE = /[¥￥]|\d\s*折|限时|免费|赠送|首月|立省|优惠|活动|领取|签到|返现|加赠|翻倍|额度/;
function dealFingerprint(fullText) {
  const sentences = String(fullText)
    .split(/[。；;！!？?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && DEAL_LINE.test(s));
  return sha1(sentences.join("|").slice(0, 30000));
}
const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function pageTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? extractText(m[1]).slice(0, 120) : "";
}

function firstDiffRegion(oldText, newText) {
  let i = 0;
  const n = Math.min(oldText.length, newText.length);
  while (i < n && oldText[i] === newText[i]) i++;
  return newText.slice(Math.max(0, i - 30), i + 170).trim();
}

const snapPath = (id) => path.join(SNAP_DIR, `${id}.txt`);
const saveSnap = (id, text) => {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.writeFileSync(snapPath(id), text);
};
const loadSnap = (id) => (fs.existsSync(snapPath(id)) ? fs.readFileSync(snapPath(id), "utf8") : "");

async function renderBrowser(url) {
  try {
    const { chromium } = await import("playwright");
    const launchArgs = ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--lang=zh-CN"];
    if (PROXY_URL) launchArgs.push(`--proxy-server=${PROXY_URL}`);
    const browser = await chromium.launch({ args: launchArgs });
    const page = await browser.newPage({
      userAgent: UA,
      viewport: { width: 1366, height: 900 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    // 反爬站（如 Trae 的 WAF）会探测自动化特征，这里抹掉最常见的几个
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      window.chrome = window.chrome || { runtime: {} };
      Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2000);
    let html = await page.content();
    // 反爬挑战 / 懒加载有时先给空壳：多等几秒再取一次，仍拿不到才算失败
    if (extractText(html).length < MIN_TEXT) {
      await page.waitForTimeout(6000);
      html = await page.content();
    }
    await browser.close();
    return { html, how: "browser" };
  } catch {
    return null; // playwright 未安装或启动失败，由调用方降级
  }
}

async function fetchPlain(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    dispatcher: proxyDispatcher, // undefined 时为直连
  });
  return { html: await res.text(), how: "fetch" };
}

// 渲染代理兜底：Jina Reader 会用自己的基础设施抓取并转成 Markdown，
// 对「本机/Actions IP 被反爬拦截但 Jina 的出口没被拦」的站点有效。
async function fetchViaReader(url) {
  const res = await fetch(READER_BASE + url, {
    headers: { "user-agent": UA, accept: "text/plain" },
    redirect: "follow",
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`reader HTTP ${res.status}`);
  const html = await res.text();
  return { html, how: "reader" };
}

// 拿到的正文太短（空壳/被拦）时依次换通道重试，成功就替换 res。
// browser 渲染源没试过 fetch（本机/住宅 IP 场景下 fetch 往往就能过），先补 fetch 再试渲染代理。
async function upgradeIfEmpty(res, url, fetchTried, minText) {
  let cur = res;
  if (!fetchTried) {
    try {
      const alt = await fetchPlain(url);
      if (extractText(alt.html).length > extractText(cur.html).length) cur = alt;
    } catch {}
    if (extractText(cur.html).length >= minText) return cur;
  }
  if (READER_ENABLED) {
    try {
      const alt = await fetchViaReader(url);
      if (extractText(alt.html).length > extractText(cur.html).length) cur = alt;
    } catch (e) {
      console.log(`  ↪ 渲染代理也不可用: ${e.message}`);
    }
  }
  return cur;
}

async function notify(list) {
  const health = list.filter((c) => c.kind === "health");
  const updates = list.filter((c) => c.kind !== "health");
  const lines = updates
    .slice(0, 10)
    .map(
      (c) =>
        `**${productName(c.product)}** 官网页面有更新\n${c.pageTitle ? `> ${c.pageTitle}\n` : ""}${c.url}`
    );
  const healthLines = health
    .slice(0, 5)
    .map((c) => `⚠️ **${productName(c.product)}** ${c.pageTitle}\n${c.excerpt}`);
  const content =
    `🔔 Agent优惠雷达：发现 ${updates.length} 处页面更新` +
    `${health.length ? ` / ${health.length} 个抓取告警` : ""}\n\n` +
    (healthLines.length ? `【抓取健康告警】\n${healthLines.join("\n")}\n\n` : "") +
    (lines.length ? lines.join("\n\n") + `\n\n请打开网站核对具体优惠变化。` : "");

  const webhook = process.env.WECHAT_WEBHOOK;
  const token = process.env.PUSHPLUS_TOKEN;

  if (webhook) {
    try {
      const r = await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { content: content.slice(0, 4000) } }),
      });
      console.log(`已推送企业微信 (${r.status})`);
    } catch (e) {
      console.log(`企业微信推送失败: ${e.message}`);
    }
  }
  if (token) {
    try {
      const r = await fetch("https://www.pushplus.plus/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, title: `Agent优惠雷达：${list.length} 处官方页面更新`, template: "txt", content: content.slice(0, 1800) }),
      });
      console.log(`已推送 pushplus (${r.status})`);
    } catch (e) {
      console.log(`pushplus 推送失败: ${e.message}`);
    }
  }
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: tgChat, text: content.slice(0, 3500), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(30000),
      });
      console.log(`已推送 Telegram (${r.status})`);
    } catch (e) {
      console.log(`Telegram 推送失败: ${e.message}`);
    }
  }
  const scKey = process.env.SERVERCHAN_SENDKEY;
  if (scKey) {
    try {
      const r = await fetch(`https://sctapi.ftqq.com/${scKey}.send`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          title: `Agent优惠雷达：${list.length} 处官方页面更新`,
          desp: content.replace(/\*\*/g, "**").slice(0, 3000),
        }).toString(),
        signal: AbortSignal.timeout(30000),
      });
      console.log(`已推送 Server酱 (${r.status})`);
    } catch (e) {
      console.log(`Server酱 推送失败: ${e.message}`);
    }
  }
  if (!webhook && !token && !(tgToken && tgChat) && !scKey)
    console.log("(未配置推送渠道，跳过提醒；可设置 WECHAT_WEBHOOK / PUSHPLUS_TOKEN / SERVERCHAN_SENDKEY / TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)");
}

// 过期活动数据清理：endsAt 已过期的条目从 products.json 里删除（默认过期 2 天后，
// 给时区/边界留缓冲；前端在过期当天就已实时隐藏）。PRUNE_DAYS 可用环境变量覆盖
// （设为 -1 关闭清理）；无法解析的截止时间一律保留。
const PRUNE_DAYS = Number(process.env.PRUNE_DAYS ?? 2);

function pruneExpired() {
  if (!Number.isFinite(PRUNE_DAYS) || PRUNE_DAYS < 0) return 0;
  const cutoff = Date.now() - PRUNE_DAYS * 864e5;
  let removed = 0;
  for (const p of PRODUCTS) {
    if (!Array.isArray(p.promos) || !p.promos.length) continue;
    const keep = p.promos.filter((x) => {
      if (!x.endsAt) return true;
      const t = Date.parse(x.endsAt);
      if (!Number.isFinite(t)) return true;
      return t >= cutoff;
    });
    removed += p.promos.length - keep.length;
    p.promos = keep;
  }
  return removed;
}

// 补录模式：跳过指纹 diff，直接抓指定源 → LLM 提取 → 合并进 products.json。
// 新收录以 auto-promo 条目推进 added，由调用方统一写 changes 并推送提醒。
async function runBackfill(added, budget) {
  const targets = SOURCES.filter((s) => BACKFILL_LIST.includes(s.id) && s.enabled !== false);
  console.log(`===== 补录提取：${targets.length} 个源 =====`);
  const meta = JSON.parse(fs.readFileSync(path.join(DATA, "products.json"), "utf8"));
  const todayISO = nowISO().slice(0, 10);
  let total = 0;
  for (const s of targets) {
    if (total >= budget) {
      console.log("· 已达单轮收录上限，停止补录");
      break;
    }
    const product = meta.products.find((p) => p.slug === s.product);
    if (!product) continue;
    let res = null;
    if (s.renderer === "browser") res = await renderBrowser(s.url);
    if (!res) {
      try {
        res = await fetchPlain(s.url);
      } catch (e) {
        console.log(`✗ ${s.id} 抓取失败: ${e.message}`);
        continue;
      }
    }
    res = await upgradeIfEmpty(res, s.url, s.renderer !== "browser");
    const text = extractText(res.html).slice(0, 40000);
    if (text.length < (s.minText || MIN_TEXT)) {
      console.log(`✗ ${s.id} 正文过短（${text.length} 字符），跳过`);
      continue;
    }
    const existingTitles = (product.promos || []).map((x) => x.title);
    try {
      const { promos: found, removals } = await llmExtract({
        productName: product.name,
        url: s.url,
        pageText: text,
        existingTitles,
        todayISO,
      });
      const fresh = filterNewPromos(found, existingTitles, { max: 5 });
      const gone = pickRemovals(removals, product.promos, s.url, { max: 3 });
      if (gone.length) {
        const goneTitles = gone.map((g) => g.title);
        product.promos = product.promos.filter((x) => !gone.includes(x));
        added.push({
          time: nowISO(),
          source: s.id,
          product: s.product,
          url: s.url,
          kind: "auto-prune",
          how: "llm",
          pageTitle: `补录移除 ${gone.length} 条失效活动`,
          excerpt: goneTitles.join(" / ").slice(0, 160),
        });
        console.log(`🧹 ${s.id} 补录移除 ${gone.length} 条失效活动：${goneTitles.join(" / ")}`);
      }
      if (fresh.length) {
        product.promos = [...(product.promos || []), ...fresh];
        total += fresh.length;
        added.push({
          time: nowISO(),
          source: s.id,
          product: s.product,
          url: s.url,
          kind: "auto-promo",
          how: "llm",
          pageTitle: `补录收录 ${fresh.length} 条新活动`,
          excerpt: fresh.map((f) => f.title).join(" / ").slice(0, 160),
        });
        console.log(`🤖 ${s.id} 补录 ${fresh.length} 条：${fresh.map((f) => f.title).join(" / ")}`);
      } else {
        console.log(`✓ ${s.id} 无新增（提取 ${found.length} 条，均重复/过期/无效）`);
      }
    } catch (e) {
      console.log(`✗ ${s.id} 提取失败: ${e.message}`);
    }
    await sleep(800);
  }
  if (total) {
    meta.updatedAt = todayISO;
    fs.writeFileSync(path.join(DATA, "products.json"), JSON.stringify(meta, null, 2) + "\n");
    console.log(`\n🤖 补录完成：新增 ${total} 条，已写入 products.json`);
  }
  return total;
}

async function main() {
  const pruned = pruneExpired();
  if (pruned) {
    const meta = JSON.parse(fs.readFileSync(path.join(DATA, "products.json"), "utf8"));
    meta.products = PRODUCTS;
    meta.updatedAt = nowISO().slice(0, 10);
    fs.writeFileSync(path.join(DATA, "products.json"), JSON.stringify(meta, null, 2) + "\n");
    console.log(`🧹 已清理 ${pruned} 条过期活动（过期超过 ${PRUNE_DAYS} 天）`);
  }

  let added = [];
  let checked = 0;
  let failed = 0;
  let autoAdded = 0;   // 本轮 LLM 自动收录的条数
  let autoRemoved = 0; // 本轮自动移除的失效条数
  const degraded = []; // 疑似抓取降级的源
  const toExtract = []; // 本轮有变化的页面，供 LLM 自动收录

  if (BACKFILL_LIST) {
    // 补录模式：抓指定源并提取收录，不更新指纹状态，不走常规核对
    const total = await runBackfill(added, Number(process.env.MAX_AUTO_PER_RUN || 10));
    console.log(`\n完成：补录模式，新增 ${total} 条`);
  } else
  for (const s of SOURCES) {
    if (s.enabled === false) continue;
    if (ONLY_LIST && !ONLY_LIST.includes(s.id)) continue;

    const st = state[s.id];
    if (!BASELINE && st?.lastChecked) {
      const age = Date.now() - Date.parse(st.lastChecked);
      if (age < (s.everyHours || 24) * 3600e3) {
        console.log(`- ${s.id} 距上次核对不足 ${s.everyHours}h，跳过`);
        continue;
      }
    }

    let res = null;
    if (s.renderer === "browser") res = await renderBrowser(s.url);
    if (!res) {
      try {
        res = await fetchPlain(s.url);
      } catch (e) {
        failed++;
        // 故意不更新 lastChecked：失败如果也记时间，就会被 everyHours 节流挡住，
        // 一次网络抖动要等好几个小时才有下一次重试机会
        state[s.id] = { ...(st || {}), lastError: String(e.message || e).slice(0, 200) };
        console.log(`✗ ${s.id} 抓取失败: ${e.message}`);
        await sleep(1200);
        continue;
      }
    }
    // 空壳/被反爬拦截时依次换通道：browser → fetch → 渲染代理
    const minText = s.minText || MIN_TEXT; // 个别薄页面（如 trae-work-gift）正文天然很短，可在源上覆盖阈值
    res = await upgradeIfEmpty(res, s.url, s.renderer !== "browser", minText);
    checked++;

    const fullText = extractText(res.html);
    const text = fullText.slice(0, 40000);
    const hash = sha1(text);
    // 活动指纹用未截断的全文：正文超 4 万字时活动区可能落在截断线之外
    const dealHash = dealFingerprint(fullText);
    const prev = state[s.id];

    if (text.length < minText) {
      failed++;
      state[s.id] = {
        ...(prev || {}),
        lastError: `内容过短（${text.length} 字符，疑似空页/需登录），已跳过，未写基线`,
      };
      console.log(`✗ ${s.id} 内容过短（${text.length} 字符），跳过，不写基线`);
      await sleep(1200);
      continue;
    }

    if (BASELINE) {
      state[s.id] = { hash, chars: fullText.length, dealHash, stuck: 0, lastChecked: nowISO(), lastChanged: prev?.lastChanged || nowISO(), how: res.how };
      saveSnap(s.id, text);
      console.log(`• ${s.id} 基线已刷新 (${res.how}, ${fullText.length} 字符)`);
    } else if (!prev?.hash) {
      state[s.id] = { hash, chars: fullText.length, dealHash, stuck: 0, lastChecked: nowISO(), lastChanged: nowISO(), how: res.how };
      saveSnap(s.id, text);
      console.log(`• ${s.id} 首次记录基线 (${res.how}, ${fullText.length} 字符)`);
    } else if (prev.hash !== hash) {
      const excerpt = firstDiffRegion(loadSnap(s.id), text);
      // 同源的同一处差异只记一次：轮播图、访问计数器这类反复抖动的页面不再刷屏。
      // 无论记不记，都要更新基线与快照，否则下一轮还会拿同一处差异重复比对。
      const duplicate = changes.some((c) => c.source === s.id && c.excerpt === excerpt);
      const record = !duplicate && excerpt.length >= MIN_EXCERPT;
      // 关键解耦：要不要「记一条变更」和要不要「跑 LLM 收录」分开判断。
      // 只要活动指纹变了，哪怕整页差异因为重复/过短没被记下来，也照样提取。
      const dealChanged = Boolean(prev.dealHash) && prev.dealHash !== dealHash;
      if (record || dealChanged) {
        if (record) {
          added.push({
            time: nowISO(),
            source: s.id,
            product: s.product,
            url: s.url,
            kind: "page-update",
            how: res.how,
            pageTitle: pageTitle(res.html),
            excerpt,
          });
          console.log(`⚡ ${s.id} 页面有更新！${excerpt ? `片段: ${excerpt.slice(0, 80)}…` : ""}`);
        } else {
          console.log(`⚡ ${s.id} 活动区有更新（整页差异重复/过短，只触发收录不单独记变更）`);
        }
        toExtract.push({ id: s.id, product: s.product, url: s.url, text });
      } else {
        duplicate
          ? console.log(`·  ${s.id} 页面有更新，但差异与已记录的相同，跳过重复记录`)
          : console.log(`·  ${s.id} 页面有更新，但差异片段过短（${excerpt.length} 字符），跳过记录`);
      }
      state[s.id] = { hash, chars: fullText.length, dealHash, stuck: 0, lastChecked: nowISO(), lastChanged: nowISO(), how: res.how };
      saveSnap(s.id, text);
    } else {
      // 连续多少轮指纹一模一样？SPA 降级成 fetch 时就是这种「永远不变」的形态
      const stuck = (prev.stuck || 0) + 1;
      // 正文截断部分之外的尾部活动区仍可能有变（hash 只覆盖前 4 万字）
      const dealChanged = Boolean(prev.dealHash) && prev.dealHash !== dealHash;
      if (dealChanged) {
        toExtract.push({ id: s.id, product: s.product, url: s.url, text });
        console.log(`⚡ ${s.id} 活动区有更新（页面主体指纹未变）`);
      }
      state[s.id] = { ...prev, chars: fullText.length, dealHash, stuck, lastChecked: nowISO(), how: res.how, lastError: undefined };
      if (stuck === STUCK_ALERT && fullText.length <= DEGRADED_MAX_CHARS) {
        degraded.push({ id: s.id, product: s.product, chars: fullText.length, how: res.how });
        console.log(`⚠️  ${s.id} 连续 ${stuck} 轮无变化且正文仅 ${fullText.length} 字符，疑似抓取降级`);
      } else {
        console.log(`✓ ${s.id} 无变化${stuck > 1 ? `（连续 ${stuck} 轮）` : ""}`);
      }
    }

    // 对官方站点保持礼貌的请求间隔
    await sleep(1500 + Math.random() * 1500);
  }

  // ===== 全自动收录：页面有变化 → LLM 提取新活动 → 直接写进 products.json =====
  if (toExtract.length && !BASELINE) {
    if (!hasLLM()) {
      console.log("\n(未配置 GLM_API_KEY，跳过自动收录；配置后新活动会自动写入 products.json)");
    } else {
      console.log(`\n===== 自动收录：${toExtract.length} 个页面有变化，LLM 提取中 =====`);
      const meta = readProducts(DATA);
      const todayISO = nowISO().slice(0, 10);
      for (const t of toExtract) {
        if (autoAdded >= MAX_AUTO_PER_RUN) {
          console.log(`· 已达单轮自动收录上限 ${MAX_AUTO_PER_RUN} 条，剩余页面跳过`);
          break;
        }
        const product = meta.products.find((p) => p.slug === t.product);
        if (!product) continue;
        const existingTitles = (product.promos || []).map((x) => x.title);
        try {
          const { promos: found, removals } = await llmExtract({
            productName: product.name,
            url: t.url,
            pageText: t.text,
            existingTitles,
            todayISO,
          });
          const fresh = filterNewPromos(found, existingTitles, { max: 5 });
          // 页面明确标注「已结束」的已有活动 → 自动移除（数据层失效清理）
          const gone = pickRemovals(removals, product.promos, t.url, { max: 3 });
          if (gone.length) {
            const goneTitles = gone.map((g) => g.title);
            product.promos = product.promos.filter((x) => !gone.includes(x));
            autoRemoved += gone.length;
            changes.unshift({
              time: nowISO(),
              source: t.id,
              product: t.product,
              url: t.url,
              kind: "auto-prune",
              how: "llm",
              pageTitle: `自动移除 ${gone.length} 条失效活动`,
              excerpt: goneTitles.join(" / ").slice(0, 160),
            });
            console.log(`🧹 ${t.id} 自动移除 ${gone.length} 条失效活动：${goneTitles.join(" / ")}`);
          }
          if (fresh.length) {
            product.promos = [...(product.promos || []), ...fresh];
            autoAdded += fresh.length;
            changes.unshift({
              time: nowISO(),
              source: t.id,
              product: t.product,
              url: t.url,
              kind: "auto-promo",
              how: "llm",
              pageTitle: `自动收录 ${fresh.length} 条新活动`,
              excerpt: fresh.map((f) => f.title).join(" / ").slice(0, 160),
            });
            console.log(`🤖 ${t.id} 自动收录 ${fresh.length} 条：${fresh.map((f) => f.title).join(" / ")}`);
          } else {
            console.log(`✓ ${t.id} 未发现可收录的新活动（提取 ${found.length} 条，均重复/过期/无效）`);
          }
        } catch (e) {
          console.log(`✗ ${t.id} 自动提取失败: ${e.message}`);
        }
        await sleep(800);
      }
      if (autoAdded || autoRemoved) {
        meta.updatedAt = todayISO;
        fs.writeFileSync(path.join(DATA, "products.json"), JSON.stringify(meta, null, 2) + "\n");
        console.log(`\n🤖 本轮自动收录 ${autoAdded} 条、移除失效 ${autoRemoved} 条，products.json 已更新`);
      }
    }
  }

  // ===== 抓取健康告警 =====
  // 疑似降级的源单独成条并推送，避免「看起来每天在跑、其实早就瞎了」这种静默失效
  for (const d of degraded) {
    added.push({
      time: nowISO(),
      source: d.id,
      product: d.product,
      url: "",
      kind: "health",
      how: d.how,
      pageTitle: `抓取疑似降级：连续 ${STUCK_ALERT} 轮无变化`,
      excerpt: `正文仅 ${d.chars} 字符（疑似已降级为 fetch，拿不到渲染后的活动区）；请检查该源 renderer 或 CRAWL_PROXY_URL 代理配置`,
    });
  }

  // ===== 每轮健康报告：把云端黑盒变成可审计的数据 =====
  // 以前「GLM_API_KEY 到底配了没 / LLM 到底收录了几条」只能去翻 Actions 日志，
  // 本地完全看不到；现在每轮往 changes.json 写一条 crawl-report，打开数据即可核对。
  if (!BASELINE && !BACKFILL_LIST) {
    changes.unshift({
      time: nowISO(),
      source: "-",
      product: "-",
      url: "",
      kind: "crawl-report",
      how: "-",
      pageTitle: `核对 ${checked} 源 · 失败 ${failed} · LLM ${hasLLM() ? "已配置" : "未配置"}`,
      excerpt:
        `页面变更 ${added.filter((a) => a.kind === "page-update").length} 处 · ` +
        `触发提取 ${toExtract.length} 页 · 自动收录 ${autoAdded} 条 · 移除 ${autoRemoved} 条 · ` +
        `降级告警 ${degraded.length} 个（${degraded.map((d) => d.id).join(",") || "无"}）`,
    });
  }

  if (added.length) {
    changes.unshift(...added);
    changes.length = Math.min(changes.length, 300);
  }
  fs.writeFileSync(CHANGES_FILE, JSON.stringify(changes, null, 2) + "\n");
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

  console.log(`\n完成：核对 ${checked} 个源，失败 ${failed}，新增变更 ${added.length}，疑似降级 ${degraded.length}`);
  if (added.length && !BASELINE) await notify(added);
}

main().catch((e) => {
  console.error("爬虫异常退出:", e);
  process.exit(0); // 不让单次失败阻塞 Actions 的数据提交
});
