#!/usr/bin/env node
/**
 * mcp-smoke.mjs —— MCP server 协议冒烟测试
 * spawn mcp-server.js，按 JSON-RPC 2.0 走 initialize → tools/list → 逐个 tools/call。
 * 用法：node mcp-smoke.mjs
 */
'use strict';
import { spawn } from 'child_process';

const child = spawn(process.execPath, [new URL('./mcp-server.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
  env: { ...process.env, AGENT_TAG_MCP_NAME: '冒烟测试MCP' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); } };
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    } catch {}
  }
});
child.stderr.on('data', () => {});
function rpc(method, params, timeoutMs = 30000) {
  const id = Math.random();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  ok(init.result?.serverInfo?.name === 'agent-tag' && init.result?.protocolVersion === '2025-06-18', `initialize（协议版本回显 ${init.result?.protocolVersion}）`);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tl = await rpc('tools/list', {});
  const names = tl.result.tools.map((t) => t.name);
  ok(names.length === 9 && names.includes('agent_tag_send') && names.includes('agent_tag_wait') && names.includes('agent_tag_kb_search'), `tools/list 返回 9 工具`);

  const ag = await rpc('tools/call', { name: 'agent_tag_agents', arguments: {} });
  ok(ag.result?.content?.[0]?.text.includes('TagBot'), 'agent_tag_agents：名册可读');

  const ch = await rpc('tools/call', { name: 'agent_tag_channels', arguments: {} });
  ok(ch.result?.content?.[0]?.text.includes('general'), 'agent_tag_channels：频道可读');

  const rd = await rpc('tools/call', { name: 'agent_tag_read', arguments: { limit: 5 } });
  ok(typeof rd.result?.content?.[0]?.text === 'string', 'agent_tag_read：读消息');

  const sk = await rpc('tools/call', { name: 'agent_tag_skills', arguments: {} });
  ok(sk.result?.content?.[0]?.text.includes('code-review'), 'agent_tag_skills：技能库可列');
  const skg = await rpc('tools/call', { name: 'agent_tag_skill_get', arguments: { name: 'code-review' } });
  ok(skg.result?.content?.[0]?.text.includes('代码走查清单'), 'agent_tag_skill_get：技能全文');
  const kb = await rpc('tools/call', { name: 'agent_tag_kb_search', arguments: { q: '端口' } });
  ok(kb.result?.content?.[0]?.text.includes('8091') || kb.result?.content?.[0]?.text.length > 0, 'agent_tag_kb_search：检索返回');

  const snd = await rpc('tools/call', { name: 'agent_tag_send', arguments: { text: 'MCP 冒烟：大家好' } });
  ok(String(snd.result?.content?.[0]?.text).includes('已发送'), 'agent_tag_send：发送成功');

  const wt = await rpc('tools/call', { name: 'agent_tag_wait', arguments: {} }, 40000);
  ok(typeof wt.result?.content?.[0]?.text === 'string', 'agent_tag_wait：长轮询返回不挂死');

  const bad = await rpc('tools/call', { name: 'agent_tag_send', arguments: { text: '' } });
  ok(bad.result?.isError === true, '错误返回 isError=true（LLM 可读的错误）');

  const nf = await rpc('no/such/method', {});
  ok(nf.error?.code === -32601, '未知方法 -32601');
} catch (e) {
  fail++; console.log('  ✗ 异常: ' + e.message);
}
child.kill();
console.log(`\nMCP 冒烟：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
