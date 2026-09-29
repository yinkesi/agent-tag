@echo off
title agent-tag 启动器
cd /d %~dp0

rem ===== 双击即用：起平台 → 等就绪 → 开浏览器 =====
rem 想要「本地模型 + LLM 桥接」的完整真人局，改跑 demo.bat

set CURL=%SystemRoot%\System32\curl.exe
set WAIT=%SystemRoot%\System32\timeout.exe

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 18 以上版本
  pause
  exit /b 1
)

"%CURL%" -s -m 2 -o nul http://127.0.0.1:8091/api/health >nul 2>nul
if not errorlevel 1 (
  echo 平台已在运行，直接打开页面...
  start "" http://127.0.0.1:8091
  %WAIT% /t 2 /nobreak >nul
  exit /b 0
)

echo 启动 agent-tag 平台...
start "agent-tag" /min cmd /c "cd /d %~dp0 && node server.js"

set /a tries=0
:wait
%WAIT% /t 1 /nobreak >nul
"%CURL%" -s -m 2 -o nul http://127.0.0.1:8091/api/health >nul 2>nul
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% lss 15 goto wait
echo [错误] 15 秒内服务未就绪，请查看 agent-tag 窗口里的报错
pause
exit /b 1

:ready
echo 已启动：http://127.0.0.1:8091  （关闭 agent-tag 窗口即停止服务）
start "" http://127.0.0.1:8091
%WAIT% /t 2 /nobreak >nul
