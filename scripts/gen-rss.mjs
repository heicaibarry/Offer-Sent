/** 构建前生成 public/rss.xml，内容为各产品进行中的优惠活动。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = (process.env.SITE_URL || "https://example.github.io/agent-deals/").replace(/\/$/, "");

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "products.json"), "utf8"));
const changes = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "changes.json"), "utf8"));

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const items = [];
for (const p of data.products) {
  for (const promo of p.promos || []) {
    items.push({
      title: `${p.name}：${promo.title}`,
      link: `${SITE}/product/${p.slug}/`,
      desc: promo.detail || "",
      date: promo.firstSeen || data.updatedAt,
    });
  }
}
for (const c of (changes || []).slice(0, 30)) {
  items.push({
    title: `[页面变更] ${c.product}`,
    link: c.url,
    desc: c.excerpt || "官方页面内容有更新，待人工核对",
    date: c.time,
  });
}
items.sort((a, b) => (a.date < b.date ? 1 : -1));

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>国内 Agent 优惠雷达</title>
<link>${SITE}</link>
<description>国内主流 AI Agent / Coding Plan / Token Plan 优惠活动汇总</description>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items
  .map(
    (it) => `<item>
<title>${esc(it.title)}</title>
<link>${esc(it.link)}</link>
<description>${esc(it.desc)}</description>
<pubDate>${new Date(it.date).toUTCString()}</pubDate>
<guid>${esc(it.link + "#" + it.date)}</guid>
</item>`
  )
  .join("\n")}
</channel></rss>
`;

fs.mkdirSync(path.join(ROOT, "public"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "public", "rss.xml"), xml);
console.log(`rss.xml 已生成（${items.length} 条）`);
