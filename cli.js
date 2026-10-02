#!/usr/bin/env node
/**
 * agent-tag CLI —— 接入群聊的两种形态（设计参考 Open Design 的 od CLI）
 *
 * ① 交互模式（人 / agent 聊天）
 *   node cli.js --name 阿明
 *   命令：/help /channels /switch <群名|id> /dm <名字> /create <群名> /agents /me /quit
 *
 * ② headless 模式（外部 agent / 脚本指挥面，一条命令一个动作，与 UI 同源）
 *   node cli.js send [-c <群>] <文本...>     发一条消息（@名字 即派活）
 *   node cli.js read [-c <群>] [-n 条数]     读最近消息
 *   node cli.js agents                       名册与在线状态
 *   node cli.js channels                     会话列表
 *   node cli.js cursor                       记录当前事件水位（收割起点）
 *   node cli.js listen [--since <水位>]      持续消费新事件（NDJSON/人类可读）
 *   所有命令都支持 --json 输出机器可读结果；身份复用交互模式缓存的 token。
 *
 * agent-runtime form（不依赖 PATH 的推荐调用形式，参考 od）：
 *   "${AGENT_TAG_NODE:-node}" "${AGENT_TAG_BIN:-<项目目录>/cli.js}" send -c general "你好"
 */
'use strict';

const http = require('http');
const https = require('https');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

/* ---------- 参数 ---------- */

function arg(name, def) {
  for (const pfx of ['--', '-']) {
    const i = process.argv.indexOf(pfx + name);
    if (i !== -1) return process.argv[i + 1];
  }
  return def;
}

const SERVER = (arg('server', process.env.AGENT_TAG_SERVER || 'http://127.0.0.1:8091')).replace(/\/$/, '');
const HAS_VALUE = new Set(['--server', '--name', '--kind', '--persona', '--token', '--channel', '-c', '--limit', '-n', '--since', '--text']);
// 子命令 = 第一个裸词（允许 --name 等参数放在它前面，如：cli.js --name 阿明 send ...）
let SUB = null, SUB_IDX = -1;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('-')) { if (HAS_VALUE.has(a)) i++; continue; }
  SUB = a; SUB_IDX = i; break;
}
const NAME = arg('name', '');
const KIND = arg('kind', 'human') === 'agent' ? 'agent' : 'human';
const PERSONA = arg('persona', '');
const TOKEN_ARG = arg('token', '');
const AS_JSON = process.argv.includes('--json');

const ID_FILE = path.join(__dirname, 'data', 'cli-identity.json');
const CURSOR_FILE = path.join(__dirname, 'data', 'cli-cursor.json');

function readCachedIdentity() {
  try { return JSON.parse(fs.readFileSync(ID_FILE, 'utf8')); } catch { return null; }
}

/* ---------- HTTP ---------- */

function req(method, apiPath, body, { waitMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVER + apiPath);
    const mod = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const r = mod.request(url, {
      method,
      headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      },
      timeout: waitMs ? (waitMs + 10) * 1000 : 15000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }); }
        catch { reject(new Error('bad json: ' + buf.slice(0, 100))); }
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- ANSI ---------- */

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};
const hueColor = (hue) => `\x1b[38;5;${16 + Math.floor(hue / 20) * 36 + 10}m`;

/* ---------- 会话状态 ---------- */

const S = {
  token: null, me: null,
  agents: new Map(),
  channels: new Map(),
  current: null,
  cursor: 0,
};

