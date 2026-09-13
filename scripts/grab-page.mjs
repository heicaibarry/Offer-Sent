/**
 * 用无头浏览器渲染页面并导出可读文本——用于人工/半自动核对 SPA 定价页。
 *
 * 用法：
 *   node scripts/grab-page.mjs <url> [输出文件名]
 *   输出：控制台打印疑似价格行，全文存到 data/grabs/<名字>.txt
 *
 * 需要：npm i -D playwright && npx playwright install chromium
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2];
const outName = (process.argv[3] || new URL(url).hostname.replace(/\./g, "_")) + ".txt";

if (!url) {
  console.error("用法: node scripts/grab-page.mjs <url> [输出文件名]");
  process.exit(1);
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

const { chromium } = await import("playwright");
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ userAgent: UA, viewport: { width: 1440, height: 900 } });
console.log("打开页面:", url);
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => console.log("goto 警告:", e.message));
await page.waitForTimeout(3000);
// 滚动到底再回顶，触发懒加载区块
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 600) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 150));
  }
  window.scrollTo(0, 0);
});
await page.waitForTimeout(1500);
const text = extractText(await page.content());
await browser.close();

const outDir = path.join(ROOT, "data", "grabs");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, outName);
fs.writeFileSync(outFile, text, "utf8");
console.log(`全文已存: ${outFile}（${text.length} 字符）\n`);

const priceLines = text.split("\n").filter((l) => /(¥|￥|\d+\s*元|\$\s*\d+|\d+\s*\/\s*月|积分|额度|畅用|免费|折扣|首月|限时)/.test(l));
console.log("== 疑似价格/优惠相关行 ==");
console.log([...new Set(priceLines)].slice(0, 60).join("\n") || "(未发现)");
