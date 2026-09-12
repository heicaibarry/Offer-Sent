/**
 * 定时抓取各官方定价页 → 内容指纹 diff → 变更则记录并推送提醒。
 *
 * 用法：
 *   node scripts/crawl.mjs              # 正常运行（受 everyHours 间隔控制）
 *   node scripts/crawl.mjs --baseline   # 只刷新基线指纹，不记录变更、不推送
 *   node scripts/crawl.mjs --only trae-pricing   # 只跑指定源
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
const ONLY = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage({ userAgent: UA, viewport: { width: 1366, height: 900 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const html = await page.content();
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
  });
  return { html: await res.text(), how: "fetch" };
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
  if (!webhook && !token) console.log("(未配置推送渠道，跳过提醒；可设置 WECHAT_WEBHOOK / PUSHPLUS_TOKEN)");
}

async function main() {
  let added = [];
  let checked = 0;
  let failed = 0;

  for (const s of SOURCES) {
    if (s.enabled === false) continue;
    if (ONLY && s.id !== ONLY) continue;

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
        state[s.id] = { ...(st || {}), lastChecked: nowISO(), lastError: String(e.message || e).slice(0, 200) };
        console.log(`✗ ${s.id} 抓取失败: ${e.message}`);
        await sleep(1200);
        continue;
      }
    }
    checked++;

    const text = extractText(res.html).slice(0, 40000);
    const hash = sha1(text);
    const prev = state[s.id];

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
      state[s.id] = { hash, lastChecked: nowISO(), lastChanged: nowISO(), how: res.how };
      saveSnap(s.id, text);
      console.log(`⚡ ${s.id} 页面有更新！${excerpt ? `片段: ${excerpt.slice(0, 80)}…` : ""}`);
    } else {
      state[s.id] = { ...prev, lastChecked: nowISO(), how: res.how, lastError: undefined };
      console.log(`✓ ${s.id} 无变化`);
    }

    // 对官方站点保持礼貌的请求间隔
    await sleep(1500 + Math.random() * 1500);
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
