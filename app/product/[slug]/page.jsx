import Link from "next/link";
import { notFound } from "next/navigation";
import data from "../../../data/products.json";
import { CATEGORY_LABEL, PRICE_STATUS, fmtDate } from "../../../lib/util";

export function generateStaticParams() {
  return data.products.map((p) => ({ slug: p.slug }));
}

export function generateMetadata({ params }) {
  const p = data.products.find((x) => x.slug === params.slug);
  return { title: p ? `${p.name} — 价格与优惠 | 国内 Agent 优惠雷达` : "产品详情" };
}

export default function ProductPage({ params }) {
  const product = data.products.find((x) => x.slug === params.slug);
  if (!product) notFound();

  const ps = PRICE_STATUS[product.priceStatus] || PRICE_STATUS.pending;
  const closed = product.status === "closed";

  return (
    <>
      <div className="detail-head">
        <Link className="back" href="/">
          ← 返回对比表
        </Link>
        <h1>
          {product.name}
          {closed ? <span className="badge b-red">已关停</span> : <span className="badge b-green">运营中</span>}
          <span className={`badge ${ps.cls}`}>{ps.label}</span>
          {product.market === "intl" ? <span className="badge b-amber">海外计费（美元）</span> : null}
        </h1>
        <p className="summary">{product.summary}</p>
        <div className="chips">
          <span className="chip">{product.vendor}</span>
          <span className="chip">{CATEGORY_LABEL[product.category] || product.category}</span>
          <span className="chip">{product.type}</span>
          {(product.models || []).map((m) => (
            <span className="chip" key={m}>
              {m}
            </span>
          ))}
        </div>
      </div>

      {product.plans?.length > 0 && (
        <div className="panel">
          <h2>套餐与价格</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>档位</th>
                  <th>标价</th>
                  <th>首月/优惠价</th>
                  <th>额度</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {product.plans.map((plan) => (
                  <tr key={plan.name}>
                    <td style={{ fontWeight: 600 }}>{plan.name}</td>
                    <td>{plan.price == null ? "待核实" : plan.price === 0 ? "免费" : `¥${plan.price} ${plan.unit || ""}`}</td>
                    <td>{plan.intro != null ? `¥${plan.intro}` : "—"}</td>
                    <td>{plan.quota || "—"}</td>
                    <td style={{ color: "var(--muted)" }}>{plan.note || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <h2>优惠活动</h2>
        {(product.promos || []).length === 0 ? (
          <p style={{ color: "var(--muted)", margin: 0, fontSize: 14 }}>
            暂无收录活动。爬虫发现官方页面变更后会自动更新并推送。
          </p>
        ) : (
          <ul className="promo-list">
            {product.promos.map((promo, i) => (
              <li key={i}>
                <div className="t">
                  {promo.title}{" "}
                  <span className={`badge ${promo.endsAt ? "b-amber" : "b-green"}`}>
                    {promo.endsAt ? `截止 ${fmtDate(promo.endsAt)}` : "未标截止"}
                  </span>
                </div>
                {promo.detail ? <div className="d">{promo.detail}</div> : null}
                <div className="d" style={{ marginTop: 4 }}>
                  收录于 {promo.firstSeen || "—"}
                  {promo.source ? (
                    <>
                      {" · "}
                      <a href={promo.source} target="_blank" rel="noreferrer">
                        官方来源 ↗
                      </a>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel">
        <h2>信息与备注</h2>
        {product.notes ? <p style={{ marginTop: 0, fontSize: 14 }}>{product.notes}</p> : null}
        <div className="kv">
          <span className="k">官网</span>
          <a href={product.site} target="_blank" rel="noreferrer">
            {product.site}
          </a>
        </div>
        {product.pricingUrl && product.pricingUrl !== product.site && (
          <div className="kv">
            <span className="k">定价页</span>
            <a href={product.pricingUrl} target="_blank" rel="noreferrer">
              {product.pricingUrl}
            </a>
          </div>
        )}
        <div className="kv">
          <span className="k">最后核对</span>
          <span>{product.verifiedAt || "—"}</span>
        </div>
      </div>
    </>
  );
}
