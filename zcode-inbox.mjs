#!/usr/bin/env node
/**
 * zcode-inbox.mjs —— ZCode 在 agent-tag 群里的收发通道
 *
 *   node zcode-inbox.mjs check        列出未处理的对 @ZCode 的 @（游标持久化，不重复）
 *   node zcode-inbox.mjs reply <文本>  以 ZCode 身份回帖（自动带上 @发起者）
 *   node zcode-inbox.mjs send <频道> <文本>  主动发言
 *
 * 身份 token 自动注册/持证重登（data/bridge-token-ZCode.json）。
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.AGENT_TAG_SERVER || 'http://127.0.0.1:8091').replace(/\/$/, '');
const NAME = process.env.AGENT_TAG_MCP_NAME || 'ZCode';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const TOKEN_FILE = path.join(DIR, `bridge-token-${NAME}.json`);
const CURSOR_FILE = path.join(DIR, `zcode-cursor.json`);

async function api(method, p, body, token) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

async function token() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch {}
  const reg = await api('POST', '/api/register', {
    name: NAME, kind: 'agent',
    persona: 'ZCode 本体：写代码、查问题、跑测试都能干，@我 即派活',
    token: saved?.token,
  });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ name: NAME, token: reg.token }));
  return reg.token;
}

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  const tk = await token();
  if (cmd === 'check') {
    const cur = (() => { try { return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')).cursor ?? 0; } catch { return 0; } })();
    // 从游标稍往前 2 条兜底，避免边界漏收
    const j = await api('GET', `/api/events?token=${encodeURIComponent(tk)}&since=${Math.max(cur - 2, 0)}&wait=0`);
    const pending = (j.events || [])
      .filter((e) => e.type === 'message' && (e.message.mentions || []).includes(NAME) && e.message.from !== NAME)
      .map((e) => ({ seq: e.message.seq, channel: e.message.channel, from: e.message.from, text: e.message.text }));
    const last = pending.length ? pending[pending.length - 1] : null;
    const prevLast = (() => { try { return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')).lastMention ?? null; } catch { return null; } })();
    fs.writeFileSync(CURSOR_FILE, JSON.stringify({
      cursor: j.cursor ?? cur,
      lastMention: last || prevLast, // reply 默认回复到最近一条 @ 所在频道
    }));
    if (!pending.length) { console.log('(没有待处理的 @)'); return 0; }
    for (const m of pending) console.log(`#${m.seq} [${m.channel}] @${m.from}: ${m.text}`);
    return 0;
  }
  if (cmd === 'reply') {
    const text = rest.join(' ').trim();
    if (!text) { console.error('用法: reply <文本>（文本无需再带 @）'); return 1; }
    // 回复到最近一条 @ 所在频道，并 @回发起者
    const cur = (() => { try { return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')).lastMention ?? null; } catch { return null; } })();
    let channel = 'general', greet = '';
    if (cur) { channel = cur.channel; greet = `@${cur.from} `; }
    const j = await api('POST', '/api/messages', { channel, text: greet + text }, tk);
    console.log(`已回复到 ${channel} #${j.message.seq}`);
    return 0;
  }
  if (cmd === 'send') {
    const [channel, ...t] = rest;
    const j = await api('POST', '/api/messages', { channel: channel || 'general', text: t.join(' ').trim() }, tk);
    console.log(`已发送 #${j.message.seq}`);
    return 0;
  }
  console.error('用法: zcode-inbox.mjs check | reply <文本> | send <频道> <文本>');
  return 1;
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error('出错: ' + e.message);
  process.exitCode = 1;
}
