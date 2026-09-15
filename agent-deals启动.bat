@echo off
chcp 936 >NUL
title Agent优惠雷达
cd /d "%~dp0"

REM 默认打开已上线的线上站点（零依赖，云端数据最新）
REM 如需本地预览：agent-deals启动.bat local
set "SITE=https://heicaibarry.github.io/Offer-Sent/"

if /i "%~1"=="local" goto :LOCAL

echo 正在打开线上站点: %SITE%
start "" "%SITE%"
echo.
echo 如线上站点未更新，可用  agent-deals启动.bat local  启动本地预览。
exit /b 0

:LOCAL
where node >NUL 2>&1
if %errorlevel% NEQ 0 goto :NONODE

netstat -ano | findstr ":57910" | findstr /i "LISTENING" >NUL 2>&1
if %errorlevel%==0 goto :OPENLOCAL

echo 正在启动本地开发服务 (端口 57910)...
start "agent-deals" /min cmd /k "npm run dev -- -p 57910"
echo 等待服务就绪...
set /a WAIT=0

:WAITLOOP
netstat -ano | findstr ":57910" | findstr /i "LISTENING" >NUL 2>&1
if %errorlevel%==0 goto :OPENLOCAL
ping -n 2 127.0.0.1 >NUL
set /a WAIT+=1
if %WAIT% LSS 15 goto :WAITLOOP
echo [警告] 服务在约 30 秒内未就绪，仍尝试打开...

:OPENLOCAL
start "" "http://127.0.0.1:57910"
echo 本地预览: http://127.0.0.1:57910
exit /b 0

:NONODE
echo [错误] 未找到 node，无法启动本地预览。
echo 请直接访问线上站点: %SITE%
start "" "%SITE%"
exit /b 1
