import data from "../data/products.json";
import DealBoard from "../components/DealBoard";
import { freePlanCount, splitPromos } from "../lib/util";

export default function Home() {
  const products = data.products;
  // 构建时刻（静态导出的 HTML 生成时间）：作为渲染层过期判定的参照，
  // 由这里取一次、当 prop 递下去，保证预渲染内容与客户端首次渲染一致。
  const now = Date.now();

  const active = products.filter((p) => p.status === "active").length;
  let promoCount = 0;
  let endedCount = 0;
  let promoProducts = 0;
  for (const p of products) {
    const { active: live, expired } = splitPromos(p.promos, now);
    promoCount += live.length;
    endedCount += expired.length;
    if (live.length > 0) promoProducts += 1;
  }
  // 之前这里把 partial 也统计成「已核实」，导致 9 家被显示成 15 家
  const verified = products.filter((p) => p.priceStatus === "verified").length;
  const withFree = products.filter((p) => freePlanCount(p) > 0).length;

  return (
    <>
      <section className="hero">
        <h1>国内 Agent 优惠雷达</h1>
        <p>
          主流 AI Agent、Coding Plan、Token Plan 的价格与优惠活动一网打尽。
          云端定时核对官方页面，有新优惠自动推送，不用再蹲公众号。
        </p>
        <div className="stats">
          <span className="stat">
            覆盖 <b>{products.length}</b> 家产品
          </span>
          <span className="stat">
            运营中 <b>{active}</b> 家
          </span>
          <span className="stat">
            优惠进行中 <b>{promoProducts}</b> 家 / <b>{promoCount}</b> 条
          </span>
          <span className="stat">
            有免费档 <b>{withFree}</b> 家
          </span>
          <span className="stat">
            价格已核实 <b>{verified}</b> 家
          </span>
          <span className="stat">
            数据更新 <b>{data.updatedAt}</b>
          </span>
        </div>
      </section>

      <DealBoard products={products} nowMs={now} />
    </>
  );
}
