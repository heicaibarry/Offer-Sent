/**
 * 过期判定验收：证明「构建之后才到期的活动也会自动下架」。
 *
 * 做法：用 Page.addScriptToEvaluateOnNewDocument 在页面脚本之前打桩，
 * 把浏览器里的「当前时间」整体往后推 20 天（2026-09-15 → 2026-10-05），
 * 并把 setInterval 的间隔压到 300ms 以便观察 —— 不需要重新构建，
 * 就能验证起作用的是客户端那次实时复核，而不是构建期的静态过滤。
 *
 * 预期：
 *   - 静态 HTML 里的 Qoder CN「9 月首月 Credits 翻倍（9/30 截止）」在 hydrate 首帧仍在
 *     （与预渲染一致 → 不能有 hydration mismatch）；
 *   - useEffect 跑完后换成"真实时间"，这条活动立刻消失，
 *     卡片出现「另有 1 条已结束」，区块标题变成「20 条活动进行中（另有 1 条已结束，已自动下架）」。
 *
 * 用法：node scripts/verify-expiry.mjs [baseUrl]（同上，默认 http://127.0.0.1:8099）
 * ⚠️ 该脚本的断言绑定了具体数据（Qoder CN 的 9/30 活动），换数据后要同步改断言。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9500 + Math.floor(Math.random() * 200);
const BASE = process.argv[2] || "http://127.0.0.1:8099";
const SHOTS = path.join(process.cwd(), ".verify-shots");
fs.mkdirSync(SHOTS, { recursive: true });

const profile = path.join(process.cwd(), `.tmp-edge2-${Date.now()}`);
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
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: "ignore" }
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
  throw new Error("连不上 CDP");
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
      } else (this.handlers.get(msg.method) || []).forEach((f) => f(msg.params));
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
async function evaluate(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
  return r.result.value;
}

const results = [];
const ok = (cond, label, extra = "") => {
  results.push({ ok: !!cond, label });
  console.log(`${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
};
const errors = [];

const ver = await waitJson(`http://127.0.0.1:${PORT}/json/version`);
const browser = await CDP.connect(ver.webSocketDebuggerUrl);
const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
const page = await CDP.connect(`ws://127.0.0.1:${PORT}/devtools/page/${targetId}`);
await page.send("Runtime.enable");
await page.send("Page.enable");
await page.send("Log.enable");
page.on("Runtime.consoleAPICalled", (p) => {
  if (p.type === "error" || p.type === "warning")
    errors.push((p.args || []).map((a) => a.value ?? a.description).join(" ").slice(0, 300));
});
page.on("Runtime.exceptionThrown", (p) => errors.push((p.exceptionDetails?.exception?.description || "").slice(0, 300)));

// 关键：在页面任何脚本之前把时间推后 20 天，并加速 setInterval
await page.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    const OFFSET = 20 * 864e5;
    const RealDate = Date;
    const base = RealDate.now();
    const Patched = function (...a) { return a.length ? new RealDate(...a) : new RealDate(base + OFFSET); };
    Patched.now = () => base + OFFSET;
    Patched.parse = RealDate.parse;
    Patched.UTC = RealDate.UTC;
    Patched.prototype = RealDate.prototype;
    window.Date = Patched;
    const realSetInterval = window.setInterval;
    window.setInterval = (fn, ms, ...rest) => realSetInterval(fn, Math.min(ms, 300), ...rest);
    window.__clockShifted = Patched.now();
  })();`,
});

await page.send("Page.navigate", { url: `${BASE}/` });
await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
await sleep(2500);

const out = await evaluate(
  page,
  `(() => {
    const sub = document.querySelector('.section-sub')?.innerText || '';
    const cards = [...document.querySelectorAll('.deal-card')];
    const qoder = cards.find(c => c.querySelector('.name')?.innerText.includes('Qoder'));
    const plabel = qoder ? qoder.querySelector('.dc-plabel')?.innerText.replace(/\\s+/g,' ') : '';
    const rows = qoder ? [...qoder.querySelectorAll('.pl-t')].map(t => t.innerText) : [];
    const wb = cards.find(c => (c.querySelector('.name')?.innerText || '').trim() === 'WorkBuddy');
    const wbRows = wb ? [...wb.querySelectorAll('.pl-t')].map(t => t.innerText) : [];
    const wbLabel = wb ? wb.querySelector('.dc-plabel')?.innerText.replace(/\\s+/g,' ') : '';
    const wbBadges = wb ? [...wb.querySelectorAll('.pl-meta .badge')].map(b => b.innerText) : [];
    const heroNote = document.querySelector('.hero-note')?.innerText || '';
    return {
      shiftedNow: new Date(window.__clockShifted).toISOString(),
      shiftedNowLocal: new Date(window.__clockShifted).toString(),
      sub, plabel, rows,
      cards: cards.length,
      cardNames: cards.map(c => c.querySelector('.name')?.innerText),
      wbRows, wbLabel, wbBadges,
      heroNote,
    };
  })()`
);

console.log("打桩后的浏览器时间:", out.shiftedNow, "|", out.shiftedNowLocal);
console.log("区块说明:", out.sub);
console.log("Qoder 卡:", out.plabel, "|", JSON.stringify(out.rows));
console.log("卡片数:", out.cards, "|", out.cardNames.join(" / "));
console.log("WorkBuddy 卡:", out.wbLabel, "\n  剩余活动:", JSON.stringify(out.wbRows), "\n  截止标记:", JSON.stringify(out.wbBadges));
console.log("hero 提示:", out.heroNote || "(无)");

const shot = await page.send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(SHOTS, "expiry-after-shift.png"), Buffer.from(shot.data, "base64"));

ok(!out.sub.includes("34 条活动进行中"), "已过期活动不再计入「活动进行中」总数", out.sub);
ok(out.sub.includes("27 条活动进行中"), "总数从 34 降到 27（7 条到期）", out.sub);
ok(out.sub.includes("另有 7 条已结束"), "区块说明出现「另有 7 条已结束，已自动下架」", out.sub);
ok(!out.rows.some((t) => t.includes("9 月首月 Credits 翻倍")), "Qoder CN 的 9/30 活动行已从卡片消失", JSON.stringify(out.rows));
ok(out.rows.length === 1, "Qoder CN 卡上只剩 1 条进行中活动", `${out.rows.length} 条`);
ok(out.plabel.includes("另有 1 条已结束"), "Qoder CN 卡标注「另有 1 条已结束」", out.plabel);
ok(out.cards === 12, "到期活动所属产品仍有其他活动 → 卡片保留（不是整卡消失）", `${out.cards} 张`);
ok(!out.cardNames.some((n) => n?.includes("AutoClaw")) === false, "无 endsAt 的 AutoClaw 常驻活动不受时间推移影响", out.cardNames.join(" / "));

// WorkBuddy：9/23 的 DeepSeek、9/30 的 Hy3 与邀请到期；10/10 的 Hy4 额度仍在
ok(!out.wbRows.some((t) => t.includes("0.03x")), "WorkBuddy 的 9/23 DeepSeek 折扣行已消失", JSON.stringify(out.wbRows));
ok(!out.wbRows.some((t) => t.includes("Hy3")), "WorkBuddy 的 9/30 Hy3 限免行已消失");
ok(!out.wbRows.some((t) => t.includes("邀请好友")), "WorkBuddy 的 9/30 邀请活动行已消失");
ok(out.wbRows.some((t) => t.includes("Hy4")), "WorkBuddy 的 10/10 Hy4 免费额度仍在", JSON.stringify(out.wbRows));
ok(out.wbRows.length === 4, "WorkBuddy 卡上剩 4 条进行中活动", `${out.wbRows.length} 条`);
ok(out.wbLabel.includes("另有 3 条已结束"), "WorkBuddy 卡标注「另有 3 条已结束」", out.wbLabel);
// 打桩后是 10/05，距 10/10 剩 5–6 天 → endLabel 会显示相对天数而非绝对日期
ok(out.wbBadges.some((t) => /天后截止|明天截止/.test(t)), "10/10 的 Hy4 显示倒计时（7 天内用相对天数）", out.wbBadges.join(" | "));

ok(out.heroNote === "", "hero 上不再放构建期的到期数字（避免与客户端实时结果打架）", out.heroNote || "(无)");
const bad = errors.filter((e) => !/favicon|404/.test(e));
ok(bad.length === 0, "推送时间后无 console 报错（说明首帧没发生 hydration mismatch）", bad.join(" ; ").slice(0, 300));

page.close();
browser.close();
edge.kill();

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 项通过 =====`);
if (failed.length) {
  failed.forEach((f) => console.log(" ❌", f.label));
  process.exit(1);
}
