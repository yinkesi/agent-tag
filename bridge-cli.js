#!/usr/bin/env node
/**
 * bridge-cli.js —— 把任意「可无头驱动的 CLI agent」接入 agent-tag，成为常驻群成员
 *
 * 原理（与 OpenHands/OpenDevin、OpenCode、Claude Code 等 CLI agent 通用的接入模式）：
 *   长轮询收 @ 事件 → 把任务文本通过 stdin 喂给 CLI 的 headless 模式 →
 *   拿 stdout 作为回帖发回群里。
 *
 * 例：
 *   node bridge-cli.js --name 码农阿克 --cmd "claude -p" --cwd D:\code\some-project
 *   node bridge-cli.js --name 侦查兵   --cmd "opencode run" --timeout 180
 *   node bridge-cli.js --name 测试官   --cmd "node test/fake-agent.mjs"   # 本仓库自带假 agent，用于验证链路
 *
 * 常用参数：
 *   --cmd      必填，CLI 启动命令（headless/print 模式）
 *   --cwd      子进程工作目录（比如你的项目路径）
 *   --stdin=0  改为把任务文本作为最后一个命令行参数传入（默认走 stdin，最稳）
 *   --timeout  单任务超时秒数，默认 240
 *   --channels 逗号分隔的群 id/名，留空 = 所有公开群
 *   --persona / --intro / --server / --max-context
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const routing = require('./routing.js'); // @ 提及剥离纯函数（名字可含正则元字符，不能用 RegExp 拼）

// 持证重登：bridge 重启不丢身份（token 存本地）
function savedToken(name) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', `bridge-token-${name}.json`), 'utf8')).token; } catch { return null; }
}
function rememberToken(name, token) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', `bridge-token-${name}.json`), JSON.stringify({ name, token }));
}

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  if (v === '0' || v === '1') return v === '1';
  return v;
}

const SERVER = String(arg('server', process.env.AGENT_TAG_SERVER || 'http://127.0.0.1:8091')).replace(/\/$/, '');
const NAME = arg('name') || (console.error('缺少 --name') || process.exit(1));
const CMD = arg('cmd') || (console.error('缺少 --cmd，例如 --cmd "claude -p"') || process.exit(1));
const CWD = arg('cwd') || undefined;
const USE_STDIN = arg('stdin', '1') !== '0'; // --stdin=0 → 任务文本作为最后一个 argv
const TIMEOUT_S = Number(arg('timeout', 240));
const CHANNELS_ARG = arg('channels', '');
const PERSONA = arg('persona', `CLI agent（${CMD}），被 @ 即执行任务并回帖`);
const TOKEN_ARG = String(arg('token', '')); // 服务端 spawn-cli 下发的身份令牌
const INTRO = arg('intro', '1');
const MAXCTX = Number(arg('max-context', 24));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

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

/* ---------- CLI 子进程 ---------- */

let busy = false;
const queue = [];

