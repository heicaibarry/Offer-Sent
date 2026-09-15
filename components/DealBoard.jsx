"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import PromoWindow from "./PromoWindow";
import {
  BUCKETS,
  CATEGORIES,
  CATEGORY_LABEL,
  PRICE_STATUS,
  entryPrice,
  fmtDate,
  freePlanCount,
  freeQuota,
  groupDeals,
  introPrice,
  minPlanPrice,
  promoValue,
} from "../lib/util";

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

  const promoCount = products.reduce((n, p) => n + (p.promos?.length || 0), 0);
  // 按产品聚合，再把产品分入三档（活动本身不折叠，逐条渲染）
  const buckets = useMemo(() => groupDeals(products), [products]);
  const cardCount = buckets.save.length + buckets.free.length + buckets.perk.length;

  // 表格按「免费档在前 → 价格升序」排列，便于横向比价
  const sorted = useMemo(() => {
    const rank = (p) => {
      const mp = minPlanPrice(p);
      if (mp === 0) return 0;
      if (mp != null) return 1;
      return 2;
    };
    return [...filtered].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return (minPlanPrice(a) ?? 0) - (minPlanPrice(b) ?? 0);
    });
  }, [filtered]);

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">进行中的优惠活动</h2>
          <p className="section-sub">
            {cardCount} 家 · 共 {promoCount} 条活动 · 每家的活动全部列出，由定时爬虫核对官网页面
          </p>
        </div>

        {cardCount === 0 ? (
          <div className="empty">暂无收录的活动，爬虫发现官方页面变更后会自动出现在这里。</div>
        ) : (
          ["save", "free", "perk"].map((key) =>
            buckets[key].length === 0 ? null : (
              <div className="bucket" key={key}>
                <div className="bucket-head">
                  <h3>
                    {BUCKETS[key].title}
                    <span className="count">{buckets[key].length} 家</span>
                  </h3>
                  <span>{BUCKETS[key].sub}</span>
                </div>
                <div className="deal-grid">
                  {buckets[key].map(({ product: p, promos, value, valueFrom }) => {
                    const ps = PRICE_STATUS[p.priceStatus] || PRICE_STATUS.pending;
                    const mp = minPlanPrice(p);
                    const nf = freePlanCount(p);
                    const intro = introPrice(p);
                    return (
                      <article className={`deal-card ${value ? `v-${value.kind}` : ""}`} key={p.slug}>
                        <div className="dc-head">
                          <div className="dc-title">
                            <span className="name">{p.name}</span>
                            <span className="vendor">
                              {p.vendor} · {CATEGORY_LABEL[p.category] || p.category}
                            </span>
                          </div>
                          <span className={`badge ${ps.cls}`} title={ps.title}>
                            {ps.label}
                          </span>
                        </div>

                        {/* 卡头大字 = 这张卡里最省的那条活动 */}
                        {value ? (
                          <>
                            <div className={`dc-big ${value.kind}`}>{value.text}</div>
                            {valueFrom ? <div className="dc-cap">{valueFrom}</div> : null}
                          </>
                        ) : null}

                        <div className="dc-base">
                          {nf > 0 ? <span className="free">有免费档</span> : null}
                          {mp != null && mp > 0 ? <span>最低 ¥{mp}/月</span> : null}
                          {intro != null && mp > 0 ? <span>首月 ¥{intro}</span> : null}
                          {mp == null ? <span>价格待核实</span> : null}
                        </div>

                        <div className="dc-plabel">
                          活动 {promos.length} 条 · 全部列出
                        </div>

                        {/* 每条活动独立成行，完整可见：不折叠、不截断、不加展开按钮 */}
                        <ul className="promo-list">
                          {promos.map((promo, i) => {
                            const v = promoValue(promo);
                            const redundant = v && promo.title?.includes(v.text);
                            return (
                              <li className="pl" key={`${p.slug}-${i}`}>
                                <div className="pl-head">
                                  {v && !redundant ? (
                                    <span className={`pl-badge ${v.kind}`}>{v.text}</span>
                                  ) : (
                                    <span className="pl-badge ghost">·</span>
                                  )}
                                  <span className="pl-t">{promo.title}</span>
                                </div>
                                {promo.detail ? <div className="pl-d">{promo.detail}</div> : null}
                                <div className="pl-meta">
                                  {promo.window ? (
                                    <PromoWindow window={promo.window} />
                                  ) : promo.endsAt ? (
                                    <span>截止 {fmtDate(promo.endsAt)}</span>
                                  ) : null}
                                  <span>收录 {fmtDate(promo.firstSeen)}</span>
                                  {promo.source ? (
                                    <a href={promo.source} target="_blank" rel="noreferrer">
                                      来源 ↗
                                    </a>
                                  ) : null}
                                </div>
                              </li>
                            );
                          })}
                        </ul>

                        <Link className="dc-more" href={`/product/${p.slug}/`}>
                          详情 →
                        </Link>
                      </article>
                    );
                  })}
                </div>
              </div>
            )
          )
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">全部产品价格对比</h2>
          <p className="section-sub">只比对价格与免费额度；活动详情见上方卡片，此处不重复</p>
        </div>
        <div className="toolbar">
          <div className="tabs">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                className={`tab ${cat === c.key ? "active" : ""}`}
                onClick={() => setCat(c.key)}
              >
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
                <th>最低月价</th>
                <th>首月价</th>
                <th>免费额度 / 套餐</th>
                <th>活动</th>
                <th>数据状态</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => {
                const ps = PRICE_STATUS[p.priceStatus] || PRICE_STATUS.pending;
                const closed = p.status === "closed";
                const mp = minPlanPrice(p);
                const intro = introPrice(p);
                return (
                  <tr key={p.slug} className={closed ? "dim" : ""}>
                    <td className="cell-prod">
                      <div className="name">
                        <Link href={`/product/${p.slug}/`}>{p.name}</Link>{" "}
                        {closed ? (
                          <span className="badge b-red">已关停</span>
                        ) : (
                          <span className="badge b-gray">
                            {CATEGORY_LABEL[p.category] || p.category}
                          </span>
                        )}
                        {p.market === "intl" ? <span className="badge b-amber">海外计费</span> : null}
                      </div>
                      <div className="sub">
                        {p.vendor} · {p.type}
                      </div>
                    </td>
                    {/* 最低月价 / 首月价 各自单行不换行，方便竖着比 */}
                    <td className="nowrap">
                      {mp == null ? (
                        <span className="dash">待核实</span>
                      ) : mp === 0 ? (
                        <span className="free-txt">免费档</span>
                      ) : (
                        <>
                          <b className="num">¥{mp}</b>
                          <span className="unit">/月起</span>
                        </>
                      )}
                    </td>
                    <td className="nowrap">
                      {intro != null ? <span className="intro">¥{intro}</span> : <span className="dash">—</span>}
                    </td>
                    <td className="cell-quota">{freeQuota(p)}</td>
                    <td className="nowrap">
                      {(p.promos || []).length > 0 ? (
                        <span className="badge b-red">{p.promos.length} 条</span>
                      ) : (
                        <span className="dash">—</span>
                      )}
                    </td>
                    <td className="nowrap">
                      <span className={`badge ${ps.cls}`} title={ps.title}>
                        {ps.label}
                      </span>
                      {p.verifiedAt ? (
                        <div className="sub">核对 {fmtDate(p.verifiedAt)}</div>
                      ) : null}
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
