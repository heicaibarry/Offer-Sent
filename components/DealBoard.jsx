"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CATEGORIES, CATEGORY_LABEL, PRICE_STATUS, entryPrice, freeQuota, fmtDate } from "../lib/util";

export default function DealBoard({ products }) {
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return products.filter((p) => {
      if (cat !== "all" && p.category !== cat) return false;
      if (!kw) return true;
      return [p.name, p.vendor, p.summary, p.type].join(" ").toLowerCase().includes(kw);
    });
  }, [products, cat, q]);

  const promoProducts = products.filter((p) => (p.promos || []).length > 0);
  const promoCount = promoProducts.reduce((n, p) => n + p.promos.length, 0);

  return (
    <>
      <section className="section">
        <h2 className="section-title">进行中的优惠活动</h2>
        <p className="section-sub">共 {promoCount} 条 · 由定时爬虫核对官网页面，发现变更即更新并推送</p>
        {promoProducts.length === 0 ? (
          <div className="empty">暂无收录的活动，爬虫发现官方页面变更后会自动出现在这里。</div>
        ) : (
          <div className="deal-grid">
            {promoProducts.flatMap((p) =>
              p.promos.map((promo, i) => (
                <article className="deal-card" key={`${p.slug}-${i}`}>
                  <div className="head">
                    <span className="badge b-blue">{CATEGORY_LABEL[p.category] || p.category}</span>
                    <span className="prod">{p.name}</span>
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>{p.vendor}</span>
                  </div>
                  <p className="promo-title">{promo.title}</p>
                  {promo.detail ? <p className="promo-detail">{promo.detail}</p> : null}
                  <div className="meta">
                    <span>{promo.endsAt ? `截止 ${fmtDate(promo.endsAt)}` : "未标截止时间"}</span>
                    <span>收录 {fmtDate(promo.firstSeen)}</span>
                    {promo.source ? (
                      <a href={promo.source} target="_blank" rel="noreferrer">
                        查看来源 ↗
                      </a>
                    ) : null}
                    <Link href={`/product/${p.slug}/`}>详情 →</Link>
                  </div>
                </article>
              ))
            )}
          </div>
        )}
      </section>

      <section className="section">
        <h2 className="section-title">全部产品对比</h2>
        <div className="toolbar">
          <div className="tabs">
            {CATEGORIES.map((c) => (
              <button key={c.key} className={`tab ${cat === c.key ? "active" : ""}`} onClick={() => setCat(c.key)}>
                {c.label}
              </button>
            ))}
          </div>
          <input
            className="search"
            placeholder="搜索产品 / 厂商…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>产品</th>
                <th>入门价</th>
                <th>免费额度 / 套餐</th>
                <th>进行中活动</th>
                <th>数据状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const ep = entryPrice(p);
                const ps = PRICE_STATUS[p.priceStatus] || PRICE_STATUS.pending;
                const closed = p.status === "closed";
                return (
                  <tr key={p.slug} className={closed ? "dim" : ""}>
                    <td className="cell-prod">
                      <div className="name">
                        {p.name}{" "}
                        {closed ? (
                          <span className="badge b-red">已关停</span>
                        ) : (
                          <span className="badge b-gray">{CATEGORY_LABEL[p.category] || p.category}</span>
                        )}
                        {p.market === "intl" ? <span className="badge b-amber">海外计费</span> : null}
                      </div>
                      <div className="sub">
                        {p.vendor} · {p.type}
                      </div>
                    </td>
                    <td>
                      <div className="price-now">{ep.text}</div>
                      {ep.promo ? <div className="price-promo">{ep.promo}</div> : null}
                    </td>
                    <td>{freeQuota(p)}</td>
                    <td>
                      {(p.promos || []).length > 0 ? (
                        <>
                          <span className="badge b-green">{p.promos.length} 条</span>
                          <div className="sub" style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                            {p.promos[0].title}
                          </div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <span className={`badge ${ps.cls}`} title={ps.title}>
                        {ps.label}
                      </span>
                      {p.verifiedAt ? (
                        <div className="sub" style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                          核对 {fmtDate(p.verifiedAt)}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <Link href={`/product/${p.slug}/`}>详情 →</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="section-sub" style={{ marginTop: 10 }}>
          「待核实」表示官方定价页为动态渲染（价格藏在 JS 里），爬虫会在下一轮核对中抓取；“部分核实”表示官网确认了档位结构，个别数字待补。
        </p>
      </section>
    </>
  );
}
