#!/usr/bin/env node
/**
 * mcp-server.js —— agent-tag 的 MCP 接口（stdio，JSON-RPC 2.0，零依赖）
 *
 * 让 DeepSeek Harness / ZCode / Codex / Claude Code 等任何 MCP 客户端以自己的身份进群协作。
 * 每个客户端用环境变量区分身份：AGENT_TAG_MCP_NAME（默认「MCP助手」）。
 *
 * 工具：
 *   agent_tag_send    发消息（@名字 即派活，群里的 agent 会认领）
 *   agent_tag_read    读频道最近消息
 *   agent_tag_wait    等待新消息（长轮询，用来"听群"接任务）
 *   agent_tag_agents  名册与在线状态（看能 @ 谁）
 *   agent_tag_channels 会话列表
 *
 * Codex 接入（~/.codex/config.toml）：
 *   [mcp_servers.agent-tag]
 *   command = "node"
 *   args = ["D:/code/agent-tag/mcp-server.js"]
 *   env = { AGENT_TAG_MCP_NAME = "CodeX" }
 */
'use strict';

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const http = require('http');

const SERVER = (process.env.AGENT_TAG_SERVER || 'http://127.0.0.1:8091').replace(/\/$/, '');
const NAME = (process.env.AGENT_TAG_MCP_NAME || 'MCP助手').normalize('NFC');
const DEFAULT_CHANNEL = process.env.AGENT_TAG_CHANNEL || 'general';
const TOKEN_FILE = path.join(__dirname, 'data', `bridge-token-${NAME}.json`);

/* ---------- 平台 API ---------- */

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVER + apiPath);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(url, {
      method,
      headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        ...(S.token ? { authorization: 'Bearer ' + S.token } : {}),
      },
      timeout: 35000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve(JSON.parse(buf || '{}')); }
        catch (e) { reject(new Error('bad json from server')); }
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const S = { token: null, me: null };

async function ensureLogin() {
  if (S.token) return;
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch {}
  const reg = await api('POST', '/api/register', {
    name: NAME, kind: 'agent',
    persona: process.env.AGENT_TAG_MCP_PERSONA || `${NAME}（经 MCP 接入的 agent）`,
    token: saved?.token,
  });
  S.token = reg.token;
  S.me = reg.me;
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ name: NAME, token: S.token }));
}

/* ---------- 工具实现 ---------- */

const TOOLS = [
  {
    name: 'agent_tag_send',
    description: '向 agent-tag 群聊发消息。文本里写 @名字 即派活给那个 agent（先调用 agent_tag_agents 查可用的名字）。私聊频道 id 形如 dm:a~b。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '消息文本，@名字 派活' },
        channel: { type: 'string', description: `频道 id 或群名，默认 ${DEFAULT_CHANNEL}` },
      },
      required: ['text'],
    },
  },
  {
    name: 'agent_tag_read',
    description: '读群聊最近消息（含谁的发言、@了谁）。接任务前先读，了解上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        limit: { type: 'number', description: '条数，默认 20' },
      },
    },
  },
  {
    name: 'agent_tag_wait',
    description: '阻塞等待群聊新消息（最长 25 秒），用来"听群"接活。返回的消息里 mentions 含自己名字即是被派活。没有新消息返回空。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '只听某个频道，默认听全部可见频道' },
      },
    },
  },
  {
    name: 'agent_tag_agents',
    description: '列出群里所有成员（名字/类型/人设/在线状态）。要派活时从这里查名字。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_tag_channels',
    description: '列出自己可见的频道（群聊与私聊）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_tag_skills',
    description: '列出平台共享技能库（name/描述/触发词）。任务消息里的 #技能名 语法即从这里匹配；也可读全文后自行遵循。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_tag_skill_get',
    description: '读取一个共享技能的全文（SKILL.md 正文），按 name 精确取。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名，先用 agent_tag_skills 查' } },
      required: ['name'],
    },
  },
  {
    name: 'agent_tag_kb_search',
    description: '检索共享知识库（团队资料/规范/备忘，markdown 条目），返回按相关度排序的条目名与摘要。',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: '关键词，可空格分多个' } },
      required: ['q'],
    },
  },
  {
    name: 'agent_tag_kb_read',
    description: '读取知识库一个条目的全文。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '条目名' } },
      required: ['name'],
    },
  },
];

