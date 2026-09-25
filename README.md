# 国内 Agent 优惠雷达

国内主流 AI Agent / Coding Plan / Token Plan 的价格与优惠活动汇总站。
云端定时核对官方定价页 → 内容变化自动推送微信提醒 → 数据提交后站点自动重新部署。

**本地电脑不需要开任何窗口，也不需要开机**：抓取、提醒、部署全部在 GitHub Actions 云端完成。

云端自动化包含四件事：

1. **一天三查**（北京时间 09:30 / 15:30 / 21:30）核对 26 个官方页面，内容变化推送微信提醒并提交数据；爬虫提交后主动触发部署（GITHUB_TOKEN 的 push 不会自动触发其他 workflow，必须显式 dispatch）
2. **过期自动清理**：到期活动前端实时隐藏（「另有 N 条已结束」），过期超过 30 天由爬虫从 `products.json` 物理删除（`PRUNE_DAYS` 可调，-1 关闭）
3. **每周一 12:00 自动扫活动页**：跑 `scripts/discover.mjs` 扫各官方站 sitemap，疑似活动页候选写入 `data/discovered.json`，人工确认后再补进监控源和数据
4. **自动部署**：数据一变就重新构建发布 GitHub Pages

## 已覆盖产品（24 家）

- **编程类**：GLM Coding Plan（ZCode）、Kimi Code、MiniMax Token Plan、Trae、CodeBuddy、Qoder、通义灵码、Qwen Code、文心快码、Fitten Code、CodeArts Snap、代码小浣熊
- **办公/通用类**：WorkBuddy、百度搭子 DuMate、扣子空间、Manus、Skywork、Flowith、Lovart、Youware
- **API / Token**：DeepSeek、硅基流动、魔搭 ModelScope
- **已归档**：iFlow CLI（2026-04-17 关停，保留作警示）

## 目录结构

```
data/products.json     产品/套餐/活动数据（价格状态: verified 已核实 / partial 部分 / pending 待核实）
data/sources.json      监控源配置（URL、抓取方式、间隔）
data/changes.json      爬虫发现的官方页面变更记录
data/crawl-state.json  各源的内容指纹与上次核对时间
data/discovered.json   每周 sitemap 扫描出的疑似活动页候选（需人工确认，未自动接入监控）
scripts/crawl.mjs      抓取 + diff + 过期清理 + 微信推送
scripts/discover.mjs   官方站 sitemap 活动页发现器（每周一自动跑，npm run discover 手动跑）
scripts/gen-rss.mjs    构建前生成 RSS
app/                   Next.js 静态站（首页对比表 / 产品详情 / 时间线）
.github/workflows/     crawl.yml 定时核对+每周发现 · deploy.yml 自动部署
```

## 本地开发

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # 静态导出到 out/
npm run crawl      # 手动跑一轮核对（首次运行自动记录基线，不推送）
```

SPA 定价页（Trae、WorkBuddy、MiniMax 等）需要无头浏览器才能读到渲染后的价格：

```bash
npm i -D playwright
npx playwright install chromium
```

未安装时自动降级为普通 HTTP 抓取（页面文案变化仍可感知，但看不到动态价格）。

## 上线（GitHub 全家桶，零成本）

1. 推到 GitHub 仓库，默认分支 `main`
2. 仓库 **Settings → Pages → Source 选 GitHub Actions**
3. （可选）**Settings → Secrets and variables → Actions** 添加：
   - `WECHAT_WEBHOOK`：企业微信群机器人 webhook（拉个只有自己的群即可获得）
   - `PUSHPLUS_TOKEN`：或用 [pushplus](https://www.pushplus.plus/) 推到微信
   - `SITE_URL`（Variables）：站点最终地址，用于 RSS 链接
4. 手动跑一次 **crawl** workflow 建立基线；之后每天北京时间 09:30 / 15:30 / 21:30 自动核对
5. 发现变更 → 企业微信收到提醒 → 数据自动提交 → 站点自动重新部署

## 数据维护流程

- 爬虫只能发现"官方页面变了"，具体哪条优惠新增/截止需要人工看一眼来源链接后在
  `data/products.json` 里补一条 `promos`（含 `firstSeen`、`source`），提交后自动上线
- `priceStatus: pending` 的产品是定价页动态渲染、价格还没核实的，需要人工进官网核对一次后改为 `verified` 并填数字
- 每次人工核对后记得更新该产品的 `verifiedAt`

## 路线图

- [ ] 公众号监控（RSSHub / wewe-rss 订阅各家官方公众号，活动首发大多在公众号）
- [ ] 比价计算器（按每月用量算哪家最便宜）
- [ ] admin 后台（手机上快速录入活动，替代改 JSON）
- [ ] 活动截止自动提醒（endsAt 前 48h 推送一次）
