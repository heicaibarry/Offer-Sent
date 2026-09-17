/**
 * 官方站「活动页」自动发现器。
 *
 * 背景：活动信息大多不在 /pricing 上，而是散落在产品子站、文档活动页、开发者社区里
 * （例：/events/code-fission、/trae-work-gift、support.huaweicloud.com/offers-xxx）。
 * 手工逐个找太慢，所以定期扫一次官方站的 sitemap，把「路径像活动页」的 URL 捞出来，
 * 再做一次轻量抓取验证是不是真有内容，最后按分数排序供人工确认。
 *
 * 流程：
 *   1. 从 sources.json 收集所有启用源的域名（去重，每个域只扫一次）
 *   2. robots.txt → Sitemap: → 展开子 sitemap（最多 2 层，每层最多 3 个）
 *   3. 剥掉 query string 后用路径正则筛候选（关键：华为云 sitemap 里大量
 *      ?utm_campaign=活动 的广告链接，不剥 query 会全军覆没）
 *   4. 对候选做一次 fetch 探测，按「正文长度 + 优惠词命中」打分
 *   5. 结果写入 data/discovered.json（已 gitignore），控制台打印 top 列表
 *
 * 用法：
 *   node scripts/discover.mjs                  # 扫全部域名
 *   node scripts/discover.mjs --domain <url>   # 额外扫指定域（可重复）
 *   node scripts/discover.mjs --top 30         # 控制台显示前 30 条
 *   node scripts/discover.mjs --no-probe       # 只做 URL 发现，不抓取验证（快）
 *
 * 注意：这只是「候选生成器」，不会自动写进 sources.json —— 需要人工确认后才入库，
 * 避免把过期活动页、空壳页接进监控。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const OUT_FILE = path.join(DATA, "discovered.json");

const SOURCES = JSON.parse(fs.readFileSync(path.join(DATA, "sources.json"), "utf8")).sources;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const TIMEOUT = 12000;
const MAX_URLS_PER_DOMAIN = 3000;
const MAX_SUB_SITEMAPS = 3;
const MAX_PROBE_PER_DOMAIN = 12;
const MIN_TEXT = 200;

const argv = process.argv.slice(2);
const argVal = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : null;
};
const TOP = Number(argVal("--top") || 20);
const NO_PROBE = argv.includes("--no-probe");
const EXTRA = argv.reduce((acc, a, i) => (argv[i - 1] === "--domain" ? [...acc, a] : acc), []);

// 已监控的 URL（用于标记 known，避免重复建议）
const knownUrls = new Set(SOURCES.map((s) => normUrl(s.url)));

function normUrl(u) {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/$/, "").toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
}

function originOf(u) {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

async function get(url, asXml) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: asXml ? "application/xml,text/xml,*/*" : "text/html,*/*",
      },
      signal: ctl.signal,
      redirect: "follow",
    });
    if (!r.ok) return { status: r.status, body: "" };
    const len = Number(r.headers.get("content-length") || 0);
    if (len > 8_000_000) return { status: r.status, body: "", tooBig: true };
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { status: 0, body: "", err: e.name === "AbortError" ? "超时" : e.message };
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 路径活动词。命中即 +2 分。
const PATH_RE =
  /(^|\/)(promo|promotion|activity|activities|event|events|offer|offers|campaign|coupon|free|trial|gift|benefit|benefits|discount|sale|reward|rewards|invite|huodong|youhui|tehui|lijian|lingqu|限时|活动|优惠|免费|福利)(\/|$|-|_|\d)/i;
// 正文优惠词。每个 +1 分，上限 3。
const BODY_RE = /限时|免费|赠送|领取|活动|优惠|tokens?|积分|折扣|立减|白嫖|先到先得|截止|加赠/gi;

function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** 收集一个域下 sitemap 里的所有 URL */
async function collectUrls(origin) {
  const found = [];
  const meta = { sitemap: null, urlCount: 0, note: "" };

  const rb = await get(origin + "/robots.txt", false);
  let smList = [];
  if (rb.status === 200) {
    smList = [...rb.body.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  }
  if (!smList.length) smList = [origin + "/sitemap.xml", origin + "/sitemap_index.xml"];

  for (const sm of smList.slice(0, 3)) {
    const r = await get(sm, true);
    if (r.status !== 200 || !r.body) continue;
    meta.sitemap = sm;
    let locs = [...r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);

    if (/<sitemapindex/i.test(r.body)) {
      const subs = locs.slice(0, MAX_SUB_SITEMAPS);
      locs = [];
      for (const s of subs) {
        const sub = await get(s, true);
        if (sub.status === 200) {
          locs.push(...[...sub.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]));
        }
        await sleep(200);
        if (locs.length > MAX_URLS_PER_DOMAIN) break;
      }
    }
    found.push(...locs.slice(0, MAX_URLS_PER_DOMAIN));
    if (found.length) break;
  }
  meta.urlCount = found.length;
  if (!found.length) meta.note = rb.status === 200 ? "有 robots 但 sitemap 为空/不可读" : "无 robots.txt";
  return { urls: found, meta };
}

