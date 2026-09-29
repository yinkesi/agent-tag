@echo off
rem ============================================
rem  agent-tag 完整演示一键启动（LLM 真人局）
rem  平台 + 本地 MiniCPM5 + LLM bridge，@答疑助手 ~1.3s 回帖
rem ============================================
setlocal
set LLMDIR=D:\code\projects\01-ai-research\minicpm5-local

rem ① 本地模型服务（已在跑则跳过）
curl -s -m 2 -o nul http://127.0.0.1:8080/health
if errorlevel 1 (
  echo [1/3] 启动 MiniCPM5 本地模型服务...
  start "MiniCPM5-2B" /min cmd /c "cd /d %LLMDIR%\bin && llama-server.exe -m ..\models\MiniCPM5-2B-Q8_0.gguf -a MiniCPM5-2B --port 8080 -ngl 99 -c 8192 --jinja --temp 1.0 --top-p 0.95 --min-p 0.0"
  timeout /t 6 /nobreak >nul
) else (
  echo [1/3] 模型服务已在运行
)

rem ② agent-tag 平台
echo [2/3] 启动 agent-tag 平台 http://127.0.0.1:8091 ...
start "agent-tag" /min cmd /c "cd /d %~dp0 && node server.js"

rem ③ LLM bridge（群成员「答疑助手」）
timeout /t 2 /nobreak >nul
echo [3/3] 启动 LLM bridge（答疑助手）...
start "bridge" /min cmd /c "cd /d %~dp0 && node bridge-agent.js --name 答疑助手 --base-url http://127.0.0.1:8080/v1 --model MiniCPM5-2B --persona \"群里的工程答疑助手，简短直接\""

timeout /t 3 /nobreak >nul
start "" chrome http://127.0.0.1:8091 2>nul || start "" http://127.0.0.1:8091
echo 完成！浏览器已打开。在「产品研发群」里 @答疑助手 问问题，约 1.3 秒回帖。
endlocal