async function login(nameArg) {
  const name = nameArg || NAME;
  if (!name) {
    const cached = readCachedIdentity();
    if (cached?.server === SERVER && cached?.name) nameArg = cached.name;
  }
  const finalName = nameArg || name;
  if (!finalName) {
    console.error(C.red('缺少身份：--name <名字>（或先用交互模式登录一次，会缓存身份）'));
    process.exit(1);
  }
  let saved = readCachedIdentity();
  if (saved?.server === SERVER && saved?.name === finalName && saved?.token) {
    const r = await req('POST', '/api/register', { name: finalName, kind: KIND, token: saved.token, persona: PERSONA }).catch(() => null);
    if (r?.status === 200) { S.token = r.json.token; S.me = r.json.me; }
  }
  if (!S.token) {
    const body = { name: finalName, kind: KIND };
    if (PERSONA) body.persona = PERSONA;
    if (TOKEN_ARG) body.token = TOKEN_ARG;
    const r = await req('POST', '/api/register', body);
    if (r.status !== 200) {
      console.error(C.red('✗ ' + (r.json.error || '登录失败')));
      process.exit(1);
    }
    S.token = r.json.token; S.me = r.json.me;
    fs.mkdirSync(path.dirname(ID_FILE), { recursive: true });
    fs.writeFileSync(ID_FILE, JSON.stringify({ server: SERVER, name: finalName, token: S.token }));
  }
}

async function refreshState() {
  const { json } = await req('GET', `/api/state?token=${encodeURIComponent(S.token)}`);
  S.me = json.me;
  S.agents = new Map(json.agents.map((a) => [a.name, a]));
  S.channels = new Map(json.channels.map((c) => [c.id, c]));
}

function findChannel(idOrName) {
  for (const c of S.channels.values()) if (c.id === idOrName || c.name === idOrName) return c;
  return null;
}

function chLabel(ch) { return ch.type === 'dm' ? `私信·${ch.name}` : ch.name; }

function printMessage(m, historical = false) {
  const t = new Date(m.ts).toTimeString().slice(0, 5);
  if (m.kind === 'system') return console.log(C.dim(`   ── ${m.text}`));
  const mine = m.from === S.me.name;
  const col = mine ? C.dim : (s) => hueColor(m.hue ?? 200) + s + '\x1b[0m';
  const at = (m.mentions || []).includes(S.me.name) ? C.yellow(' [@你]') : '';
  const badge = m.fromKind === 'bot' ? C.magenta('[BOT]') : m.fromKind === 'agent' ? C.cyan('[AGENT]') : '';
  const who = mine ? C.green('我') : col(m.from);
  console.log(`${C.dim(t)} ${who} ${C.dim(badge)}${at}${historical ? C.dim(' (历史)') : ''}`);
  for (const line of String(m.text).split('\n')) console.log(`  ${mine ? C.dim(line) : line}`);
}

/* ================================================================
 * headless 模式（od 式指挥面）：一条命令一个动作，--json 机器可读
 * ================================================================ */

function posArgs() {
  const out = [];
  const a = process.argv;
  for (let i = SUB_IDX + 1; i < a.length; i++) {
    if (a[i].startsWith('-')) {
      if (HAS_VALUE.has(a[i])) i++;
      continue;
    }
    out.push(a[i]);
  }
  return out;
}

function emit(obj) { console.log(JSON.stringify(obj, null, 2)); }

function loadCursorMap() {
  try { return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')); } catch { return {}; }
}
function saveCursorSeq(seq) {
  fs.mkdirSync(path.dirname(CURSOR_FILE), { recursive: true });
  const map = loadCursorMap();
  map[`${SERVER}~${S.me.name}`] = seq;
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(map));
  return seq;
}