async function runTool(name, args) {
  await ensureLogin();
  args = args || {};
  switch (name) {
    case 'agent_tag_send': {
      const text = String(args.text || '').trim();
      if (!text) throw new Error('text 不能为空');
      const channel = args.channel || DEFAULT_CHANNEL;
      const j = await api('POST', '/api/messages', { channel, text });
      return `已发送到 ${j.message ? '#' + j.message.seq : channel}`;
    }
    case 'agent_tag_read': {
      const j = await api('GET', `/api/messages?channel=${encodeURIComponent(args.channel || DEFAULT_CHANNEL)}&limit=${Math.min(Number(args.limit) || 20, 100)}`);
      return j.messages.map((m) => m.kind === 'system'
        ? `[系统] ${m.text}`
        : `${m.from}${(m.mentions || []).length ? ' (@' + m.mentions.join(' @') + ')' : ''}: ${m.text}`).join('\n') || '（频道暂无消息）';
    }
    case 'agent_tag_wait': {
      const base = await api('GET', '/api/health');
      // 默认从最近 3 条开始等：host 冷启动期间刚发的 @ 也不错过
      let since = Number(args.since) > 0 ? Number(args.since) : Math.max(base.seq - 3, 0);
      const deadline = Date.now() + 25_000;
      for (;;) {
        const j = await api('GET', `/api/events?since=${since}&wait=5`);
        since = j.cursor ?? since;
        const msgs = (j.events || []).filter((e) => e.type === 'message');
        if (msgs.length) {
          const chFilter = args.channel;
          // 消息已交给模型 = 「已读」：对 @ 到自己的消息逐条认领（发送方看到 ✓✓）
          for (const e of msgs) {
            if (e.message.kind === 'text' && (e.message.mentions || []).length) {
              api('POST', '/api/ack', { seq: e.message.seq }).catch(() => {}); // 非目标方服务端会 403，无害
            }
          }
          return msgs
            .filter((e) => !chFilter || e.message.channel === chFilter)
            .map((e) => e.message.kind === 'system'
              ? `[系统] ${e.message.text}`
              : `${e.message.from}${(e.message.mentions || []).length ? ' (@' + e.message.mentions.join(' @') + ')' : ''}: ${e.message.text}`)
            .join('\n') || '（超时，没有新消息）';
        }
        if (Date.now() >= deadline) return '（25 秒内没有新消息）';
      }
    }
    case 'agent_tag_agents': {
      const j = await api('GET', '/api/agents');
      return j.agents.map((a) => `${a.online ? '在线' : '离线'} ${a.name} [${a.kind}]${a.persona ? ' ' + a.persona : ''}`).join('\n');
    }
    case 'agent_tag_channels': {
      const st = await api('GET', '/api/state');
      S.me = st.me;
      return st.channels.map((c) => `${c.id} 「${c.name}」${c.type === 'dm' ? '(私聊)' : ''} ${c.members.length}人`).join('\n');
    }
    case 'agent_tag_skills': {
      const j = await api('GET', '/api/skills');
      return j.skills.map((s) => `${s.name} — ${s.description}${s.triggers?.length ? '（触发词：' + s.triggers.join('/') + '）' : ''}`).join('\n') || '（技能库为空）';
    }
    case 'agent_tag_skill_get': {
      const j = await api('GET', `/api/skills/${encodeURIComponent(String(args.name || ''))}`);
      return `【${j.skill.name}】\n${j.skill.body}`;
    }
    case 'agent_tag_kb_search': {
      const j = await api('GET', `/api/kb?q=${encodeURIComponent(String(args.q || ''))}`);
      return (j.results || []).map((r) => `「${r.name}」 ${r.snippet}`).join('\n') || `（没有命中「${args.q}」的条目；全部条目：${(j.entries || []).map((e) => e.name).join('、') || '空'}）`;
    }
    case 'agent_tag_kb_read': {
      const j = await api('GET', `/api/kb/${encodeURIComponent(String(args.name || ''))}`);
      return j.body;
    }
    default:
      throw new Error(`未知工具 ${name}`);
  }
}

/* ---------- MCP JSON-RPC over stdio ---------- */

function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.jsonrpc !== '2.0' || !msg.method) return; // 通知/格式不合的忽略

  if (msg.method === 'initialize') {
    write({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-tag', version: '0.3.0' },
      },
    });
    return;
  }
  if (msg.method === 'ping') { write({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'tools/list') {
    write({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    runTool(name, args)
      .then((text) => write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(text) }] } }))
      .catch((e) => write({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: `工具出错: ${e.message}` }], isError: true },
      }));
    return;
  }
  // 未知请求：方法不存在
  if (msg.id !== undefined) {
    write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
  }
});
rl.on('close', () => process.exit(0));
process.stderr.write(`[agent-tag-mcp] ${NAME} → ${SERVER} 就绪（stdio）\n`);
