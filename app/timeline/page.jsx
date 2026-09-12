import data from "../../data/products.json";
import changesData from "../../data/changes.json";

export const metadata = { title: "变更时间线 | 国内 Agent 优惠雷达" };

export default function TimelinePage() {
  const events = [];

  for (const p of data.products) {
    for (const promo of p.promos || []) {
      events.push({ date: promo.firstSeen || data.updatedAt, product: p.name, text: `收录活动：${promo.title}`, link: `/product/${p.slug}/` });
    }
  }
  for (const c of changesData || []) {
    events.push({ date: c.time, product: c.product, text: `官方页面变更（${c.pageTitle || c.source}），已进入人工核对`, link: c.url, external: true });
  }

  events.sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <>
      <section className="section">
        <h2 className="section-title">变更时间线</h2>
        <p className="section-sub">
          收录动作与爬虫发现的官方页面变更。爬虫每轮核对约 20 个官方页面，任何价格、套餐、活动文案的变化都会记录在这里。
        </p>
        {events.length === 0 ? (
          <div className="empty">暂无记录。</div>
        ) : (
          <div className="timeline">
            {events.map((e, i) => (
              <div className="tl-item" key={i}>
                <div className="tl-date">
                  {e.date} · {e.product}
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
