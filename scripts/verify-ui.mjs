/**
 * 优惠页 UI 验收：Edge headless + CDP
 *  - 检查渲染结果（卡片数、货币、过期提示、时间线是否露出内部 slug）
 *  - 检查 console 里有没有报错（含 React hydration mismatch）
 *  - 320 / 375 / 768 / 1440 各档宽度查横向溢出
 *  - 桌面 / 手机截图（落盘到 .verify-shots/）
 *
 * 用法（先起一个静态服务器，或直接打线上地址）：
 *   npx serve out -l 8099            # 或 python -m http.server 8099 -d out
 *   node scripts/verify-ui.mjs http://127.0.0.1:8099
 *   node scripts/verify-ui.mjs https://heicaibarry.github.io/Offer-Sent   # 自动走 127.0.0.1:7897 代理
 *
 * 依赖：本机 Edge（可用 EDGE_PATH 覆盖路径）；Node 18+（内置 fetch / WebSocket）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9333 + Math.floor(Math.random() * 200);
const BASE = process.argv[2] || "http://127.0.0.1:8099";
const SHOTS = path.join(process.cwd(), ".verify-shots");
fs.mkdirSync(SHOTS, { recursive: true });

const profile = path.join(process.cwd(), `.tmp-edge-${Date.now()}`);
const extra = BASE.includes("127.0.0.1") || BASE.includes("localhost") ? [] : ["--proxy-server=http://127.0.0.1:7897"];
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    ...extra,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "about:blank",
  ],
  { stdio: "ignore", detached: false }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJson(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(300);
  }
  throw new Error(`连不上 ${url}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } else {
        (this.handlers.get(msg.method) || []).forEach((f) => f(msg.params));
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(cb);
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

const results = [];
const errors = [];
const ok = (cond, label, extra = "") => {
  results.push({ ok: !!cond, label, extra });
  console.log(`${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};

function pollConsole(cdp, tag) {
  const push = (kind, text) => errors.push({ tag, kind, text: String(text).slice(0, 300) });
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error" || p.type === "warning")
      push(p.type, (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(" "));
  });
  cdp.on("Runtime.exceptionThrown", (p) => push("exception", p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  cdp.on("Log.entryAdded", (p) => {
    if (p.entry?.level === "error" || p.entry?.level === "warning") push(p.entry.level, p.entry.text);
  });
}

async function evaluate(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
  return r.result.value;
}

async function goto(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await new Promise((res) => {
    let done = false;
    cdp.on("Page.loadEventFired", () => { if (!done) { done = true; res(); } });
    setTimeout(() => { if (!done) { done = true; res(); } }, 15000);
  });
  await sleep(1200); // 等 hydrate 完成
}

async function shot(cdp, name, { width = 1440, height = 1000, full = false } = {}) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: width < 700,
  });
  await sleep(400);
  const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full });
  const file = path.join(SHOTS, name);
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`   📸 ${name}`);
  return file;
}

const ver = await waitJson(`http://127.0.0.1:${PORT}/json/version`);
console.log(`Edge: ${ver.Browser}\nBASE: ${BASE}\n`);

const browser = await CDP.connect(ver.webSocketDebuggerUrl);
const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
const page = await CDP.connect(`ws://127.0.0.1:${PORT}/devtools/page/${targetId}`);
await page.send("Runtime.enable");
await page.send("Page.enable");
await page.send("Log.enable");
pollConsole(page, "home");

/* ---------------- 首页 ---------------- */
await goto(page, `${BASE}/`);
await shot(page, "home-desktop.png", { width: 1440, height: 1200 });

const home = await evaluate(
  page,
  `(() => {
    const cards = [...document.querySelectorAll('.deal-card')];
    const sub = document.querySelector('.section-sub')?.innerText || '';
    const body = document.body.innerText;
    const stats = [...document.querySelectorAll('.hero .stat')].map(s => s.innerText.replace(/\\s+/g,' '));
    const tableRows = document.querySelectorAll('table tbody tr').length;
    const qoder = cards.find(c => c.querySelector('.name')?.innerText.includes('Qoder'));
    return {
      cards: cards.length,
      cardNames: cards.map(c => c.querySelector('.name')?.innerText),
      sub,
      tableRows,
      stats,
      hasDollar: /\\$\\s?\\d/.test(body),
      hasYuanUnit: /¥\\d+[^\\n]{0,3}元/.test(body),
      hasRawSlug: /tongyi-lingma|glm-coding-plan|kimi-code/.test(body),
      endedNotice: body.includes('已结束'),
      qoderCard: qoder ? qoder.innerText.replace(/\\s+/g,' ').slice(0, 260) : null,
      qoderDeadline: qoder ? [...qoder.querySelectorAll('.pl-meta .badge')].map(b => b.innerText) : [],
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`
);

