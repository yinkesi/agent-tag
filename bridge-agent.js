#!/usr/bin/env node
/**
 * bridge-agent.js —— 把任意 OpenAI 兼容模型接口接入 agent-tag，成为一个常驻群成员
 *
 * 工作方式：长轮询收 @ 事件 → 抓取该群最近消息作上下文 → 调 LLM → 回帖。
 * 支持 llama.cpp / Ollama / vLLM / 各家云 API（OpenAI 兼容格式即可）。
 *
 * 例：
 *   node bridge-agent.js --name 答疑助手 --base-url http://127.0.0.1:8080/v1 --model qwen2.5-1.5b
 *   node bridge-agent.js --name 客服bot --base-url https://api.example.com/v1 --model gpt-4o-mini --api-key sk-xxx --channels general,lounge
 */
'use strict';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const SERVER = String(arg('server', process.env.AGENT_TAG_SERVER || 'http://127.0.0.1:8091')).replace(/\/$/, '');
const NAME = arg('name') || (console.error('缺少 --name') || process.exit(1));
const PERSONA = arg('persona', '群聊里的 LLM agent，简短、直接、有用');
const BASE_URL = String(arg('base-url', process.env.AGENT_TAG_LLM || 'http://127.0.0.1:8080/v1')).replace(/\/$/, '');
const MODEL = arg('model', 'default');
const TOKEN_ARG = String(arg('token', '')); // 服务端 spawn-bridge 下发，或手动持证重登
const API_KEY = arg('api-key', '');
const MAXCTX = Number(arg('max-context', 24));
const HELLO = arg('hello', '1') !== '0';
const CHANNELS_ARG = arg('channels', ''); // 逗号分隔的群 id/名，留空 = 所有公开群
const DEBOUNCE = Number(arg('debounce', 600)); // 合并连发 @ 的窗口，速度优先可再调低
// 上下文可见性（服务端强制过滤）：mentions=只看 @自己的（默认，无共同上下文）；channel=全群；none=无历史
const CONTEXT = ['channel', 'none'].includes(arg('context')) ? arg('context') : 'mentions';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

const fs = require('fs');
const path = require('path');
// 持证重登：bridge 重启不丢身份
const savedToken = (name) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', `bridge-token-${name}.json`), 'utf8')).token; } catch { return null; } };
const rememberToken = (name, token) => { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'data', `bridge-token-${name}.json`), JSON.stringify({ name, token })); };

async function api(path, body, method = 'POST') {
  const res = await fetch(SERVER + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function chat(messages) {
  const res = await fetch(BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(API_KEY ? { authorization: 'Bearer ' + API_KEY } : {}),
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.7, max_tokens: 500 }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim();
}

(async () => {
  /* 注册为 agent（持证重登时刷新人设与上下文模式） */
  const reg = await api('/api/register', { name: NAME, kind: 'agent', persona: PERSONA, context: CONTEXT, token: TOKEN_ARG || savedToken(NAME) || undefined });
  const token = reg.token;
  rememberToken(NAME, token);
  log(`✓ 已注册 ${NAME} → ${SERVER}（上下文模式：${CONTEXT}）`);

  const state = await api(`/api/state?token=${encodeURIComponent(token)}`, null, 'GET');
  const channels = state.channels.filter((c) => {
    if (c.type !== 'group') return false;
    if (!CHANNELS_ARG) return true;
    return CHANNELS_ARG.split(',').map((s) => s.trim()).some((k) => k === c.id || k === c.name);
  });
  const byId = new Map(channels.map((c) => [c.id, c]));
  log(`监控群：${channels.map((c) => c.name).join('、') || '（无）'}`);

  if (HELLO) {
    for (const c of channels) {
      await api('/api/messages', { token, channel: c.id, text: `大家好，我是 ${NAME}（${PERSONA}）。@我 即可派活。` });
    }
  }

  let cursor = 0;
  const pending = new Map(); // channelId -> {from, texts[]}

  async function respond(channelId) {
    const ch = byId.get(channelId);
    if (!ch) return;
    const p = pending.get(channelId);
    pending.delete(channelId);
    await api('/api/typing', { token, channel: channelId });
    try {
      const { messages: history } = await api(
        `/api/messages?token=${encodeURIComponent(token)}&channel=${encodeURIComponent(channelId)}&limit=${MAXCTX}`, null, 'GET');
      const lines = history
        .filter((m) => m.kind === 'text')
        .map((m) => `${m.from}: ${m.text}`);
      const context = lines.join('\n');
      const scopeNote = CONTEXT === 'mentions'
        ? '群聊对你是上下文隔离的：你只能看到 @ 你提及的消息，不要猜测或虚构没见过的群聊内容。'
        : CONTEXT === 'none'
          ? '你没有任何群聊历史，只依据下面这条任务本身回答。'
          : '你可以看到全群聊天记录。';
      const reply = await chat([
        {
          role: 'system',
          content: `你是群聊「${ch.name}」里的成员「${NAME}」。人设：${PERSONA}。${scopeNote}` +
            `以下是与你相关的最近消息，最后是别人 @ 你提出的内容。直接以群聊口吻回复，简短（一般不超过6句），不要重复自己的名字，不要编造不存在的成员。`,
        },
        { role: 'user', content: context || '（没有可见历史，请直接处理任务）' },
      ]);
      await api('/api/messages', { token, channel: channelId, text: reply || '（我走神了，再 @ 我一次）' });
      log(`↩ 已回复 ${ch.name}`);
    } catch (e) {
      log(`✗ 回复失败: ${e.message}`);
      await api('/api/messages', { token, channel: channelId, text: `（模型调用失败：${e.message.slice(0, 120)}）` }).catch(() => {});
    }
  }

  for (;;) {
    try {
      const { events = [], cursor: c2, reset } = await api(
        `/api/events?token=${encodeURIComponent(token)}&since=${cursor}&wait=25`, null, 'GET');
      if (reset) cursor = c2 ?? 0;
      cursor = c2 ?? cursor;
      for (const evt of events) {
        if (evt.type !== 'message') continue;
        const m = evt.message;
        if (!byId.has(m.channel)) continue;
        if (m.from === NAME) continue;
        const mentioned = (m.mentions || []).includes(NAME);
        const mentionedBotDefault = NAME === 'TagBot';
        if (!mentioned) continue;
        const p = pending.get(m.channel) || { texts: [] };
        p.from = m.from;
        p.texts.push(m.text);
        pending.set(m.channel, p);
      }
      // 去抖窗口：把连发的 @ 合成一次回复（--debounce 可调，默认 600ms）
      for (const [cid, p] of pending) {
        if (p.ts && Date.now() - p.ts < DEBOUNCE) continue;
        p.ts = Date.now();
        setTimeout(() => respond(cid), DEBOUNCE + 100);
      }
    } catch (e) {
      log(`轮询异常: ${e.message}`);
      await sleep(2000);
    }
  }
})();
