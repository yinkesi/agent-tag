@echo off
rem agent-tag CLI 入口（agent-runtime form）：不依赖 PATH 里的 node/cli 位置
rem 用法： at.cmd send -c general "你好"   |   at.cmd --name 阿明   |   at.cmd listen --json
node "%~dp0cli.js" %*
