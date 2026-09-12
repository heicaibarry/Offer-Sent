import data from "../data/products.json";
import DealBoard from "../components/DealBoard";

export default function Home() {
  const products = data.products;
  const active = products.filter((p) => p.status === "active").length;
  const promoCount = products.reduce((n, p) => n + (p.promos?.length || 0), 0);
  const verified = products.filter((p) => p.priceStatus === "verified" || p.priceStatus === "partial").length;

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
            进行中活动 <b>{promoCount}</b> 条
          </span>
          <span className="stat">
            价格已核实 <b>{verified}</b> 家
          </span>
          <span className="stat">
            数据更新 <b>{data.updatedAt}</b>
          </span>
        </div>
      </section>

      <DealBoard products={products} />
    </>
  );
}
