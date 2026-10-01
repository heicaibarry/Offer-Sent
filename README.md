# 国内 Agent 优惠雷达

国内主流 AI Agent / Coding Plan / Token Plan 的价格与优惠活动汇总站。
云端定时核对官方定价页 → 内容变化自动推送微信提醒 → 数据提交后站点自动重新部署。

**本地电脑不需要开任何窗口，也不需要开机**：抓取、提醒、部署全部在 GitHub Actions 云端完成。

云端自动化包含五件事：

1. **一天三查**（北京时间 09:30 / 15:30 / 21:30）核对 25 个官方页面，内容变化推送微信提醒并提交数据；爬虫提交后主动触发部署（GITHUB_TOKEN 的 push 不会自动触发其他 workflow，必须显式 dispatch）
2. **全自动收录活动**：页面有变化时调 GLM API 从官方页正文提取新活动，标题去重、过期过滤后直接写入 `products.json` —— 无需人工补录。**「记录变更」与「触发收录」是解耦的**：即使整页差异因「与已记录相同」或「片段过短」被节流跳过，只要活动区指纹（`dealFingerprint`）变了就照样提取，不会漏掉活动更新。每周一的活动页扫描（`discover.mjs --auto`）还会验证高分新页面，确有活动就自动接入监控。需在仓库 Secrets 配置 `GLM_API_KEY`（open.bigmodel.cn 的 key，模型可用 `vars.LLM_MODEL` 覆盖，默认 glm-4.5-flash）；未配置时退化为只提醒不收录
3. **截止日期必填抽取**：提取活动时要求 LLM 给出 `endsAt`（活动区间取结束日、「截止 X 月 X 日」取该日、跨年补次年），LLM 没给就用本地正则 `guessEndsAt` 从原文兜底；仍拿不到的显式标 `endsUnknown`，前端显示「限时 · 未标日期」/「未标时间」，**不再把「页面没写日期」默认成「长期有效」**。到期活动前端实时隐藏（「另有 N 条已结束」），过期超过 `PRUNE_DAYS`（默认 2）天由爬虫从 `products.json` 物理删除（-1 关闭）
4. **抓取健康度自检**：每源记录正文 `chars` 与连续无变化轮数 `stuck`，连续 `STUCK_ALERT`（默认 6）轮不变且正文短于 `DEGRADED_MAX_CHARS`（默认 800 字）即判为「疑似降级」（SPA 退化成 fetch 只能拿到骨架）并推送告警；每轮另写一条 `crawl-report` 进 `changes.json`（核对数 / 失败数 / LLM 是否已配置 / 自动收录条数 / 降级源），**云端不再是黑盒，打开数据文件就能审计**
5. **每周一 12:00 自动扫活动页**：跑 `scripts/discover.mjs` 扫各官方站 sitemap，候选写入 `data/discovered.json`
6. **自动部署**：数据一变就重新构建发布 GitHub Pages

反爬说明：Trae 系页面对数据中心 IP 做地理/指纹拦截（GitHub Actions、Jina Reader 全被拦，仅国内住宅 IP 可访问）。云端已加浏览器反检测伪装 + 可选抓取代理（Secrets 配 `CRAWL_PROXY_URL` 指向任一国内 HTTP 代理即可抓通 Trae）。仓库里的 `trae-本地补抓.bat` 是备用的本机补抓工具（需自行注册计划任务），按需使用。

## 已覆盖产品（23 家 + 5 家仅收录）

- **编程类**：GLM Coding Plan（ZCode）、AutoClaw、Kimi Code、MiniMax Token Plan、Trae、CodeBuddy、Qoder CN（原名通义灵码，2026-05-20 更名，slug 保留旧名以免链接失效）、Qwen Code、文心快码、Fitten Code、CodeArts Snap、代码小浣熊、小米 MiMo Token Plan、阿里云百炼 Token Plan、方舟 Agent Plan（火山引擎）、讯飞星辰 Coding Plan
- **办公/通用类**：WorkBuddy、百度搭子 DuMate、扣子空间
- **API / Token**：DeepSeek、硅基流动、魔搭 ModelScope
- **仅收录（`scope: "watch"`，不计入统计、不参与监控）**：Manus、Skywork、Flowith、Lovart、Youware —— 均为海外计费，保留供参考
- **已归档**：iFlow CLI（2026-04-17 关停，保留作警示）