async function headlessMain(sub) {
  await login();
  // send/read/cursor 走快速路径不拉全量状态；需要名册/频道名的分支再拉
  switch (sub) {
    case 'send': {
      const text = (arg('text', null) || posArgs().join(' ')).trim();
      if (!text) { console.error(C.red('用法: cli.js send [-c <群名|id>] <文本...>')); process.exit(1); }
      const ref = arg('channel') || arg('c') || 'general';
      // 快速路径：先当频道 id 直接发，404 才回头解析群名（省一次 state RTT）。
      // 兜底必须落到全量拉取：headless send 不预拉 state，S.channels 为空时 findChannel 必扑空
      // （原此处引用未定义的 resolveChannelLazy，直接 ReferenceError）
      let r = await req('POST', `/api/messages?token=${encodeURIComponent(S.token)}`, { channel: ref, text });
      if (r.status === 404) {
        try { await refreshState(); }
        catch (e) { console.error(C.red('✗ 拉取会话列表失败: ' + e.message)); process.exit(1); }
        const ch = findChannel(ref);
        if (!ch) { console.error(C.red('✗ 找不到会话 ' + ref)); process.exit(1); }
        r = await req('POST', `/api/messages?token=${encodeURIComponent(S.token)}`, { channel: ch.id, text });
      }
      if (r.status !== 200) { console.error(C.red('✗ ' + (r.json.error || '发送失败'))); process.exit(1); }
      if (AS_JSON) emit({ ok: true, message: r.json.message });
      else console.log(`${C.green('✓')} 已发送 ${C.dim('#' + r.json.message.seq)}`);
      break;
    }
    case 'read': {
      const ref = arg('channel') || arg('c') || 'general';
      const limit = Number(arg('limit') || arg('n') || 20);
      let r = await req('GET', `/api/messages?token=${encodeURIComponent(S.token)}&channel=${encodeURIComponent(ref)}&limit=${limit}`);
      if (r.status === 404) {
        try { await refreshState(); } // 同 send：按名兜底必须全量拉一次，S.channels 空时 findChannel 查不到
        catch (e) { console.error(C.red('✗ 拉取会话列表失败: ' + e.message)); process.exit(1); }
        const ch = findChannel(ref);
        if (!ch) { console.error(C.red('✗ 找不到会话 ' + ref)); process.exit(1); }
        r = await req('GET', `/api/messages?token=${encodeURIComponent(S.token)}&channel=${encodeURIComponent(ch.id)}&limit=${limit}`);
      }
      if (r.status !== 200) { console.error(C.red('✗ ' + (r.json.error || '读取失败'))); process.exit(1); }
      if (AS_JSON) return emit({ messages: r.json.messages });
      console.log(C.dim(`── 最近 ${r.json.messages.length} 条 ──`));
      for (const m of r.json.messages) printMessage(m);
      break;
    }
    case 'agents': {
      await refreshState();
      if (AS_JSON) return emit({ agents: [...S.agents.values()] });
      for (const a of S.agents.values()) {
        console.log(`  ${a.online ? C.green('● 在线') : C.dim('○ 离线')} ${C.bold(a.name)} ${C.dim(`[${a.kind}]`)} ${C.dim(a.persona || '')}`);
      }
      break;
    }
    case 'channels': {
      await refreshState();
      if (AS_JSON) return emit({ channels: [...S.channels.values()].map((c) => ({ id: c.id, name: c.name, type: c.type, members: c.members.length })) });
      for (const c of S.channels.values()) {
        console.log(`  ${C.bold(chLabel(c))} ${C.dim(c.id + (c.topic ? ' · ' + c.topic : ''))}`);
      }
      break;
    }
    case 'cursor': {
      const { json } = await req('GET', '/api/health');
      const seq = saveCursorSeq(json.seq);
      if (AS_JSON) return emit({ ok: true, cursor: seq });
      console.log(`${C.green('✓')} 事件水位已记录：${seq} ${C.dim('（listen --since ' + seq + ' 从这里收割增量）')}`);
      break;
    }
    case 'listen': {
      await refreshState();
      const map = loadCursorMap();
      let cursor = Number(arg('since')) || map[`${SERVER}~${S.me.name}`] || 0;
      if (!AS_JSON) console.error(C.dim(`监听 ${SERVER}（身份 ${S.me.name}），起始水位 ${cursor}，Ctrl+C 退出`));
      let backoff = 500;
      for (;;) {
        try {
          const { json } = await req('GET', `/api/events?token=${encodeURIComponent(S.token)}&since=${cursor}&wait=25`, null, { waitMs: 26 });
          backoff = 500;
          if (json.reset) { cursor = json.cursor ?? 0; continue; }
          cursor = json.cursor ?? cursor;
          saveCursorSeq(cursor);
          for (const evt of json.events || []) {
            if (AS_JSON) {
              console.log(JSON.stringify(evt));
            } else if (evt.type === 'message') {
              const m = evt.message;
              const at = (m.mentions || []).includes(S.me.name) ? C.yellow(' [@你]') : '';
              const ch = S.channels.get(m.channel);
              console.log(`${C.dim(new Date(m.ts).toTimeString().slice(0, 5))} ${C.cyan(ch ? chLabel(ch) : m.channel)} ${C.bold(m.from)}${at}: ${String(m.text).replace(/\n/g, ' ')}`);
            }
          }
        } catch {
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 5000);
        }
      }
    }
    case 'help':
    default: {
      console.log([
        `${C.bold('headless 模式')}（供外部 agent / 脚本调用）`,
        `  cli.js send    [-c 群] <文本...>   发消息（@名字 派活）`,
        `  cli.js read    [-c 群] [-n 条数]   读最近消息`,
        `  cli.js agents                       名册与在线状态`,
        `  cli.js channels                     会话列表`,
        `  cli.js cursor                       记录事件水位`,
        `  cli.js listen   [--since 水位]      持续消费事件`,
        `  加 --json 输出机器可读结果；身份用 --name 或缓存身份`,
        `${C.bold('交互模式')}`,
        `  cli.js --name 阿明   （/help 看聊天命令）`,
      ].join('\n'));
    }
  }
  process.exit(0);
}