console.log("\n首页数据:", JSON.stringify({ cards: home.cards, tableRows: home.tableRows, sub: home.sub }, null, 1));
console.log("卡片:", home.cardNames.join(" | "));
console.log("KPI:", home.stats.join(" / "));
console.log("Qoder 卡:", home.qoderCard);
ok(home.tableRows === 23, "对比表 23 家产品（海外 Qoder 已移除）", `实际 ${home.tableRows}`);
ok(home.cards === 10, "优惠卡 10 张（有进行中活动的产品数）", `实际 ${home.cards}`);
ok(!home.hasRawSlug, "页面没有露出内部 slug");
ok(!home.hasDollar, "页面没有美元符号（海外产品已摘除）");
ok(!home.hasYuanUnit, "没有「¥59 元/月」这种货币词重复");
ok(home.overflow <= 1, "1440 宽无横向溢出", `overflow=${home.overflow}`);
ok(home.qoderDeadline.some((t) => t.includes("截止")), "Qoder 9 月活动显示截止提示", home.qoderDeadline.join(" | "));
ok(!home.endedNotice, "当前没有已到期活动 → 不显示已结束提示");

/* ---------------- 产品详情：Qoder CN ---------------- */
await goto(page, `${BASE}/product/tongyi-lingma/`);
await shot(page, "product-qoder-cn.png", { width: 1440, height: 1400, full: true });
const detail = await evaluate(
  page,
  `(() => {
    const rows = [...document.querySelectorAll('table tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim()));
    const body = document.body.innerText;
    return {
      rows,
      active: body.match(/优惠活动[^\\n]*/)?.[0] || '',
      hasEndedPanel: body.includes('已结束的活动'),
      badges: [...document.querySelectorAll('.promo-list .badge')].map(b => b.innerText),
      hasDollarUnit: /¥\\d+ USD/.test(body),
    };
  })()`
);
console.log("\nQoder CN 套餐表:", JSON.stringify(detail.rows, null, 1));
ok(detail.rows.some((r) => /^¥59 \/月$/.test(r[1])), "标价渲染成「¥59 /月」（去除重复货币词）", detail.rows[1]?.join(" | "));
ok(detail.rows.some((r) => r[1].includes("¥559")), "旗舰版 ¥559 正常");
ok(!detail.hasDollarUnit, "没有「¥20 USD/月」这类错币种");
ok(!detail.hasEndedPanel, "没有已到期活动 → 不显示已结束面板");
ok(detail.active.includes("2"), "优惠活动区显示进行中条数", detail.active);
console.log("活动徽章:", detail.badges.join(" | "));

/* ---------------- 时间线 ---------------- */
await goto(page, `${BASE}/timeline/`);
await shot(page, "timeline.png", { width: 1440, height: 1600, full: true });
const tl = await evaluate(
  page,
  `(() => {
    const items = [...document.querySelectorAll('.tl-item')].map(i => i.innerText.replace(/\\s+/g,' '));
    return { count: items.length, items: items.slice(0, 6), body: document.body.innerText };
  })()`
);
console.log("\n时间线前 6 条:", JSON.stringify(tl.items, null, 1));
ok(!/tongyi-lingma|glm-coding-plan|kimi-code|dumate-home/.test(tl.body), "时间线全部显示产品名，无内部 slug");
ok(tl.count > 0, "时间线有条目", `${tl.count} 条`);

/* ---------------- 移动端溢出 ---------------- */
for (const w of [320, 375, 768]) {
  await page.send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: true });
  await sleep(500);
  const ov = await evaluate(
    page,
    `(() => {
      const de = document.documentElement;
      const bad = [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > de.clientWidth + 2).slice(0,4).map(el => el.className || el.tagName);
      return { ov: de.scrollWidth - de.clientWidth, bad };
    })()`
  );
  ok(ov.ov <= 2, `${w}px 宽无横向溢出`, `overflow=${ov.ov}${ov.bad.length ? " bad=" + JSON.stringify(ov.bad) : ""}`);
}
await goto(page, `${BASE}/`);
await shot(page, "home-mobile.png", { width: 375, height: 900, full: true });

/* ---------------- console ---------------- */
const bad = errors.filter((e) => !/favicon|404 \(Not Found\)/.test(e.text));
console.log("\nconsole 报错/警告:", bad.length ? JSON.stringify(bad, null, 1) : "无");
ok(bad.length === 0, "console 无报错（含 hydration mismatch）", bad.map((b) => b.text).join(" ; ").slice(0, 200));

page.close();
browser.close();
edge.kill();

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 项通过 =====`);
if (failed.length) {
  console.log("失败项:");
  failed.forEach((f) => console.log(" ❌", f.label, f.extra));
  process.exit(1);
}
console.log("截图目录:", SHOTS);
