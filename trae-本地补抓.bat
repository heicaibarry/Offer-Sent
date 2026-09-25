@echo off
rem ============================================================
rem  Trae local re-crawl: Trae WAF blocks datacenter IPs (GitHub
rem  Actions / Jina all blocked), but the home broadband IP works.
rem  A Windows scheduled task runs this every 6 hours while the PC
rem  is on. It only crawls the 5 Trae sources and pushes any data
rem  changes back (PAT push triggers the Pages deploy).
rem  Keep this file ASCII-only: cmd.exe parses bat in the OEM codepage.
rem ============================================================
cd /d "E:\AI编程\综合类\agent-deals"

echo [%date% %time%] ===== Trae local crawl start ===== >> data\trae-local.log

node scripts/crawl.mjs --only trae-pricing,trae-events-fission,trae-work-offer,trae-student,trae-work-gift >> data\trae-local.log 2>&1

git add data/ >> data\trae-local.log 2>&1
git diff --cached --quiet
if errorlevel 1 goto commit
echo [%date% %time%] no changes, nothing to commit >> data\trae-local.log
goto done

:commit
git commit -m "chore(data): Trae local crawl" >> data\trae-local.log 2>&1
git -c http.proxy=http://127.0.0.1:7897 pull --rebase origin main >> data\trae-local.log 2>&1
git -c http.proxy=http://127.0.0.1:7897 push origin main >> data\trae-local.log 2>&1
if errorlevel 1 (
    echo [%date% %time%] push FAILED (network/proxy), commit kept locally, will retry next run >> data\trae-local.log
) else (
    echo [%date% %time%] committed and pushed >> data\trae-local.log
)

:done
echo [%date% %time%] ===== done ===== >> data\trae-local.log
