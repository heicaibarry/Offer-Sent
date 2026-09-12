import "./globals.css";

export const metadata = {
  title: "国内 Agent 优惠雷达 — Coding Plan / Token Plan 活动汇总",
  description:
    "国内主流 AI Agent（Trae、WorkBuddy、GLM Coding Plan、Kimi Code、MiniMax、百度搭子等）的订阅价格与优惠活动汇总，云端定时抓取官方页面，有新优惠即推送提醒。",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>
        <header className="topbar">
          <div className="container topbar-inner">
            <a className="logo" href="/">
              🛰️ Agent优惠雷达
            </a>
            <nav className="nav">
              <a href="/">对比</a>
              <a href="/timeline/">时间线</a>
              <a href="/rss.xml">RSS</a>
            </nav>
          </div>
        </header>
        <main className="container">{children}</main>
        <footer className="footer">
          <div className="container">
            <p>
              本站自动抓取各家官网公开页面并记录核对时间，价格与活动以官方页面为准。
              数据由 GitHub Actions 定时核对，发现变更即推送提醒。
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
