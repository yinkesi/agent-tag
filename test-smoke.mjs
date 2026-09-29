#!/usr/bin/env node
/**
 * agent-tag 冒烟测试：注册 → 建群 → 发消息 → @TagBot 应答 → 长轮询收 @ → 私聊
 * 前置：server 已启动（node server.js）。会创建带 random 后缀的测试身份，不污染演示数据。
 * 用法：node test-smoke.mjs [baseUrl]
 */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8091';
const rand = Math.random().toString(36).slice(2, 6);
let pass = 0, fail = 0;

function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`agent-tag 冒烟测试 → ${BASE}\n`);

  /* 1. 健康 */
  const h = await api('GET', '/api/health');
  ok(h.status === 200 && h.json.ok, 'GET /api/health');

  /* 2. 注册人 + agent */
  const human = await api('POST', '/api/register', { name: `测试员${rand}`, kind: 'human' });
  ok(human.status === 200 && human.json.token, '注册人类身份');
  const ht = human.json.token;

  const agent = await api('POST', '/api/register', {
    name: `测试机器人${rand}`, kind: 'agent', persona: '冒烟测试', webhookUrl: null,
  });
  ok(agent.status === 200 && agent.json.token, '注册 agent 身份');
  const at = agent.json.token;

  /* 3. 重名拦截 & 持证重登 */
  const dup = await api('POST', '/api/register', { name: `测试员${rand}`, kind: 'human' });
  ok(dup.status === 409, '重名注册返回 409');
  const relog = await api('POST', '/api/register', { name: `测试员${rand}`, kind: 'human', token: ht });
  ok(relog.status === 200, '持证重登成功');

  /* 4. 无效 token */
  const bad = await api('GET', '/api/state', null, 'at_wrong');
  ok(bad.status === 401, '无效 token 返回 401');

  /* 5. 发消息 + @解析 */
  const send = await api('POST', '/api/messages', { channel: 'general', text: `@TagBot 帮助 @${agent.json.me.name} 看一眼` }, ht);
  ok(send.status === 200, '发消息（含两个 @）');
  ok(send.json.message.mentions.includes('TagBot') && send.json.message.mentions.includes(`测试机器人${rand}`),
    '服务端 @ 解析正确', JSON.stringify(send.json.message.mentions));

  /* 6. TagBot 规则应答 */
  await sleep(2400);
  const msgs = await api('GET', `/api/messages?channel=general&limit=5`, null, ht);
  const botReply = msgs.json.messages.find((m) => m.from === 'TagBot' && m.ts > send.json.message.ts);
  ok(!!botReply, 'TagBot 在 ~2s 内应答', JSON.stringify(msgs.json.messages.map((m) => m.from)));

  /* 7. agent 长轮询收到对自己的 @ */
  const poll = await api('GET', `/api/events?token=${at}&since=0&wait=0`);
  const mentionEvt = poll.json.events.find((e) => e.type === 'message' && (e.message.mentions || []).includes(`测试机器人${rand}`));
  ok(!!mentionEvt, 'agent 长轮询收到 @ 事件');

  /* 8. 建群 + 频道隔离 */
  const grp = await api('POST', '/api/channels', { name: `测试群${rand}` }, ht);
  ok(grp.status === 200 && grp.json.channel.type === 'group', '创建群聊');
  const gmsg = await api('POST', '/api/messages', { channel: grp.json.channel.id, text: '群里好' }, at);
  ok(gmsg.status === 200, 'agent 在新群发言（自动入群）');

  /* 9. 私聊：互不可见第三方 */
  const dm = await api('POST', '/api/channels', { type: 'dm', dmWith: `测试机器人${rand}` }, ht);
  ok(dm.status === 200 && dm.json.channel.type === 'dm', '建立私聊');
  await api('POST', '/api/messages', { channel: dm.json.channel.id, text: '悄悄话' }, ht);
  const other = await api('POST', '/api/register', { name: `路人${rand}`, kind: 'human' });
  const peek = await api('GET', `/api/messages?channel=${encodeURIComponent(dm.json.channel.id)}&limit=10`, null, other.json.token);
  ok(peek.status === 403, '第三方读私聊被 403 拒绝');

  /* 10. 静态页面 */
  const page = await fetch(BASE + '/');
  ok(page.status === 200 && (await page.text()).includes('Agent Tag'), 'GET / 返回前端页面');

  /* 11. 上下文隔离：agent 默认 mentions，读不到别人的群消息 */
  const iso = await api('POST', '/api/register', { name: `隔离员${rand}`, kind: 'agent', persona: '隔离测试' });
  ok(iso.json.me.context === 'mentions', 'agent 注册默认上下文 = mentions');
  await api('POST', '/api/messages', { channel: 'general', text: `给${rand}的无关闲聊，谁都不@` }, ht);
  const isoRead = await api('GET', `/api/messages?channel=general&limit=50`, null, iso.json.token);
  const leaked = isoRead.json.messages.some((m) => m.kind === 'text' && m.from !== `隔离员${rand}`
    && !(m.mentions || []).includes(`隔离员${rand}`));
  ok(!leaked, 'mentions agent 群历史里没有无关消息');

  /* 12. channel 上下文的 agent 可读全群；human 永远全量 */
  const wide = await api('POST', '/api/register', { name: `全览员${rand}`, kind: 'agent', context: 'channel' });
  const wideRead = await api('GET', `/api/messages?channel=general&limit=50`, null, wide.json.token);
  ok(wideRead.json.messages.some((m) => m.kind === 'text' && m.from !== `全览员${rand}`), 'channel 上下文 agent 可读全群');
  const humanRead = await api('GET', `/api/messages?channel=general&limit=50`, null, ht);
  ok(humanRead.json.messages.some((m) => m.kind === 'text' && m.from !== human.json.me.name), '人类可读全群');

  /* 13. 事件流同样隔离：mentions agent 收不到别人的消息事件 */
  const isoCursor = (await api('GET', '/api/health')).json.seq;
  await api('POST', '/api/messages', { channel: 'general', text: '又一条无人@的群聊' }, ht);
  await api('POST', '/api/messages', { channel: 'general', text: `@隔离员${rand} 这条给你` }, ht);
  await sleep(400);
  const evtRead = await api('GET', `/api/events?token=${iso.json.token}&since=${isoCursor}&wait=0`);
  const evtMsgs = evtRead.json.events.filter((e) => e.type === 'message');
  ok(evtMsgs.some((e) => (e.message.mentions || []).includes(`隔离员${rand}`)), '事件流收到 @ 自己的消息');
  ok(!evtMsgs.some((e) => e.message.kind === 'text' && e.message.from === human.json.me.name
    && !(e.message.mentions || []).includes(`隔离员${rand}`)), '事件流不泄露无关消息');

  /* 14. 撤回（微信语义：本人、2 分钟内、正文抹除） */
  const mine = await api('POST', '/api/messages', { channel: 'general', text: '这句话马上会被撤回' }, ht);
  const foreign = await api('POST', '/api/messages', { channel: 'general', text: `@测试员${rand} 别人的消息` }, agent.json.token);
  const rc1 = await api('POST', '/api/messages/recall', { seq: foreign.json.message.seq }, ht);
  ok(rc1.status === 403, '不能撤回别人的消息');
  const rc2 = await api('POST', '/api/messages/recall', { seq: mine.json.message.seq }, ht);
  ok(rc2.status === 200, '本人撤回自己的消息');
  const after = await api('GET', `/api/messages?channel=general&limit=10`, null, ht);
  const recalledMsg = after.json.messages.find((m) => m.seq === mine.json.message.seq);
  ok(recalledMsg?.recalled === true && recalledMsg.text === '', '撤回后正文已从历史抹除');

  /* 15. 引用回复：replyTo 落库可查；撤回后的消息不可再被引用 */
  const target = await api('POST', '/api/messages', { channel: 'general', text: '这条用来被引用' }, ht);
  const rep = await api('POST', '/api/messages', { channel: 'general', text: '引用你刚才的话', replyTo: target.json.message.seq }, ht);
  ok(rep.status === 200 && rep.json.message.replyTo === target.json.message.seq, '引用回复带 replyTo');
  const badRep = await api('POST', '/api/messages', { channel: 'general', text: '引用已撤回的', replyTo: mine.json.message.seq }, ht);
  ok(badRep.status === 404, '引用已撤回的消息被拒绝');

  /* 16. 群可见性（微信邀请制语义）：私有群非成员不可见不可读 */
  const priv = await api('POST', '/api/channels', { name: `私密群${rand}`, members: [] }, ht);
  ok(priv.json.channel.isPublic === false, '新建群默认邀请制');
  await api('POST', '/api/messages', { channel: priv.json.channel.id, text: '机密内容' }, ht);
  const outsider = await api('GET', `/api/messages?channel=${encodeURIComponent(priv.json.channel.id)}`, null, other.json.token);
  ok(outsider.status === 403, '非成员读私有群被拒');
  const outsiderState = await api('GET', '/api/state', null, other.json.token);
  ok(!outsiderState.json.channels.some((c) => c.id === priv.json.channel.id), '非成员的会话列表看不到私有群');
  const joinTry = await api('POST', `/api/channels/${priv.json.channel.id}/join`, {}, other.json.token);
  ok(joinTry.status === 403, '私有群不能自行加入');

  /* 17. 手动添加 agent + 离线托管应答（autoReply） */
  const manual = await api('POST', '/api/register', {
    name: `手办${rand}`, kind: 'agent', persona: '网页手动添加', autoReply: true,
  });
  ok(manual.json.me.autoReply === true, '手动添加 agent 带 autoReply 标记');
  const before = (await api('GET', '/api/health')).json.seq;
  await api('POST', '/api/messages', { channel: 'general', text: `@手办${rand} 帮我订个会议室` }, ht);
  await sleep(2000);
  const mRead = await api('GET', `/api/messages?channel=general&limit=4`, null, ht);
  const guard = mRead.json.messages.find((m) => m.from === `手办${rand}`);
  ok(!!guard && guard.text.includes('离线托管应答') && guard.text.includes('帮我订个会议室'), '离线托管应答生效（含任务回显）');

  /* 18. 改名（级联 + 权限 + TagBot 禁改） */
  const renAgent = await api('POST', '/api/register', { name: `旧名${rand}`, kind: 'agent' });
  const rt = renAgent.json.token;
  const oldName = `旧名${rand}`, newName = `新名${rand}`;
  await api('POST', '/api/messages', { channel: 'general', text: `@${oldName} 存一条会被改名的消息` }, ht);
  // TagBot 禁改
  const tb = await api('POST', '/api/agents/rename', { from: 'TagBot', to: 'TagBot2' }, ht);
  ok(tb.status === 400, 'TagBot 禁止改名');
  // agent 不能改别人
  const other2 = await api('POST', '/api/register', { name: `旁人${rand}`, kind: 'agent' });
  const noPerm = await api('POST', '/api/agents/rename', { from: oldName, to: newName }, other2.json.token);
  ok(noPerm.status === 403, 'agent 不能改别人的名字');
  // 重名拒绝
  const dup2 = await api('POST', '/api/agents/rename', { from: oldName, to: 'gbc' }, ht);
  ok(dup2.status === 409, '改成已占用名字返回 409');
  // 人类改 agent：级联生效
  const rn = await api('POST', '/api/agents/rename', { from: oldName, to: newName }, ht);
  ok(rn.status === 200, '人类改名 agent 成功');
  const st2 = await api('GET', '/api/state', null, ht);
  ok(st2.json.agents.some((a) => a.name === newName) && !st2.json.agents.some((a) => a.name === oldName), '名册已切换到新名字');
  const gen = st2.json.channels.find((c) => c.id === 'general');
  ok(gen.members.includes(newName) && !gen.members.includes(oldName), '群成员表跟随新名字');
  const hist = await api('GET', `/api/messages?channel=general&limit=50`, null, ht);
  const m1 = hist.json.messages.find((m) => m.text === `@${oldName} 存一条会被改名的消息`);
  ok(m1 && m1.from === human.json.me.name && m1.mentions.includes(newName), '历史消息 mentions 已重写为新名字');
  // @新名字能派活；旧名字能被重新注册
  const s2 = await api('POST', '/api/messages', { channel: 'general', text: `@${newName} 你好` }, ht);
  ok(s2.json.message.mentions.includes(newName), '@ 解析识别新名字');
  const reclaim = await api('POST', '/api/register', { name: oldName, kind: 'agent' });
  ok(reclaim.status === 200, '旧名字改名后可被重新注册');
  // rename 事件广播
  const rnSeq = (await api('GET', '/api/health')).json.seq;
  await api('POST', '/api/agents/rename', { from: `旁人${rand}`, to: `旁改${rand}` }, ht);
  const ev2 = await api('GET', `/api/events?token=${encodeURIComponent(ht)}&since=${rnSeq}&wait=0`);
  ok(ev2.json.events.some((e) => e.type === 'rename'), 'rename 事件已广播');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(1); });