/* ================================================================
 * 交互模式（原有路径，逻辑不变）
 * ================================================================ */

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: C.cyan(`\n${NAME || 'cli'}> `) });

// 启动（登录/拉状态/切频道）是异步的，这期间到达的输入先排队，就绪后再回放
const readyQueue = [];
let ready = false;
let pendingClose = false;

async function switchTo(ch) {
  S.current = ch.id;
  const { json } = await req('GET', `/api/messages?token=${encodeURIComponent(S.token)}&channel=${encodeURIComponent(ch.id)}&limit=30`);
  console.log(C.dim(`── 已切到「${chLabel(ch)}」${ch.topic ? '· ' + ch.topic : ''}，输入消息回车发送，/help 看命令 ──`));
  for (const m of json.messages.slice(-20)) printMessage(m, true);
}

let closed = false;

async function pollLoop() {
  let backoff = 500;
  while (!closed) {
    try {
      const { json } = await req('GET', `/api/events?token=${encodeURIComponent(S.token)}&since=${S.cursor}&wait=25`, null, { waitMs: 26 });
      backoff = 500;
      if (json.reset) { S.cursor = json.cursor; await refreshState(); continue; }
      S.cursor = json.cursor ?? S.cursor;
      for (const evt of json.events || []) handleEvent(evt);
    } catch {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 5000);
    }
  }
}

function handleEvent(evt) {
  if (evt.type === 'message') {
    const m = evt.message;
    const ch = S.channels.get(m.channel);
    if (!ch) return;
    if (m.channel === S.current) {
      if (m.from !== S.me.name) printMessage(m);
    } else {
      const at = (m.mentions || []).includes(S.me.name);
      console.log(C.dim(`〔${C.cyan(chLabel(ch))}〕${m.from}: ${String(m.text).slice(0, 60)}${at ? C.yellow(' [@你]') : ''}`));
    }
    rl.prompt(true);
  } else if (evt.type === 'presence') {
    const a = S.agents.get(evt.name);
    if (a) a.online = evt.online;
  } else if (evt.type === 'channel') {
    if (evt.channel.type === 'dm' && !evt.channel.members.includes(S.me.name)) return;
    S.channels.set(evt.channel.id, evt.channel);
  }
}

function help() {
  console.log([
    `${C.bold('命令')}`,
    `  /channels            列出所有会话`,
    `  /switch <群名|id>    切换当前会话`,
    `  /dm <名字>           与某人开私聊`,
    `  /create <群名>       建新群`,
    `  /agents              看名册与在线状态`,
    `  /me                  看我的身份与 token`,
    `  /quit                退出`,
    `发消息直接打字回车；@名字 即派活（agent 收到会认领）。`,
    C.dim(`headless 用法（供脚本）：cli.js send|read|agents|channels|cursor|listen --json`),
  ].join('\n'));
}

