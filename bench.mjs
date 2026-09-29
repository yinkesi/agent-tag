#!/usr/bin/env node
/**
 * bench.mjs —— 端到端延迟基准
 * 指标：POST /api/messages → 长轮询客户端收到该消息事件的耗时（agent 收 @ 的关键路径）。
 * 用法：node bench.mjs [baseUrl] [轮数]
 */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8091';
const ROUNDS = Number(process.argv[3] || 30);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

(async () => {
  const suffix = Math.random().toString(36).slice(2, 6);
  const sender = await api('POST', '/api/register', { name: `基准发送${suffix}`, kind: 'human', context: 'channel' });
  const receiver = await api('POST', '/api/register', { name: `基准接收${suffix}`, kind: 'agent', context: 'channel' });
  const stoken = sender.token, rtoken = receiver.token;
  await sleep(300);

  // 监听者常驻长轮询循环（模拟 bridge-agent / cli listen）
  let cursor = 0;
  let waiter = null;
  let inbox = [];
  (async () => {
    for (;;) {
      const j = await api('GET', `/api/events?token=${rtoken}&since=${cursor}&wait=25`);
      cursor = j.cursor ?? cursor;
      if (j.events?.length) { inbox.push(...j.events); waiter?.(); }
    }
  })();
  await sleep(300);

  const samples = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    await api('POST', '/api/messages', { channel: 'general', text: `@基准接收${suffix} 延迟样本 ${i}` }, stoken);
    // 等收到含本条文本的事件
    for (;;) {
      const idx = inbox.findIndex((e) => e.type === 'message' && e.message.text === `@基准接收${suffix} 延迟样本 ${i}`);
      if (idx !== -1) { inbox.splice(0, idx + 1); break; }
      await new Promise((r) => { waiter = r; setTimeout(() => { waiter = null; r(); }, 5000); });
    }
    samples.push(performance.now() - t0);
    await sleep(30); // 避免完全背靠背
  }

  samples.sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  console.log(`端到端延迟（POST → 长轮询收到，n=${ROUNDS}）`);
  console.log(`  avg  ${(avg).toFixed(1)}ms`);
  console.log(`  p50  ${p50.toFixed(1)}ms`);
  console.log(`  p95  ${p95.toFixed(1)}ms`);
  console.log(`  max  ${samples[samples.length - 1].toFixed(1)}ms`);
  process.exit(0);
})();
