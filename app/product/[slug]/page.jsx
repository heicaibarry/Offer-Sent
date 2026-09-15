import Link from "next/link";
import { notFound } from "next/navigation";
import PromoWindow from "../../../components/PromoWindow";
import data from "../../../data/products.json";
import {
  CATEGORY_LABEL,
  PRICE_STATUS,
  endLabel,
  fmtDate,
  money,
  splitPromos,
  unitSuffix,
} from "../../../lib/util";

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

  // 构建时刻作为过期判定参照（静态导出，详见 lib/util.js 的说明）
  const now = Date.now();
  const { active: activePromos, expired: endedPromos } = splitPromos(product.promos, now);

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
                {product.plans.map((plan) => {
                  const suffix = unitSuffix(plan.unit);
                  return (
                    <tr key={plan.name}>
                      <td style={{ fontWeight: 600 }}>{plan.name}</td>
                      <td className="nowrap">
                        {plan.price == null
                          ? "待核实"
                          : plan.price === 0
                            ? "免费"
                            : `${money(product, plan.price, plan)}${suffix ? ` ${suffix}` : ""}`}
                      </td>
                      <td className="nowrap">
                        {plan.intro != null ? (
                          <span className="intro">{money(product, plan.intro, plan)}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{plan.quota || "—"}</td>
                      <td style={{ color: "var(--muted)" }}>{plan.note || ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <h2>优惠活动{activePromos.length > 0 ? `（进行中 ${activePromos.length} 条）` : ""}</h2>
        {activePromos.length === 0 ? (
          <p style={{ color: "var(--muted)", margin: 0, fontSize: 14 }}>
            {endedPromos.length > 0
              ? `当前没有进行中的活动，历史活动已到期（下方留档 ${endedPromos.length} 条）。`
              : "暂无收录活动。爬虫发现官方页面变更后会自动更新并推送。"}
          </p>
        ) : (
          <ul className="promo-list">
            {activePromos.map((promo, i) => {
              const label = endLabel(promo, now);
              const urgent = label.includes("天后") || label.includes("明天") || label.includes("今天");
              return (
              <li key={i}>
                <div className="t">
                  {promo.title}{" "}
                  {promo.window ? (
                    <PromoWindow window={promo.window} />
                  ) : label ? (
                    <span className={`badge ${urgent ? "b-red" : "b-amber"}`}>{label}</span>
                  ) : (
                    <span className="badge b-green">未标截止</span>
                  )}
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
              );
            })}
          </ul>
        )}
      </div>

      {endedPromos.length > 0 ? (
        <div className="panel">
          <h2>已结束的活动（{endedPromos.length}）</h2>
          <p className="section-sub" style={{ margin: "0 0 6px" }}>
            已到截止时间自动下架，仅在本页留档；时间线里也能看到收录记录。
          </p>
          <ul className="promo-list">
            {endedPromos.map((promo, i) => (
              <li key={i} className="ended">
                <div className="t">
                  {promo.title} <span className="badge b-gray">已结束 {fmtDate(promo.endsAt)}</span>
                </div>
                {promo.detail ? <div className="d">{promo.detail}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