rl.on('line', async (line) => {
  if (!ready) { readyQueue.push(line); return; }
  const t = line.trim();
  try {
    if (!t) return rl.prompt(true);
    if (t.startsWith('/')) {
      const [cmd, ...rest] = t.split(/\s+/);
      const argStr = rest.join(' ').trim();
      switch (cmd) {
        case '/help': help(); break;
        case '/channels':
          for (const c of S.channels.values()) {
            console.log(`  ${c.id === S.current ? C.green('●') : '○'} ${C.bold(chLabel(c))} ${C.dim(c.id + (c.topic ? ' · ' + c.topic : ''))}`);
          }
          break;
        case '/switch': {
          const ch = findChannel(argStr);
          if (!ch) return console.log(C.red('✗ 找不到会话 ' + argStr));
          await switchTo(ch);
          break;
        }
        case '/dm': {
          if (!S.agents.has(argStr)) return console.log(C.red('✗ 名册里没有 ' + argStr));
          const { json } = await req('POST', `/api/channels?token=${encodeURIComponent(S.token)}`, { type: 'dm', dmWith: argStr });
          S.channels.set(json.channel.id, json.channel);
          await switchTo(json.channel);
          break;
        }
        case '/create': {
          if (!argStr) return console.log(C.red('✗ 用法 /create <群名>'));
          const { json } = await req('POST', `/api/channels?token=${encodeURIComponent(S.token)}`, { name: argStr });
          S.channels.set(json.channel.id, json.channel);
          await switchTo(json.channel);
          break;
        }
        case '/agents':
          if (!S.agents.size) console.log(C.dim('  （名册为空）'));
          for (const a of S.agents.values()) {
            console.log(`  ${a.online ? C.green('● 在线') : C.dim('○ 离线')} ${C.bold(a.name)} ${C.dim(`[${a.kind}]`)} ${C.dim(a.persona || '')}`);
          }
          break;
        case '/me':
          console.log(`  ${C.bold(S.me.name)} [${S.me.kind}] token=${C.cyan(S.token)}`);
          break;
        case '/quit': closed = true; console.log(C.dim('再见')); process.exit(0);
        default: console.log(C.red('未知命令 ' + cmd + '，/help 查看'));
      }
      return rl.prompt(true);
    }
    if (!S.current) return console.log(C.red('先 /switch 到一个会话')), rl.prompt(true);
    await req('POST', `/api/messages?token=${encodeURIComponent(S.token)}`, { channel: S.current, text: t });
  } catch (e) {
    console.log(C.red('✗ ' + e.message));
  }
  rl.prompt(true);
});

rl.on('close', () => {
  if (!ready) { pendingClose = true; return; } // 等启动回放完队列再退
  closed = true; process.exit(0);
});

async function interactiveMain() {
  try {
    if (!NAME) {
      console.log('用法: node cli.js --name <名字> [--kind human|agent] [--persona <人设>] [--channel <群id>] [--token <持证重登>]');
      console.log(C.dim('headless: node cli.js send|read|agents|channels|cursor|listen ...'));
      process.exit(1);
    }
    await login();
    await refreshState();
    const target = arg('channel', 'general');
    const ch = findChannel(target) || [...S.channels.values()][0];
    if (ch) await switchTo(ch);
    console.log(C.dim('（后台实时收消息中）'));
    rl.prompt(true);
    pollLoop();
    ready = true;
    for (const l of readyQueue.splice(0)) rl.emit('line', l);
    if (pendingClose) process.exit(0);
    // 心跳保持在线
    setInterval(() => req('POST', `/api/heartbeat?token=${encodeURIComponent(S.token)}`, {}).catch(() => {}), 15000);
  } catch (e) {
    if (!String(e.message).includes('readline was closed')) { // 管道误入交互模式的静默退出
      console.error(C.red('启动失败: ' + e.message));
      console.error(C.dim('服务端没起？先跑 node server.js'));
    }
    process.exit(1);
  }
}

/* ---------- 入口 ---------- */

(async () => {
  if (SUB) await headlessMain(SUB);
  else await interactiveMain();
})();
