#!/usr/bin/env node
/**
 * test/fake-agent.mjs —— 假的 headless CLI agent：读 stdin 任务，延迟 1s，输出模拟结果。
 * 用途：不装真模型/真 CLI 也能验证 bridge-cli.js 的完整接入链路。
 * 例：echo "帮我看看构建为什么挂了" | node test/fake-agent.mjs
 */
'use strict';

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const task = input.trim();
  setTimeout(() => {
    process.stdout.write(
      `[fake-agent] 已收到任务（${new Date().toTimeString().slice(0, 8)}）：\n` +
      `  ${task.slice(0, 80)}${task.length > 80 ? '…' : ''}\n` +
      `模拟执行完成 ✅\n` +
      `· 扫描了 3 个文件，没有发现阻塞问题\n` +
      `· 建议：如需真实执行，把 --cmd 换成 claude -p / opencode run 等 headless CLI`,
    );
  }, 1000);
});
