import data from "../../data/products.json";
import changesData from "../../data/changes.json";
import { fmtDateTime, isPromoExpired } from "../../lib/util";

export const metadata = { title: "变更时间线 | 国内 Agent 优惠雷达" };

export default function TimelinePage() {
  // changes.json 里存的是产品 slug（爬虫按 sources.json 的 product 字段写入），
  // 展示时统一映射成产品名，别把 tongyi-lingma 这种内部标识甩给访客
  const nameOf = new Map(data.products.map((p) => [p.slug, p.name]));
  const now = Date.now();
  const events = [];

  for (const p of data.products) {
    for (const promo of p.promos || []) {
      const expired = isPromoExpired(promo, now);
      events.push({
        date: promo.firstSeen || data.updatedAt,
        product: p.name,
        text: `${expired ? "活动已结束" : "收录活动"}：${promo.title}`,
        link: `/product/${p.slug}/`,
        expired,
      });
    }
  }
  for (const c of changesData || []) {
    // 产品已被从数据集里移除的旧变更记录直接跳过，否则时间线上会露出内部 slug
    if (!nameOf.has(c.product)) continue;
    events.push({
      date: c.time,
      product: nameOf.get(c.product),
      text: `官方页面变更（${c.pageTitle || c.source}），已进入人工核对`,
      link: c.url,
      external: true,
    });
  }

  events.sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <>
      <section className="section">
        <h2 className="section-title">变更时间线</h2>
        <p className="section-sub">
          收录动作与爬虫发现的官方页面变更。爬虫每轮核对约 20 个官方页面，任何价格、套餐、活动文案的变化都会记录在这里。
          时间为 UTC。
        </p>
        {events.length === 0 ? (
          <div className="empty">暂无记录。</div>
        ) : (
          <div className="timeline">
            {events.map((e, i) => (
              <div className={`tl-item ${e.expired ? "dim" : ""}`} key={i}>
                <div className="tl-date">
                  {fmtDateTime(e.date)} · {e.product}
                </div>
                <div className="tl-title">
                  {e.external ? (
                    <a href={e.link} target="_blank" rel="noreferrer">
                      {e.text} ↗
                    </a>
                  ) : (
                    <a href={e.link}>{e.text}</a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
