#!/usr/bin/env node
/**
 * e2e-bench.mjs —— 群聊完整链路测速：@ LLM agent → 它回帖落群（含 bridge 去抖 + LLM 推理）
 * 用法：node e2e-bench.mjs [轮数]
 */
'use strict';
const BASE = 'http://127.0.0.1:8091';
const N = Number(process.argv[2] || 3);
const AGENT = '答疑助手';
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
  const me = await api('POST', '/api/register', { name: `测速员${Math.random().toString(36).slice(2, 5)}`, kind: 'human' });
  const token = me.token;
  // 常驻长轮询收事件
  let cursor = 0, wake = null, events = [];
  (async () => { for (;;) { const j = await api('GET', `/api/events?token=${token}&since=${cursor}&wait=25`); cursor = j.cursor ?? cursor; if (j.events?.length) { events.push(...j.events); wake?.(); } } })();
  await sleep(500);

  const questions = ['一句话解释什么是RAG', '用一句话说说什么是微调', '一句话说明量化是什么', '一句话介绍KV缓存'];
  const xs = [];
  for (let i = 0; i < N; i++) {
    const q = questions[i % questions.length];
    events = [];
    const t0 = performance.now();
    await api('POST', '/api/messages', { channel: 'general', text: `@${AGENT} ${q}` }, token);
    // 等 agent 的回帖事件
    const reply = await (async () => {
      for (;;) {
        const hit = events.find((e) => e.type === 'message' && e.message.from === AGENT && e.message.ts > t0);
        if (hit) return hit.message;
        await new Promise((r) => { wake = r; setTimeout(() => { wake = null; r(); }, 30000); });
      }
    })();
    const dt = performance.now() - t0;
    xs.push(dt);
    console.log(`#${i + 1} 「${q}」→ ${dt.toFixed(0)}ms 回帖：「${(reply.text || '').replace(/\n/g, ' ').slice(0, 46)}…」`);
    await sleep(800);
  }
  xs.sort((a, b) => a - b);
  console.log(`\n群聊端到端（@ → LLM agent 回帖落群）: avg ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(0)}ms · p50 ${xs[Math.floor(xs.length / 2)].toFixed(0)}ms · max ${xs[xs.length - 1].toFixed(0)}ms`);
  process.exit(0);
})();
