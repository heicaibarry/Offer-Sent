@echo off
chcp 65001 >nul
rem ============================================================
rem  Trae 本地补抓：Trae 的 WAF 拦数据中心 IP（GitHub Actions 全被拦），
rem  但本机家庭宽带 IP 可以正常访问。电脑开着时由计划任务定时跑这个脚本，
rem  只抓 Trae 的 5 个源，有变化就提交推回仓库（会自动触发站点部署）。
rem  电脑关机时本任务自动跳过，云端爬虫照常负责其他源，互不影响。
rem ============================================================
cd /d "E:\AI编程\综合类\agent-deals"

echo [%date% %time%] ===== Trae 本地补抓开始 ===== >> data\trae-local.log

node scripts/crawl.mjs --only trae-pricing,trae-events-fission,trae-work-offer,trae-student,trae-work-gift >> data\trae-local.log 2>&1

git add data/ >> data\trae-local.log 2>&1
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "chore(data): Trae 本地补抓" >> data\trae-local.log 2>&1
    git -c http.proxy=http://127.0.0.1:7897 pull --rebase origin main >> data\trae-local.log 2>&1
    git -c http.proxy=http://127.0.0.1:7897 push origin main >> data\trae-local.log 2>&1
    if errorlevel 1 (
        echo [%date% %time%] 推送失败（网络/代理问题），提交保留在本地，下次补抓时一起推 >> data\trae-local.log
    ) else (
        echo [%date% %time%] 已提交并推送 >> data\trae-local.log
    )
) else (
    echo [%date% %time%] 无变化，不需要提交 >> data\trae-local.log
)
echo [%date% %time%] ===== 完成 ===== >> data\trae-local.log