function runCli(task) {
  return new Promise((resolve) => {
    const started = Date.now();
    log(`▶ 执行任务 ${task.id}（${CMD}）`);
    const child = spawn(CMD, USE_STDIN ? [] : [task.text], {
      shell: true,
      cwd: CWD,
      windowsHide: true,
      env: { ...process.env, AGENT_TAG_FROM: task.from, AGENT_TAG_CHANNEL: task.channelName },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve(`（CLI 启动失败：${e.message}）`));
    const killer = setTimeout(() => {
      log(`✗ 任务 ${task.id} 超时（${TIMEOUT_S}s），终止`);
      try { child.kill('SIGKILL'); } catch {}
      resolve(`（任务超过 ${TIMEOUT_S}s 被终止。已产出内容如下：\n${out.slice(-1500) || '无'}`);
    }, TIMEOUT_S * 1000);
    child.on('close', (code) => {
      clearTimeout(killer);
      log(`■ 任务 ${task.id} 结束，exit=${code}，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
      const text = (out.trim() || err.trim() || '').slice(0, 3500);
      if (!text) return resolve(`（CLI 没有输出，exit=${code}）`);
      resolve(text + (out.trim().length > 3500 ? '\n…（过长已截断）' : ''));
    });
    if (USE_STDIN) {
      child.stdin.write(task.text + '\n');
      child.stdin.end();
    }
  });
}

/* ---------- 主循环 ---------- */

(async () => {
  const reg = await api('/api/register', { name: NAME, kind: 'agent', persona: PERSONA, token: TOKEN_ARG || savedToken(NAME) || undefined });
  const token = reg.token;
  const ME = reg.me || {}; // 含默认技能 skills[]
  rememberToken(NAME, token);
  log(`✓ 已注册 ${NAME} → ${SERVER}${(ME.skills || []).length ? `（默认技能：${ME.skills.join('、')}）` : ''}`);

  const state = await api(`/api/state?token=${encodeURIComponent(token)}`, null, 'GET');
  const channels = state.channels.filter((c) => {
    if (c.type !== 'group') return false;
    if (!CHANNELS_ARG) return true;
    return CHANNELS_ARG.split(',').map((s) => s.trim()).some((k) => k === c.id || k === c.name);
  });
  const byId = new Map(channels.map((c) => [c.id, c]));
  log(`监控群：${channels.map((c) => c.name).join('、') || '（无）'}`);
  if (INTRO) {
    for (const c of channels) {
      await api('/api/messages', { token, channel: c.id, text: `大家好，我是 ${NAME}，底层是 \`${CMD}\`。@我 并直接写任务，我执行完回来回帖。` });
    }
  }

  let cursor = 0;
  for (;;) {
    try {
      const { events = [], cursor: c2, reset } = await api(
        `/api/events?token=${encodeURIComponent(token)}&since=${cursor}&wait=25`, null, 'GET');
      cursor = reset ? (c2 ?? 0) : (c2 ?? cursor);
      for (const evt of events) {
        if (evt.type !== 'message') continue;
        const m = evt.message;
        if (!byId.has(m.channel) || m.from === NAME) continue;
        if (!(m.mentions || []).includes(NAME)) continue;
        // 先回执再干活（学 TagIt/open-tag 的 ack）：CLI 冷启动+推理可达数十秒，静默太久
        api('/api/messages', { token, channel: m.channel, text: `🫡 收到 @${m.from} 的任务，入队执行中（底层 \`${CMD}\`，完成即回帖）` }).catch(() => {});
        api('/api/ack', { token, seq: m.seq }).catch(() => {}); // 认领即「已读」：发送方看到 ✓✓（学 CCCC mail.read）
        // 任务文本 = 原文去 @前缀 + 消息携带技能(#标签)与默认技能的全文注入 + 知识库指引
        const skillNames = [...new Set([...(m.skills || []), ...(ME.skills || [])])];
        let skillBlock = '';
        for (const sn of skillNames) {
          try {
            const r = await api(`/api/skills/${encodeURIComponent(sn)}`, null, 'GET');
            if (r.skill) skillBlock += `\n\n【技能 ${r.skill.name}】\n${r.skill.body}`;
          } catch {}
        }
        const kbHint = `\n\n【共享知识库】团队资料可检索：GET ${SERVER}/api/kb?q=关键词（列表 GET /api/kb，全文 GET /api/kb/条目名），按需自行查询。`;
        queue.push({
          id: m.seq,
          channel: m.channel,
          channelName: byId.get(m.channel).name,
          from: m.from,
          text: (routing.stripMention(m.text, NAME).trim() || '（没有任务描述，请汇报你的能力）')
            + (skillBlock || '') + kbHint,
        });
      }
      // 单并发执行：CLI agent 一般独占一个工作区
      if (!busy && queue.length) {
        busy = true;
        const task = queue.shift();
        await api('/api/typing', { token, channel: task.channel });
        runCli(task).then(async (reply) => {
          await api('/api/messages', { token, channel: task.channel, text: reply }).catch((e) => log('回帖失败:', e.message));
          busy = false;
        });
      }
    } catch (e) {
      log(`轮询异常: ${e.message}`);
      await sleep(2000);
    }
  }
})();
