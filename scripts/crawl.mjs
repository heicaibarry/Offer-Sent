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
import { hasLLM, llmExtract, filterNewPromos, readProducts } from "./lib-extract.mjs";

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

const productName = (id) => PRODUCTS.find((p) => p.slug === id)?.name || id;
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
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
  const lines = list
    .slice(0, 10)
    .map(
      (c) =>
        `**${productName(c.product)}** 官网页面有更新\n${c.pageTitle ? `> ${c.pageTitle}\n` : ""}${c.url}`
    );
  const content =
    `🔔 Agent优惠雷达：发现 ${list.length} 处官方页面更新\n\n` +
    lines.join("\n\n") +
    `\n\n请打开网站核对具体优惠变化。`;

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

// 过期活动数据清理：endsAt 已过期超过 PRUNE_DAYS 天的条目从 products.json 里删除。
// 前端本来就会按 endsAt 实时隐藏到期活动，这里做的是数据层面的最终回收。
// PRUNE_DAYS 可用环境变量覆盖（设为 -1 关闭清理）；无法解析的截止时间一律保留。
const PRUNE_DAYS = Number(process.env.PRUNE_DAYS ?? 30);

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
  const toExtract = []; // 本轮有变化的页面，供 LLM 自动收录

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

    const text = extractText(res.html).slice(0, 40000);
    const hash = sha1(text);
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
      state[s.id] = { hash, lastChecked: nowISO(), lastChanged: prev?.lastChanged || nowISO(), how: res.how };
      saveSnap(s.id, text);
      console.log(`• ${s.id} 基线已刷新 (${res.how})`);
    } else if (!prev?.hash) {
      state[s.id] = { hash, lastChecked: nowISO(), lastChanged: nowISO(), how: res.how };
      saveSnap(s.id, text);
      console.log(`• ${s.id} 首次记录基线 (${res.how})`);
    } else if (prev.hash !== hash) {
      const excerpt = firstDiffRegion(loadSnap(s.id), text);
      // 同源的同一处差异只记一次：轮播图、访问计数器这类反复抖动的页面不再刷屏。
      // 无论记不记，都要更新基线与快照，否则下一轮还会拿同一处差异重复比对。
      const duplicate = changes.some((c) => c.source === s.id && c.excerpt === excerpt);
      if (!duplicate && excerpt.length >= MIN_EXCERPT) {
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
        toExtract.push({ id: s.id, product: s.product, url: s.url, text });
        console.log(`⚡ ${s.id} 页面有更新！${excerpt ? `片段: ${excerpt.slice(0, 80)}…` : ""}`);
      } else {
        duplicate
          ? console.log(`·  ${s.id} 页面有更新，但差异与已记录的相同，跳过重复记录`)
          : console.log(`·  ${s.id} 页面有更新，但差异片段过短（${excerpt.length} 字符），跳过记录`);
      }
      state[s.id] = { hash, lastChecked: nowISO(), lastChanged: nowISO(), how: res.how };
      saveSnap(s.id, text);
    } else {
      state[s.id] = { ...prev, lastChecked: nowISO(), how: res.how, lastError: undefined };
      console.log(`✓ ${s.id} 无变化`);
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
      let autoAdded = 0;
      for (const t of toExtract) {
        if (autoAdded >= MAX_AUTO_PER_RUN) {
          console.log(`· 已达单轮自动收录上限 ${MAX_AUTO_PER_RUN} 条，剩余页面跳过`);
          break;
        }
        const product = meta.products.find((p) => p.slug === t.product);
        if (!product) continue;
        const existingTitles = (product.promos || []).map((x) => x.title);
        try {
          const found = await llmExtract({
            productName: product.name,
            url: t.url,
            pageText: t.text,
            existingTitles,
            todayISO,
          });
          const fresh = filterNewPromos(found, existingTitles, { max: 5 });
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
      if (autoAdded) {
        meta.updatedAt = todayISO;
        fs.writeFileSync(path.join(DATA, "products.json"), JSON.stringify(meta, null, 2) + "\n");
        console.log(`\n🤖 本轮自动收录 ${autoAdded} 条新活动，已写入 products.json`);
      }
    }
  }

  if (added.length) {
    changes.unshift(...added);
    changes.length = Math.min(changes.length, 300);
  }
  fs.writeFileSync(CHANGES_FILE, JSON.stringify(changes, null, 2) + "\n");
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

  console.log(`\n完成：核对 ${checked} 个源，失败 ${failed}，新增变更 ${added.length}`);
  if (added.length && !BASELINE) await notify(added);
}

main().catch((e) => {
  console.error("爬虫异常退出:", e);
  process.exit(0); // 不让单次失败阻塞 Actions 的数据提交
});