## 目录结构

```
data/products.json     产品/套餐/活动数据（价格状态: verified 已核实 / partial 部分 / pending 待核实；scope:"watch" = 仅收录不监控）
data/sources.json      监控源配置（URL、抓取方式、间隔）
data/changes.json      官方页面变更记录 + LLM 收录/移除记录 + 每轮 crawl-report 审计行
data/crawl-state.json  各源的 hash 指纹、正文 chars、活动区指纹 dealHash、连续无变化轮数 stuck
data/discovered.json   每周 sitemap 扫描出的疑似活动页候选（需人工确认，未自动接入监控）
scripts/crawl.mjs      抓取 + diff + 活动区指纹 + 健康自检 + 过期清理 + 推送
scripts/lib-extract.mjs LLM 活动提取（prompt 约束 / guessEndsAt 日期兜底 / 去重与失效判定）
scripts/discover.mjs   官方站 sitemap 活动页发现器（每周一自动跑，npm run discover 手动跑）
scripts/gen-rss.mjs    构建前生成 RSS（自动跳过已过期活动）
lib/util.js            渲染层口径：过期判定 / 时间完整度 / 折扣归一 / 力度评分
components/DealBoard.jsx   优惠卡片 + 价格对比表（按价格 / 按截止两种排序）
components/BudgetCalc.jsx  预算比价器（按标价筛选，不做单位换算排名）
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
   - `SERVERCHAN_SENDKEY`：[Server酱](https://sct.ftqq.com/) SendKey（微信扫码登录后首页可见，免费版每天 5 条），推到微信
   - `WECHAT_WEBHOOK` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`：其他可选推送渠道
   - `CRAWL_PROXY_URL`：国内 HTTP 代理（可选），配置后 Trae 等被地理拦截的源可在云端抓通
   - `SITE_URL`（Variables）：站点最终地址，用于 RSS 链接
4. 手动跑一次 **crawl** workflow 建立基线；之后每天北京时间 09:30 / 15:30 / 21:30 自动核对
5. 发现变更 → 企业微信收到提醒 → 数据自动提交 → 站点自动重新部署

## 数据维护流程

- **全自动（默认）**：配置 `GLM_API_KEY` 后，监控页有变化 → LLM 从官方页正文提取新活动（标题去重、过期过滤、每页限 5 条、单轮限 10 条）→ 自动写入 `products.json` 并上线。自动收录的条目带 `auto: "llm"` 标记，`changes.json` 里有 `auto-promo` / `auto-source` 记录可审计
- 自动提取难免有看走眼的时候：审阅 `data/changes.json` 的 `auto-promo` 记录，不对的直接改 `products.json` 删掉即可
- `priceStatus: pending` 的产品是定价页动态渲染、价格还没核实的，需要人工进官网核对一次后改为 `verified` 并填数字
- 每次人工核对后记得更新该产品的 `verifiedAt`

## 路线图

- [x] 预算比价器（`components/BudgetCalc.jsx`：输入月预算，列出预算内买得到的所有档位）
- [x] 按截止时间排序（表格新增「按截止」视角，把最快结束的活动顶上来）
- [x] 截止日期必填抽取 + 抓取健康度自检 + 每轮可审计报告
- [ ] 公众号监控（RSSHub / wewe-rss 订阅各家官方公众号，活动首发大多在公众号）
- [ ] admin 后台（手机上快速录入活动，替代改 JSON）
- [ ] 活动截止自动提醒（endsAt 前 48h 推送一次）
- [ ] 额度归一化比价（把积分 / Credits / 请求数折算成统一口径）—— ⛔ 前置条件是各家公开额度定义，否则折算只是「编造出来的精确」，宁可不做
