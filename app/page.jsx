import data from "../data/products.json";
import DealBoard from "../components/DealBoard";
import BudgetCalc from "../components/BudgetCalc";
import { freePlanCount, splitPromos } from "../lib/util";

export default function Home() {
  const products = data.products;
  // 「仅收录」= 海外计费、不监控价格与活动的条目。它们不参与任何统计口径，
  // 只在下方表格里展示——否则「覆盖 24 家」里有 5 家既没价格也没活动，是虚高。
  const covered = products.filter((p) => p.scope !== "watch");
  const watchOnly = products.filter((p) => p.scope === "watch");

  // 构建时刻（静态导出的 HTML 生成时间）：作为渲染层过期判定的参照，
  // 由这里取一次、当 prop 递下去，保证预渲染内容与客户端首次渲染一致。
  const now = Date.now();

  const active = covered.filter((p) => p.status === "active").length;
  let promoCount = 0;
  let endedCount = 0;
  let promoProducts = 0;
  for (const p of covered) {
    const { active: live, expired } = splitPromos(p.promos, now);
    promoCount += live.length;
    endedCount += expired.length;
    if (live.length > 0) promoProducts += 1;
  }
  // 之前这里把 partial 也统计成「已核实」，导致 9 家被显示成 15 家
  const verified = covered.filter((p) => p.priceStatus === "verified").length;
  const withFree = covered.filter((p) => freePlanCount(p) > 0).length;

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
            覆盖 <b>{covered.length}</b> 家产品
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
        {watchOnly.length ? (
          <p style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
            另有 <b>{watchOnly.length}</b> 家海外计费产品（
            {watchOnly.map((p) => p.name).join("、")}）仅收录展示，不计入以上统计、不参与价格与活动监控。
          </p>
        ) : null}
      </section>

      <DealBoard products={products} nowMs={now} />

      <BudgetCalc products={products} />
    </>
  );
}
