#!/usr/bin/env node
/**
 * llm-bench.mjs —— 裸 LLM 对话速度基准（对照组）
 * 用法：node llm-bench.mjs [base-url] [model] [轮数]
 */
'use strict';
const BASE = (process.argv[2] || 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const MODEL = process.argv[3] || 'MiniCPM5-2B';
const N = Number(process.argv[4] || 5);

async function once(i) {
  const t0 = performance.now();
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: '用两句话介绍一下标签抽取是做什么的' }],
      max_tokens: 150,
    }),
  });
  const j = await res.json();
  const total = performance.now() - t0;
  const t = j.timings || {};
  console.log(`#${i} 总耗时 ${total.toFixed(0)}ms | 预填 ${t.prompt_ms?.toFixed(0) ?? '?'}ms(${t.prompt_n ?? '?'}tok) | 生成 ${t.predicted_ms?.toFixed(0) ?? '?'}ms ${t.predicted_n ?? '?'}tok (${t.predicted_per_second?.toFixed(1) ?? '?'} tok/s) | 「${(j.choices?.[0]?.message?.content || '').replace(/\n/g, ' ').slice(0, 30)}…」`);
  return total;
}

(async () => {
  await once(0); // 预热
  const xs = [];
  for (let i = 1; i <= N; i++) xs.push(await once(i));
  xs.sort((a, b) => a - b);
  console.log(`\n裸 LLM 回复总时长: avg ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(0)}ms · p50 ${xs[Math.floor(xs.length / 2)].toFixed(0)}ms · max ${xs[xs.length - 1].toFixed(0)}ms`);
  process.exit(0);
})();