// ---------- 主流程 ----------
const domainMap = new Map();
for (const s of SOURCES) {
  if (s.enabled === false) continue;
  const o = originOf(s.url);
  if (!o) continue;
  if (!domainMap.has(o)) domainMap.set(o, new Set());
  domainMap.get(o).add(s.product);
}
for (const u of EXTRA) {
  const o = originOf(u);
  if (o && !domainMap.has(o)) domainMap.set(o, new Set(["(手动指定)"]));
}

console.log(`扫描 ${domainMap.size} 个官方域名…（--no-probe 已${NO_PROBE ? "启用，跳过抓取验证" : "关闭"}）\n`);

const candidates = [];
let totalUrls = 0;

for (const [origin, products] of domainMap) {
  const { urls, meta } = await collectUrls(origin);
  totalUrls += urls.length;

  const hits = [];
  for (const raw of urls) {
    let u = raw;
    try {
      u = decodeURIComponent(raw);
    } catch {}
    // 剥 query：华为云等站点的 sitemap 里大量 ?utm_campaign=活动 的广告链接
    const noQuery = u.split("?")[0];
    const m = noQuery.match(PATH_RE);
    if (!m) continue;
    // 只保留同域的
    if (originOf(noQuery) !== origin) continue;
    hits.push({ url: noQuery, hit: m[2] });
  }
  // 去重
  const uniq = [];
  const seen = new Set();
  for (const h of hits) {
    const k = normUrl(h.url);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(h);
  }

  const first = [...products][0];
  console.log(
    `${origin.padEnd(34)} sitemap URL ${String(meta.urlCount).padStart(4)} → 疑似活动页 ${uniq.length}${
      meta.note ? "  (" + meta.note + ")" : ""
    }`
  );

  if (NO_PROBE) {
    for (const h of uniq) {
      candidates.push({
        product: first,
        url: h.url,
        pathHit: h.hit.toLowerCase(),
        known: knownUrls.has(normUrl(h.url)),
        score: 2,
        probe: null,
      });
    }
    continue;
  }

  // 抓取验证（限量，避免给官方站造成压力）
  for (const h of uniq.slice(0, MAX_PROBE_PER_DOMAIN)) {
    const r = await get(h.url, false);
    let score = 2;
    const rec = { product: first, url: h.url, pathHit: h.hit.toLowerCase(), status: r.status, chars: 0, keywords: [], spa: false };
    if (r.status === 200 && r.body) {
      const txt = extractText(r.body);
      rec.chars = txt.length;
      if (txt.length >= MIN_TEXT) {
        score += 1;
        const kw = [...new Set((txt.match(BODY_RE) || []).map((x) => x.toLowerCase()))];
        rec.keywords = kw.slice(0, 6);
        score += Math.min(kw.length, 3);
      } else {
        rec.spa = true; // 正文过短：多半是 SPA 空壳，需要 browser 渲染
      }
    } else if (r.status === 0) {
      rec.err = r.err;
    }
    rec.score = score;
    rec.known = knownUrls.has(normUrl(h.url));
    candidates.push(rec);
    await sleep(400);
  }
  await sleep(300);
}

candidates.sort((a, b) => b.score - a.score || b.chars - a.chars);

const out = {
  generatedAt: new Date().toISOString(),
  domains: domainMap.size,
  scannedUrls: totalUrls,
  probeEnabled: !NO_PROBE,
  note: "候选清单，需人工确认后再写进 sources.json。known=true 表示已在监控中。spa=true 表示 fetch 拿不到正文，需 browser 渲染。",
  candidates,
};
fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + "\n");

console.log(`\n共 ${candidates.length} 个候选，已写入 data/discovered.json`);
console.log(`\n=== Top ${Math.min(TOP, candidates.length)}（分数 = 路径命中2 + 正文达标1 + 优惠词最多3）===`);
for (const c of candidates.slice(0, TOP)) {
  const flags = [c.known ? "已在监控" : "新", c.spa ? "需渲染" : "", c.keywords?.length ? c.keywords.join("/") : ""]
    .filter(Boolean)
    .join(" · ");
  console.log(`  ${String(c.score).padStart(2)}分  [${c.product}] ${c.url}`);
  if (flags) console.log(`        ${flags}`);
}
