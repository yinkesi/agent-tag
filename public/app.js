/* Agent Tag 网页端：SSE 实时、@ 派活、通讯录与 API 接入面板 */
'use strict';

const $ = (s) => document.querySelector(s);

const S = {
  token: null, me: null,
  agents: new Map(),          // name -> agent
  channels: new Map(),        // id -> channel
  msgs: new Map(),            // channelId -> [message]
  unread: new Map(),          // channelId -> n
  typing: new Map(),          // channelId -> Map(name -> expiryTs)
  active: null,
  tab: 'chats',
  es: null,
  bootSeq: 0,                 // 进入时刻的事件水位，之前的算历史，不计未读
  replyTo: null,              // 引用回复目标（微信引用语义）
};

const API = location.origin;

/* ---------- 工具 ---------- */

function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function hueGrad(hue, circle) {
  return `background:linear-gradient(135deg,hsl(${hue},68%,55%),hsl(${hue},74%,38%))`;
}

function avatarEl(name, hue, cls = '') {
  const d = document.createElement('div');
  d.className = 'avatar ' + cls;
  d.style.cssText = hueGrad(hue);
  d.textContent = [...String(name)][0].toUpperCase();
  return d;
}

function onlineDot(agent) {
  const i = document.createElement('i');
  i.className = 'dot-online' + (agent?.online ? '' : ' dot-offline');
  return i;
}

function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return '昨天';
  if (now - ts < 6 * 86400e3) return '周' + '日一二三四五六'[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtFull(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (S.token) headers.authorization = 'Bearer ' + S.token;
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) { logout(); }
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

/* ---------- 登录 ---------- */

let loginKind = 'human';

function initLogin() {
  const overlay = $('#loginOverlay');
  overlay.classList.remove('hidden');
  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      loginKind = b.dataset.kind;
      $('#loginPersona').classList.toggle('hidden', loginKind !== 'agent');
      $('#loginName').placeholder = loginKind === 'agent' ? 'agent 名字（如：翻译机器人）' : '名字（如：阿明）';
    };
  });
  const submit = async () => {
    const name = $('#loginName').value.trim();
    if (!name) return $('#loginName').focus();
    const btn = $('#loginBtn');
    btn.disabled = true; btn.textContent = '接入中…';
    try {
      const body = { name, kind: loginKind };
      if (loginKind === 'agent') body.persona = $('#loginPersona').value.trim();
      const saved = JSON.parse(localStorage.getItem('agent-tag-me') || 'null');
      if (saved && saved.name === name) body.token = saved.token; // 持证重登
      const { token, me } = await api('/api/register', { method: 'POST', body: JSON.stringify(body) });
      localStorage.setItem('agent-tag-me', JSON.stringify({ name, token }));
      enter({ token, me });
    } catch (e) {
      toast(e.message);
      btn.disabled = false; btn.textContent = '进入';
    }
  };
  $('#loginBtn').onclick = submit;
  $('#loginName').onkeydown = (e) => e.key === 'Enter' && submit();
  $('#loginPersona').onkeydown = (e) => e.key === 'Enter' && submit();
}

function logout() {
  localStorage.removeItem('agent-tag-me');
  location.reload();
}

/* ---------- 进入主界面 ---------- */

async function enter({ token, me }) {
  S.token = token; S.me = me;
  $('#loginOverlay').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const rail = $('#railMe');
  rail.innerHTML = '';
  rail.appendChild(avatarEl(me.name, me.hue));
  rail.onclick = logout;

  await refreshState();
  connectStream();
  switchTab('chats');
  renderApiPanel();

  const first = [...S.channels.values()].sort((a, b) => (a.id === 'general' ? -1 : b.id === 'general' ? 1 : 0))[0];
  if (first) openChannel(first.id);
}

async function refreshState() {
  const st = await api('/api/state');
  S.me = st.me;
  if (st.seq) S.bootSeq = Math.max(S.bootSeq, st.seq);
  S.agents.clear();
  for (const a of st.agents) S.agents.set(a.name, a);
  S.channels.clear();
  for (const c of st.channels) S.channels.set(c.id, c);
  renderConvList();
  renderContactList();
}

/* ---------- SSE ---------- */

function connectStream() {
  if (S.es) S.es.close();
  const es = new EventSource(`${API}/api/stream?token=${encodeURIComponent(S.token)}`);
  S.es = es;
  const pill = $('#connPill');
  es.onopen = async () => {
    pill.classList.add('on'); pill.innerHTML = '<i></i>已连接';
    // 断线重连后做一次全量校准，防止事件环冲刷导致漏消息
    await refreshState();
    if (S.active) loadMessages(S.active, true);
  };
  es.onerror = () => {
    pill.classList.remove('on'); pill.innerHTML = '<i></i>重连中';
  };
  es.onmessage = (e) => {
    const evt = JSON.parse(e.data);
    handleEvent(evt);
  };
}

function applyRename(from, to) {
  // 本地缓存跟着换：自己身份、消息缓存（发言者/mentions）、会话预览
  if (S.me.name === from) S.me.name = to;
  for (const [, list] of S.msgs) {
    for (const m of list) {
      if (m.from === from) m.from = to;
      if (m.mentions) m.mentions = m.mentions.map((n) => (n === from ? to : n));
    }
  }
  for (const [, p] of previews) if (p.from === from) p.from = to;
  refreshState().then(() => {
    renderConvList();
    renderContactList();
    if (S.active) renderMessages();
    updateTitleBadge();
  });
}

function handleEvent(evt) {
  if (evt.type === 'message') {
    const m = evt.message;
    upsertMessage(m);
    S.typing.get(m.channel)?.delete(m.from); // 对方已发声，正在输入状态即失效
    if (m.channel === S.active) renderTyping();
    const ch = S.channels.get(m.channel);
    if (ch && (ch.type === 'group' || ch.members.includes(S.me.name))) {
      if (m.channel === S.active) {
        scrollBottomIfNeeded();
      } else if (m.from !== S.me.name && evt.seq > S.bootSeq) {
        // 只把「进入之后」发生的新消息计为未读，SSE 重放的历史不算
        S.unread.set(m.channel, (S.unread.get(m.channel) || 0) + 1);
      }
      renderConvList();
      updateTitleBadge();
    }
    if (m.mentions?.includes(S.me.name) && m.from !== S.me.name) toast(`${m.from} 在群里 @ 了你`);
  } else if (evt.type === 'typing') {
    if (evt.from === S.me.name) return;
    if (!S.typing.has(evt.channel)) S.typing.set(evt.channel, new Map());
    S.typing.get(evt.channel).set(evt.from, Date.now() + 4000);
    if (evt.channel === S.active) renderTyping();
  } else if (evt.type === 'recall') {
    // 有人撤回：本地同步抹除正文；若撤的是最新一条，回退会话预览
    for (const [cid, list] of S.msgs) {
      if (cid !== evt.channel) continue;
      const m = list.find((x) => x.seq === evt.seq);
      if (m && !m.recalled) { m.recalled = true; m.text = ''; m.mentions = []; }
      if (cid === S.active) renderMessages(); // 撤回要即时可见，不走 rAF 批（后台标签页 rAF 会冻结）
      const p = previews.get(cid);
      if (p && p.seq === evt.seq) {
        const prev = [...list].reverse().find((x) => x.seq < evt.seq && !x.recalled && x.kind !== 'system');
        previews.set(cid, prev ? { text: prev.text.replace(/\n/g, ' '), ts: prev.ts, from: prev.from, seq: prev.seq } : { text: '', ts: 0, from: '' });
        renderConvList();
      }
    }
  } else if (evt.type === 'rename') {
    applyRename(evt.from, evt.to);
  } else if (evt.type === 'presence') {
    const a = S.agents.get(evt.name);
    if (a) { a.online = evt.online; renderContactList(); renderConvList(); }
  } else if (evt.type === 'channel') {
    const c = evt.channel;
    if (c.type === 'dm' && !c.members.includes(S.me.name)) return;
    S.channels.set(c.id, c);
    renderConvList();
  }
}

/* ---------- 会话列表 ---------- */

function pinnedIds() {
  try { return JSON.parse(localStorage.getItem('agent-tag-pinned') || '[]'); } catch { return []; }
}

function sortedChannels() {
  const pinned = pinnedIds();
  const last = (id) => {
    const list = S.msgs.get(id);
    if (list && list.length) return list[list.length - 1].ts;
    return S.channels.get(id)?.createdAt || 0;
  };
  return [...S.channels.values()].sort((a, b) => {
    // 微信语义：置顶会话永远在最前
    const pa = pinned.includes(a.id) ? 1 : 0, pb = pinned.includes(b.id) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (previewOf(b.id).ts || 0) - (previewOf(a.id).ts || 0) || last(b.id) - last(a.id);
  });
}

const previews = new Map(); // channelId -> {text, ts, from}
function previewOf(id) {
  return previews.get(id) || { text: '', ts: 0, from: '' };
}

function renderConvList() {
  const box = $('#chatList');
  const kw = $('#searchInput').value.trim().toLowerCase();
  box.innerHTML = '';
  const chans = sortedChannels().filter((c) => {
    if (!kw) return true;
    const p = previewOf(c.id).text.toLowerCase();
    return c.name.toLowerCase().includes(kw) || p.includes(kw);
  });
  if (!chans.length) {
    box.innerHTML = `<div class="empty-hint"><div class="big">💬</div>没有匹配的会话</div>`;
    return;
  }
  const pinned = pinnedIds();
  for (const c of chans) {
    const row = document.createElement('div');
    row.className = 'conv' + (c.id === S.active ? ' active' : '');
    const p = previewOf(c.id);
    const isGroup = c.type === 'group';
    const hue = isGroup ? hashHue(c.id) : (S.agents.get(c.name)?.hue ?? 220);
    const av = avatarEl(isGroup ? c.name : c.name, hue);
    if (!isGroup) av.classList.add('circle');
    if (!isGroup) av.appendChild(onlineDot(S.agents.get(c.name)));

    const body = document.createElement('div');
    body.className = 'conv-body';
    const top = document.createElement('div');
    top.className = 'conv-top';
    const nm = document.createElement('span');
    nm.className = 'conv-name';
    nm.textContent = isGroup ? c.name : c.name;
    if (isGroup && !c.isPublic) {
      const lock = document.createElement('span');
      lock.className = 'lock-chip';
      lock.title = '邀请制群聊：仅成员可见';
      lock.textContent = '🔒';
      nm.appendChild(lock);
    }
    if (pinned.includes(c.id)) {
      const pin = document.createElement('span');
      pin.className = 'pin-chip';
      pin.title = '已置顶';
      pin.textContent = '📌';
      nm.appendChild(pin);
    }
    const tm = document.createElement('span');
    tm.className = 'conv-time';
    tm.textContent = p.ts ? fmtTime(p.ts) : '';
    top.append(nm, tm);
    const pv = document.createElement('div');
    pv.className = 'conv-preview';
    pv.textContent = p.text ? (p.from && p.from !== S.me.name && isGroup ? `${p.from}：${p.text}` : p.text) : (isGroup ? c.topic || '暂无消息' : '打个招呼吧');
    body.append(top, pv);

    const unread = S.unread.get(c.id);
    row.append(av, body);
    if (unread) {
      const b = document.createElement('span');
      b.className = 'conv-unread';
      b.textContent = unread > 99 ? '99+' : unread;
      row.appendChild(b);
    }
    row.onclick = () => openChannel(c.id);
    // 微信语义：右键会话 → 置顶 / 取消置顶
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showConvMenu(e.clientX, e.clientY, c.id);
    };
    box.appendChild(row);
  }
}

function hashHue(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

function showConvMenu(x, y, channelId) {
  document.querySelectorAll('.popover').forEach((p) => p.remove());
  const pinned = pinnedIds();
  const isPinned = pinned.includes(channelId);
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.left = Math.min(x, innerWidth - 220) + 'px';
  pop.style.top = Math.min(y, innerHeight - 120) + 'px';
  const item = document.createElement('div');
  item.className = 'contact';
  item.style.cursor = 'pointer';
  item.textContent = isPinned ? '📍 取消置顶' : '📌 置顶聊天';
  item.onclick = () => {
    const next = isPinned ? pinned.filter((id) => id !== channelId) : [...pinned, channelId];
    localStorage.setItem('agent-tag-pinned', JSON.stringify(next));
    pop.remove();
    renderConvList();
  };
  pop.appendChild(item);
  document.body.appendChild(pop);
  const dismiss = (ev) => { if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('click', dismiss); } };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
}

/* ---------- 消息区 ---------- */

async function openChannel(id) {
  S.active = id;
  S.unread.delete(id);
  cancelReply();
  const ch = S.channels.get(id);
  if (!ch) return;
  $('#chatpane').classList.remove('empty');
  $('#chatTitle').textContent = ch.name;
  $('#chatSub').textContent = ch.type === 'dm'
    ? (S.agents.get(ch.name)?.persona || (S.agents.get(ch.name)?.online ? '在线' : '离线'))
    : `${ch.topic ? ch.topic + ' · ' : ''}${ch.members.length} 名成员`;
  renderConvList();
  updateTitleBadge();
  await loadMessages(id, true);
  $('#inputBox').focus();
}

async function loadMessages(id, force) {
  const data = await api(`/api/messages?channel=${encodeURIComponent(id)}&limit=60`);
  S.msgs.set(id, data.messages);
  for (const m of data.messages) {
    previews.set(m.channel, { text: m.kind === 'system' ? m.text : m.text.replace(/\n/g, ' '), ts: m.ts, from: m.from, seq: m.seq });
  }
  renderConvList();
  renderMessages();
  scrollBottom(true);
}

function renderMessages() {
  const list = S.msgs.get(S.active) || [];
  const sc = $('#msgScroll');
  const box = $('#msgList');
  // 全量重建会把 scrollTop 重置为 0（用户会看到"莫名滚到顶"）。
  // 渲染前记位置：贴底 → 渲染后仍贴底；正在翻历史 → 原地不动。
  const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
  const prevTop = sc.scrollTop;
  box.innerHTML = '';
  let lastDay = '', lastFrom = null, lastTs = 0;
  for (const m of list) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) {
      const div = document.createElement('div');
      div.className = 'time-divider';
      div.textContent = dayDivLabel(m.ts);
      box.appendChild(div);
      lastDay = day; lastFrom = null;
    }
    if (m.kind === 'system') {
      const s = document.createElement('div');
      s.className = 'sysmsg';
      s.textContent = m.text;
      box.appendChild(s);
      lastFrom = null;
      continue;
    }
    renderMsg(box, m, m.from === lastFrom && m.ts - lastTs < 5 * 60e3);
    lastFrom = m.from; lastTs = m.ts;
  }
  // 恢复滚动位置（见函数开头注释）；scroll-behavior:smooth 会把赋值变成动画，
  // 动画中途的 atBottom 判断会失真——恢复时必须瞬时
  sc.style.scrollBehavior = 'auto';
  if (atBottom) sc.scrollTop = sc.scrollHeight;
  else if (prevTop > 0) sc.scrollTop = Math.min(prevTop, Math.max(sc.scrollHeight - sc.clientHeight, 0));
  sc.style.scrollBehavior = '';
  renderTyping();
}

function dayDivLabel(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天 ' + fmtClock(ts);
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return '昨天 ' + fmtClock(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${fmtClock(ts)}`;
}

function renderMsg(box, m, merged) {
  const mine = m.from === S.me.name;
  const agent = S.agents.get(m.from);

  // 微信语义：撤回后只留一条提示，正文抹除
  if (m.recalled) {
    const s = document.createElement('div');
    s.className = 'sysmsg';
    s.textContent = `「${m.from}」撤回了一条消息`;
    s.dataset.seq = m.seq;
    box.appendChild(s);
    return;
  }

  const row = document.createElement('div');
  row.className = 'msg' + (mine ? ' mine' : '');
  row.dataset.seq = m.seq;

  if (!merged) {
    const av = avatarEl(m.from, m.hue, 'sm');
    row.appendChild(av);
  } else {
    const pad = document.createElement('div');
    pad.style.width = '34px'; pad.style.flex = 'none';
    row.appendChild(pad);
  }

  const body = document.createElement('div');
  body.className = 'msg-body';

  if (!mine && !merged) {
    const sender = document.createElement('div');
    sender.className = 'msg-sender';
    sender.style.color = `hsl(${m.hue},80%,72%)`;
    sender.textContent = m.from;
    if (m.fromKind === 'bot' || m.fromKind === 'agent') {
      const chip = document.createElement('span');
      chip.className = 'kind-chip ' + (m.fromKind === 'bot' ? 'bot' : 'agent');
      chip.textContent = m.fromKind === 'bot' ? 'BOT' : 'AGENT';
      sender.appendChild(chip);
    }
    body.appendChild(sender);
  }

  // 引用块（微信语义：显示被回复者与摘要，点击定位原消息）
  if (m.replyTo) {
    const q = document.createElement('div');
    q.className = 'quote';
    const src = (S.msgs.get(S.active) || []).find((x) => x.seq === m.replyTo);
    q.textContent = src
      ? `${src.from}：${String(src.recalled ? '原消息已撤回' : src.text).replace(/\n/g, ' ').slice(0, 40)}`
      : '查看引用消息';
    q.title = '点击定位原消息';
    q.onclick = () => {
      const el = document.querySelector(`.msg[data-seq="${m.replyTo}"], .sysmsg[data-seq="${m.replyTo}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.transition = 'background 200ms ease';
        el.style.background = 'rgba(10,132,255,0.15)';
        setTimeout(() => { el.style.background = ''; }, 900);
      }
    };
    body.appendChild(q);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.title = fmtFull(m.ts);
  if (m.pending) bubble.style.opacity = '0.55'; // 乐观渲染未确认态
  fillBubbleText(bubble, m.text);
  body.appendChild(bubble);

  const t = document.createElement('div');
  t.className = 'msg-time';
  t.textContent = fmtClock(m.ts);
  body.appendChild(t);

  // hover 操作条（引用 / 撤回——撤回限本人 2 分钟内，微信语义）
  const acts = document.createElement('div');
  acts.className = 'msg-actions';
  const quoteBtn = document.createElement('button');
  quoteBtn.type = 'button';
  quoteBtn.title = '引用回复';
  quoteBtn.textContent = '↩';
  quoteBtn.onclick = () => startReply(m);
  acts.appendChild(quoteBtn);
  if (mine && !m.recalled && Date.now() - m.ts < 2 * 60_000) {
    const recallBtn = document.createElement('button');
    recallBtn.type = 'button';
    recallBtn.title = '撤回（2 分钟内）';
    recallBtn.textContent = '✕';
    recallBtn.onclick = () => recallMessage(m);
    acts.appendChild(recallBtn);
  }
  row.appendChild(acts);

  row.appendChild(body);
  box.appendChild(row);
}

function startReply(m) {
  S.replyTo = { seq: m.seq, from: m.from, text: String(m.recalled ? '原消息已撤回' : m.text).slice(0, 60) };
  const bar = $('#replyBar');
  bar.classList.remove('hidden');
  $('#replyPreview').textContent = `回复 ${m.from}：${S.replyTo.text}`;
  inputBox.focus();
}

function cancelReply() {
  S.replyTo = null;
  $('#replyBar').classList.add('hidden');
}

async function recallMessage(m) {
  try {
    await api('/api/messages/recall', { method: 'POST', body: JSON.stringify({ seq: m.seq }) });
    m.recalled = true; m.text = '';
    renderMessagesIfActive();
    toast('已撤回');
  } catch (e) { toast(e.message); }
}

function fillBubbleText(bubble, text) {
  const names = [...S.agents.keys()].sort((a, b) => b.length - a.length).map(esc);
  if (!names.length) { bubble.textContent = text; return; }
  const re = new RegExp(`@(${names.join('|')})`, 'g');
  let lastIdx = 0, m2;
  while ((m2 = re.exec(text))) {
    if (m2.index > lastIdx) bubble.appendChild(document.createTextNode(text.slice(lastIdx, m2.index)));
    const chip = document.createElement('span');
    chip.className = 'mention';
    chip.textContent = m2[0];
    bubble.appendChild(chip);
    lastIdx = m2.index + m2[0].length;
  }
  if (lastIdx < text.length) bubble.appendChild(document.createTextNode(text.slice(lastIdx)));
}

function scrollBottom(instant) {
  const sc = $('#msgScroll');
  if (instant) sc.scrollTop = sc.scrollHeight;
  else sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
}

function scrollBottomIfNeeded() {
  const sc = $('#msgScroll');
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
  renderMessages();
  if (nearBottom) scrollBottom(false);
}

function upsertMessage(m) {
  const list = S.msgs.get(m.channel);
  if (list) {
    if (!list.some((x) => x.seq === m.seq)) {
      list.push(m);
      list.sort((a, b) => a.seq - b.seq);
    }
    if (m.channel === S.active) {
      if (list.some((x) => x.seq === m.seq)) renderMessagesIfActive(m);
    }
  }
  previews.set(m.channel, { text: m.kind === 'system' ? m.text : m.text.replace(/\n/g, ' '), ts: m.ts, from: m.from });
}

let renderPending = false;
function renderMessagesIfActive() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; renderMessages(); });
}

/* ---------- 正在输入 ---------- */

function renderTyping() {
  const line = $('#typingLine');
  const map = S.typing.get(S.active);
  const now = Date.now();
  const names = [];
  if (map) {
    for (const [n, exp] of map) {
      if (exp < now) map.delete(n);
      else names.push(n);
    }
  }
  line.textContent = names.length ? `${names.join('、')} 正在输入…` : '';
  renderTypingBubble(names);
}

function renderTypingBubble(names) {
  document.querySelectorAll('.typing-row').forEach((e) => e.remove());
  if (!names.length) return;
  const ch = S.channels.get(S.active);
  const agent = S.agents.get(names[0]);
  const row = document.createElement('div');
  row.className = 'typing-row';
  const av = avatarEl(names[0], agent?.hue ?? 220, 'sm');
  const bub = document.createElement('div');
  bub.className = 'typing-bubble';
  bub.innerHTML = '<i></i><i></i><i></i>';
  row.append(av, bub);
  $('#msgList').appendChild(row);
  const sc = $('#msgScroll');
  // 只有本来就贴底才跟随（翻历史时不被 typing 气泡拽到底部）
  if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160) sc.scrollTop = sc.scrollHeight;
}

setInterval(() => { if (S.active && S.typing.get(S.active)?.size) renderTyping(); }, 1500);

/* ---------- 输入框与 @ 补全 ---------- */

const inputBox = $('#inputBox');

function autosize() {
  inputBox.style.height = 'auto';
  inputBox.style.height = Math.min(inputBox.scrollHeight, 140) + 'px';
}

let lastTypingSent = 0;
inputBox.addEventListener('input', () => {
  autosize();
  $('#sendBtn').disabled = !inputBox.value.trim();
  if (Date.now() - lastTypingSent > 2500 && S.active && inputBox.value) {
    lastTypingSent = Date.now();
    api('/api/typing', { method: 'POST', body: JSON.stringify({ channel: S.active }) }).catch(() => {});
  }
  updateMentionPop();
});

inputBox.addEventListener('keydown', (e) => {
  const pop = $('#mentionPop');
  if (!pop.classList.contains('hidden')) {
    const items = [...pop.querySelectorAll('.mention-item')];
    const sel = items.findIndex((x) => x.classList.contains('sel'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? (sel + 1) % items.length : (sel - 1 + items.length) % items.length;
      items.forEach((x) => x.classList.remove('sel'));
      items[next]?.classList.add('sel');
      items[next]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && sel >= 0) {
      e.preventDefault();
      items[sel].click();
      return;
    }
    if (e.key === 'Escape') { pop.classList.add('hidden'); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

function mentionQuery() {
  const pos = inputBox.selectionStart;
  const before = inputBox.value.slice(0, pos);
  const m2 = before.match(/@([^\s@]*)$/);
  return m2 ? { query: m2[1], start: pos - m2[0].length, caret: pos } : null;
}

function updateMentionPop() {
  const pop = $('#mentionPop');
  const q = mentionQuery();
  if (!q) { pop.classList.add('hidden'); return; }
  const ch = S.channels.get(S.active);
  const members = ch ? ch.members.filter((n) => n !== S.me.name) : [];
  const hit = members
    .filter((n) => n.toLowerCase().includes(q.query.toLowerCase()))
    .sort((a, b) => (S.agents.get(b)?.online - S.agents.get(a)?.online))
    .slice(0, 8);
  if (!hit.length) { pop.classList.add('hidden'); return; }
  pop.innerHTML = '';
  hit.forEach((n, i) => {
    const a = S.agents.get(n);
    const it = document.createElement('button');
    it.type = 'button';
    it.className = 'mention-item' + (i === 0 ? ' sel' : '');
    it.append(avatarEl(n, a?.hue ?? 220, 'sm'), Object.assign(document.createElement('span'), { className: 'mi-name', textContent: n }),
      Object.assign(document.createElement('span'), { className: 'mi-persona', textContent: a?.persona || (a?.kind === 'human' ? '人类' : '') }));
    if (a) it.children[0].appendChild(onlineDot(a));
    it.onclick = () => insertMention(n, q);
    pop.appendChild(it);
  });
  pop.classList.remove('hidden');
}

function insertMention(name, q) {
  const v = inputBox.value;
  inputBox.value = v.slice(0, q.start) + '@' + name + ' ' + v.slice(q.caret);
  const pos = q.start + name.length + 2;
  inputBox.setSelectionRange(pos, pos);
  inputBox.focus();
  $('#mentionPop').classList.add('hidden');
  autosize();
  $('#sendBtn').disabled = !inputBox.value.trim();
}

$('#atBtn').onclick = () => {
  const v = inputBox.value;
  const pos = inputBox.selectionStart ?? v.length;
  inputBox.value = v.slice(0, pos) + '@' + v.slice(pos);
  inputBox.setSelectionRange(pos + 1, pos + 1);
  inputBox.focus();
  updateMentionPop();
};

function parseMentionsLocal(text) {
  const out = [];
  for (const n of [...S.agents.keys()].sort((a, b) => b.length - a.length)) {
    if (text.includes('@' + n)) out.push(n);
  }
  return out;
}

async function send() {
  const text = inputBox.value.trim();
  if (!text || !S.active) return;
  const cid = S.active;
  inputBox.value = ''; autosize();
  $('#sendBtn').disabled = true;
  $('#mentionPop').classList.add('hidden');

  // 乐观渲染：气泡立刻出现，服务器确认后换正式 seq（苹果式即时反馈）
  const tmp = {
    seq: 'tmp_' + Date.now(), channel: cid, from: S.me.name, kind: 'text',
    text, mentions: parseMentionsLocal(text), ts: Date.now(),
    fromKind: S.me.kind, hue: S.me.hue, pending: true,
    replyTo: S.replyTo?.seq,
  };
  upsertMessage(tmp);
  renderMessagesIfActive(); scrollBottomIfNeeded(); renderConvList();

  try {
    const payload = { channel: cid, text };
    if (S.replyTo) payload.replyTo = S.replyTo.seq;
    const { message } = await api('/api/messages', { method: 'POST', body: JSON.stringify(payload) });
    cancelReply();
    const list = S.msgs.get(cid);
    if (list) {
      const i = list.findIndex((x) => x.seq === tmp.seq);
      if (i !== -1) list.splice(i, 1);
    }
    upsertMessage(message);
    renderMessagesIfActive(); scrollBottomIfNeeded(); renderConvList();
  } catch (e) {
    const list = S.msgs.get(cid);
    if (list) {
      const i = list.findIndex((x) => x.seq === tmp.seq);
      if (i !== -1) list.splice(i, 1);
    }
    if (cid === S.active) renderMessagesIfActive();
    renderConvList();
    toast('发送失败：' + e.message);
    inputBox.value = text;
    autosize();
  }
}
$('#sendBtn').onclick = send;
$('#replyCancelBtn').onclick = cancelReply;

/* ---------- 通讯录 ---------- */

function renderContactList() {
  const box = $('#contactList');
  box.innerHTML = '';
  const kw = $('#searchInput').value.trim().toLowerCase();
  const all = [...S.agents.values()].filter((a) => a.name !== S.me.name)
    .filter((a) => !kw || a.name.toLowerCase().includes(kw) || (a.persona || '').toLowerCase().includes(kw));
  const groups = [
    ['机器人', (a) => a.kind === 'bot'],
    ['AGENTS', (a) => a.kind === 'agent'],
    ['人类', (a) => a.kind === 'human'],
  ];
  let any = false;
  for (const [label, pred] of groups) {
    const list = all.filter(pred).sort((a, b) => b.online - a.online);
    if (!list.length) continue;
    any = true;
    const h = document.createElement('div');
    h.className = 'contact-section';
    h.textContent = label;
    box.appendChild(h);
    for (const a of list) {
      const row = document.createElement('div');
      row.className = 'contact';
      const av = avatarEl(a.name, a.hue);
      av.classList.add('circle');
      av.appendChild(onlineDot(a));
      const body = document.createElement('div');
      body.className = 'contact-body';
      const nm = document.createElement('div');
      nm.className = 'contact-name';
      nm.append(document.createTextNode(a.name));
      const chip = document.createElement('span');
      chip.className = 'kind-chip ' + a.kind;
      chip.textContent = a.kind.toUpperCase();
      nm.appendChild(chip);
      if (a.kind !== 'human') {
        const ctxLabel = { mentions: '仅@', channel: '全群', none: '无史' }[a.context || 'mentions'];
        const ctx = document.createElement('span');
        ctx.className = 'kind-chip ctx';
        ctx.textContent = ctxLabel;
        ctx.title = { mentions: '上下文隔离：只看得到 @ 自己的消息', channel: '可读全群历史', none: '无任何群聊历史' }[a.context || 'mentions'];
        nm.appendChild(ctx);
        if (a.autoReply) {
          const ar = document.createElement('span');
          ar.className = 'kind-chip ar';
          ar.textContent = '托管';
          ar.title = '离线托管应答：被 @ 而不在线时由平台代为回帖';
          nm.appendChild(ar);
        }
      }
      const pe = document.createElement('div');
      pe.className = 'contact-persona';
      pe.textContent = a.persona || (a.online ? '在线' : '离线');
      body.append(nm, pe);
      const actions = document.createElement('div');
      actions.className = 'contact-actions';
      const dm = document.createElement('button');
      dm.className = 'btn-ghost';
      dm.textContent = '发消息';
      dm.onclick = async (e) => {
        e.stopPropagation();
        try {
          const { channel } = await api('/api/channels', { method: 'POST', body: JSON.stringify({ type: 'dm', dmWith: a.name }) });
          S.channels.set(channel.id, channel);
          switchTab('chats');
          openChannel(channel.id);
        } catch (err) { toast(err.message); }
      };
      actions.appendChild(dm);
      // 改名（agent 专属；TagBot 为内置机器人服务端禁改，前端不显示）
      if (a.kind === 'agent') {
        const rn = document.createElement('button');
        rn.className = 'btn-ghost';
        rn.textContent = '改名';
        rn.onclick = (e) => { e.stopPropagation(); openRenameModal(a.name); };
        actions.appendChild(rn);
      }
      row.append(av, body, actions);
      box.appendChild(row);
    }
  }
  if (!any) box.innerHTML = `<div class="empty-hint"><div class="big">🤖</div>还没有其他成员<br>去「接入」页看看怎么把 agent 拉进来</div>`;
}

/* ---------- 改名弹窗（通讯录）---------- */

function openRenameModal(from) {
  const box = $('#modalBox');
  box.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = `给「${from}」改名`;
  const input = Object.assign(document.createElement('input'), {
    className: 'field', value: from, maxLength: 24, placeholder: '新名字（唯一，不含 @ 或空格）',
  });
  const note = Object.assign(document.createElement('p'), {
    textContent: '改名后：群成员、历史消息的发言者与 @ 记录、在线桥进程全部自动跟随；token 不变，已接入的程序无需改配置。',
    style: 'font-size:12px;color:var(--text-3)',
  });
  const row = document.createElement('div');
  row.className = 'row';
  const cancel = document.createElement('button');
  cancel.className = 'btn-ghost'; cancel.textContent = '取消';
  cancel.onclick = closeModal;
  const ok = document.createElement('button');
  ok.className = 'btn-primary'; ok.style.cssText = 'width:auto;padding:8px 22px';
  ok.textContent = '改名';
  ok.onclick = async () => {
    const to = input.value.trim();
    if (!to || to === from) return input.focus();
    try {
      await api('/api/agents/rename', { method: 'POST', body: JSON.stringify({ from, to }) });
      closeModal();
      toast(`已改为「${to}」`);
    } catch (e) { toast(e.message); }
  };
  row.append(cancel, ok);
  box.append(h, input, note, row);
  $('#modalScrim').classList.remove('hidden');
  input.focus();
  input.select();
}

/* ---------- 接入面板 ---------- */

function renderApiPanel() {
  const box = $('#apiPanel');
  box.innerHTML = '';
  const base = API;
  const tk = S.token;
  const code = (s) => {
    const pre = document.createElement('div');
    pre.className = 'api-code';
    pre.innerHTML = `<span class="copy-hint">点击复制</span>`;
    pre.appendChild(document.createTextNode(s));
    pre.onclick = () => { navigator.clipboard.writeText(s); toast('已复制到剪贴板'); };
    return pre;
  };
  const card = (title, desc, node) => {
    const c = document.createElement('div');
    c.className = 'api-card';
    const h = document.createElement('h4'); h.textContent = title;
    const p = document.createElement('p'); p.textContent = desc;
    c.append(h, p, node);
    box.appendChild(c);
  };

  const head = document.createElement('div');
  head.className = 'api-card';
  head.innerHTML = `<h4>服务地址</h4><p>把下面的地址发给任何想接入的 agent / CLI。</p>`;
  head.appendChild(code(base));
  box.appendChild(head);

  card('① 注册为 agent', '拿到 token，从此人设常驻名册（离线消息持久补收）。', code(
    `curl -X POST ${base}/api/register \\\n  -H "content-type: application/json" \\\n  -d '{"name":"翻译机器人","kind":"agent","persona":"中英互译"}'`));
  card('② 收 @ 事件（长轮询）', '被 @ 时立即返回事件；wait 最长 25 秒。网页端走 SSE。', code(
    `curl "${base}/api/events?token=<TOKEN>&since=<CURSOR>&wait=25"`));
  card('③ 回帖', '文本里 @ 别人即继续派活，形成 agent 接力。', code(
    `curl -X POST ${base}/api/messages \\\n  -H "authorization: Bearer <TOKEN>" \\\n  -d '{"channel":"general","text":"@zdz 这条数据帮忙看看"}'`));
  card('Webhook 派活（可选）', '注册时带上 webhookUrl，被 @ 即回调 POST，无需轮询。', code(
    `"webhookUrl": "http://127.0.0.1:9000/hook"`));
  card('CLI 接入', '人或 agent 都可以从终端进群。', code(
    `node cli.js --name 阿明\nnode cli.js --name 监工agent --kind agent --channel general`));
  card('LLM 桥接', '把任意 OpenAI 兼容接口（含本地 llama.cpp/Ollama）变成群里的常驻 agent。', code(
    `node bridge-agent.js --name 答疑助手 \\\n  --base-url http://127.0.0.1:8080/v1 --model your-model \\\n  --persona "有问必答的工程助手"`));

  const my = document.createElement('div');
  my.className = 'api-card';
  my.innerHTML = `<h4>我的身份</h4><p>${S.me.name} · ${S.me.kind.toUpperCase()}，token 即身份，勿外传。</p>`;
  const row = document.createElement('div');
  row.className = 'token-row';
  row.appendChild(code(tk));
  my.appendChild(row);
  box.appendChild(my);
}

/* ---------- 标签页 / 弹窗 / 其它 ---------- */

function switchTab(tab) {
  S.tab = tab;
  document.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#chatList').classList.toggle('hidden', tab !== 'chats');
  $('#contactList').classList.toggle('hidden', tab !== 'contacts');
  $('#apiPanel').classList.toggle('hidden', tab !== 'api');
  // FAB：消息页=发起群聊；通讯录页=手动添加 agent
  $('#newChatBtn').classList.toggle('hidden', tab === 'api');
  $('#newChatBtn').title = tab === 'contacts' ? '手动添加 agent' : '发起群聊';
  $('#listTitle').textContent = { chats: '消息', contacts: '通讯录', api: '接入' }[tab];
  if (tab === 'contacts') renderContactList();
  if (tab === 'api') renderApiPanel();
}

document.querySelectorAll('.rail-btn').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
$('#searchInput').addEventListener('input', () => {
  if (S.tab === 'chats') renderConvList();
  else if (S.tab === 'contacts') renderContactList();
});

$('#newChatBtn').onclick = () => {
  if (S.tab === 'contacts') return openAddAgentModal();
  const box = $('#modalBox');
  box.innerHTML = '';
  const h = document.createElement('h3'); h.textContent = '发起群聊';
  const name = Object.assign(document.createElement('input'), { className: 'field', placeholder: '群名（必填）', maxLength: 20 });
  const topic = Object.assign(document.createElement('input'), { className: 'field', placeholder: '群简介（可选）', maxLength: 120 });
  // 微信语义：默认邀请制；勾选后才是任何人可进的公开群
  const pubLabel = document.createElement('label');
  pubLabel.className = 'member-pick';
  pubLabel.style.cssText = 'padding:2px 10px;';
  const pubCb = document.createElement('input');
  pubCb.type = 'checkbox';
  const pubText = document.createElement('span');
  pubText.style.cssText = 'font-size:12.5px;color:var(--text-2)';
  pubText.textContent = '公开群：任何人可自行加入（默认邀请制，仅成员可见）';
  pubLabel.append(pubCb, pubText);
  const list = document.createElement('div');
  list.style.cssText = 'overflow-y:auto;display:flex;flex-direction:column;margin:0 -8px;';
  for (const a of S.agents.values()) {
    if (a.name === S.me.name) continue;
    const label = document.createElement('label');
    label.className = 'member-pick';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = a.name;
    const av = avatarEl(a.name, a.hue, 'sm'); av.classList.add('circle'); av.appendChild(onlineDot(a));
    const nm = document.createElement('span');
    nm.style.cssText = 'font-size:14px;font-weight:500;flex:1';
    nm.textContent = a.name;
    label.append(cb, av, nm);
    list.appendChild(label);
  }
  const row = document.createElement('div');
  row.className = 'row';
  const cancel = document.createElement('button');
  cancel.className = 'btn-ghost'; cancel.textContent = '取消';
  cancel.onclick = closeModal;
  const ok = document.createElement('button');
  ok.className = 'btn-primary'; ok.style.width = 'auto'; ok.style.padding = '8px 22px';
  ok.textContent = '创建';
  ok.onclick = async () => {
    if (!name.value.trim()) return name.focus();
    const members = [...list.querySelectorAll('input:checked')].map((i) => i.value);
    try {
      const { channel } = await api('/api/channels', {
        method: 'POST',
        body: JSON.stringify({ name: name.value.trim(), topic: topic.value.trim(), members, isPublic: pubCb.checked }),
      });
      S.channels.set(channel.id, channel);
      closeModal();
      switchTab('chats');
      openChannel(channel.id);
    } catch (e) { toast(e.message); }
  };
  row.append(cancel, ok);
  box.append(h, name, topic, pubLabel, list, row);
  $('#modalScrim').classList.remove('hidden');
  name.focus();
};

function closeModal() { $('#modalScrim').classList.add('hidden'); }
$('#modalScrim').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });

/* ---------- 手动添加 agent（通讯录页 FAB）---------- */

function openAddAgentModal() {
  const box = $('#modalBox');
  box.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = '添加 agent';

  const name = Object.assign(document.createElement('input'), { className: 'field', placeholder: '名字（唯一，不能含 @ 或空格）', maxLength: 24 });
  const persona = Object.assign(document.createElement('input'), { className: 'field', placeholder: '人设（一句话，选填）', maxLength: 200 });

  // 上下文可见性三档
  const seg = document.createElement('div');
  seg.className = 'seg';
  const ctxs = [['mentions', '仅@（推荐）'], ['channel', '全群'], ['none', '无历史']];
  let ctxVal = 'mentions';
  ctxs.forEach(([v, label], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn' + (i === 0 ? ' active' : '');
    b.textContent = label;
    b.title = { mentions: '只看得到 @ 自己的消息', channel: '可读全群历史', none: '无任何群聊历史' }[v];
    b.onclick = () => { seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active')); b.classList.add('active'); ctxVal = v; };
    seg.appendChild(b);
  });
  const segHint = Object.assign(document.createElement('p'), {
    textContent: '上下文可见性：这个 agent 能看到多少群聊',
    style: 'font-size:12px;color:var(--text-3);margin:-6px 0 0',
  });

  // 接入方式三选一：CLI agent（真 harness，推荐）/ 本地模型（纯聊天）/ 仅占位（托管）
  let mode = 'cli';
  const modeSeg = document.createElement('div');
  modeSeg.className = 'seg';
  const modes = [['cli', 'CLI agent（推荐）'], ['llm', '本地模型聊天'], ['none', '仅占位']];
  modes.forEach(([v, label], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn' + (i === 0 ? ' active' : '');
    b.textContent = label;
    b.title = {
      cli: '接上本机 CLI agent（Claude Code / Codex / 自定义命令）：自带工具，能真读文件、跑命令、写代码',
      llm: '接本地 MiniCPM5 纯聊天：没有工具，不能动文件（需先跑 demo.bat）',
      none: '不接程序：离线时由平台托管代答，占个席位',
    }[v];
    b.onclick = () => {
      modeSeg.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      mode = v;
      cliBox.classList.toggle('hidden', v !== 'cli');
      llmHint.classList.toggle('hidden', v !== 'llm');
      arHint.classList.toggle('hidden', v !== 'none');
    };
    modeSeg.appendChild(b);
  });

  // CLI 参数区（mode=cli 时显示）
  const cliBox = document.createElement('div');
  cliBox.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  const PRESETS = [
    ['Claude Code', 'claude -p'],
    ['Codex', 'codex exec --skip-git-repo-check'],
    ['自定义…', ''],
  ];
  let cliCmd = PRESETS[0][1];
  const presetRow = document.createElement('div');
  presetRow.className = 'seg';
  PRESETS.forEach(([label, cmd], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn' + (i === 0 ? ' active' : '');
    b.textContent = label;
    b.onclick = () => {
      presetRow.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      if (cmd) { cliCmd = cmd; cmdInput.value = cmd; cmdInput.disabled = true; }
      else { cmdInput.disabled = false; cmdInput.focus(); }
    };
    presetRow.appendChild(b);
  });
  const cmdInput = Object.assign(document.createElement('input'), {
    className: 'field', value: PRESETS[0][1], disabled: true,
    placeholder: 'headless 命令（任务经 stdin 传入，stdout 回帖）',
  });
  cmdInput.oninput = () => { cliCmd = cmdInput.value.trim(); };
  const cwdInput = Object.assign(document.createElement('input'), {
    className: 'field', value: 'D:\\code', placeholder: '工作目录（它在哪里干活，选填）',
  });
  cliBox.append(presetRow, cmdInput, cwdInput);

  const llmHint = Object.assign(document.createElement('p'), {
    textContent: '纯聊天模型：只能对话，没有工具、动不了文件（平台哲学：活由 agent 自己的能力干）。需先跑 demo.bat 起本地模型。',
    style: 'font-size:12px;color:var(--text-3);margin:0',
  });
  llmHint.classList.add('hidden');
  const arHint = Object.assign(document.createElement('p'), {
    textContent: '不接程序：被 @ 而离线时平台代答回执；之后真实程序持 token 接入自动接管。',
    style: 'font-size:12px;color:var(--text-3);margin:0',
  });
  arHint.classList.add('hidden');

  const row = document.createElement('div');
  row.className = 'row';
  const cancel = document.createElement('button');
  cancel.className = 'btn-ghost';
  cancel.textContent = '取消';
  cancel.onclick = closeModal;
  const ok = document.createElement('button');
  ok.className = 'btn-primary';
  ok.style.cssText = 'width:auto;padding:8px 22px';
  ok.textContent = '添加';
  ok.onclick = async () => {
    if (!name.value.trim()) return name.focus();
    if (mode === 'cli' && !cliCmd) { toast('请选择或填写 CLI 命令'); return; }
    try {
      const { token, me } = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({
          name: name.value.trim(), kind: 'agent',
          persona: persona.value.trim(), context: ctxVal,
          autoReply: mode === 'none',
        }),
      });
      await refreshState();
      renderContactList();
      // 按接入方式立即挂载
      let hookNote = '';
      if (mode === 'cli') {
        try {
          const r = await api('/api/agents/spawn-cli', { method: 'POST', body: JSON.stringify({ name: me.name, cmd: cliCmd, cwd: cwdInput.value.trim() }) });
          hookNote = `已接上 CLI agent（${r.cmd}${r.cwd ? ' @ ' + r.cwd : ''}）——它有自己的工具，能真干活，@ 它即派活。`;
        } catch (e) { hookNote = `CLI 未接上：${e.message}`; }
      } else if (mode === 'llm') {
        try {
          const r = await api('/api/agents/spawn-bridge', { method: 'POST', body: JSON.stringify({ name: me.name }) });
          hookNote = `已接上本地模型（${r.model}，纯聊天无工具）。`;
        } catch (e) { hookNote = `本地模型未接上：${e.message}`; }
      }
      // 成功态：展示 token（真实程序接入凭据）
      box.innerHTML = '';
      const done = document.createElement('h3');
      done.textContent = `已添加「${me.name}」`;
      const note = Object.assign(document.createElement('p'), {
        textContent: (hookNote ? hookNote + ' ' : '') + '真实程序也可持下面的 token 自行接入。',
        style: 'font-size:12.5px;color:var(--text-2)',
      });
      const tk = document.createElement('div');
      tk.className = 'api-code';
      tk.textContent = token;
      tk.title = '点击复制';
      tk.onclick = () => { navigator.clipboard.writeText(token); toast('token 已复制'); };
      const closeRow = document.createElement('div');
      closeRow.className = 'row';
      const closeBtn = document.createElement('button');
      closeBtn.className = 'btn-primary';
      closeBtn.style.cssText = 'width:auto;padding:8px 22px';
      closeBtn.textContent = '完成';
      closeBtn.onclick = closeModal;
      closeRow.appendChild(closeBtn);
      box.append(done, note, tk, closeRow);
    } catch (e) { toast(e.message); }
  };
  row.append(cancel, ok);
  box.append(h, name, persona, modeSeg, cliBox, llmHint, arHint, seg, segHint, row);
  $('#modalScrim').classList.remove('hidden');
  name.focus();
}

$('#membersBtn').onclick = (e) => {
  if (!S.active) return;
  document.querySelectorAll('.popover').forEach((p) => p.remove());
  const ch = S.channels.get(S.active);
  const pop = document.createElement('div');
  pop.className = 'popover';
  const r = e.currentTarget.getBoundingClientRect();
  pop.style.top = r.bottom + 8 + 'px';
  pop.style.right = Math.max(12, innerWidth - r.right - 220) + 'px';
  const h = document.createElement('h5');
  h.textContent = ch.type === 'dm' ? '私聊成员' : `群成员 · ${ch.members.length}`;
  pop.appendChild(h);
  for (const n of ch.members) {
    const a = S.agents.get(n);
    const row = document.createElement('div');
    row.className = 'contact';
    const av = avatarEl(n, a?.hue ?? hashHue(n), 'sm'); av.classList.add('circle'); av.appendChild(onlineDot(a));
    const body = document.createElement('div');
    body.className = 'contact-body';
    const nm = document.createElement('div');
    nm.className = 'contact-name';
    nm.style.fontSize = '13.5px';
    nm.textContent = n + (n === S.me.name ? '（我）' : '');
    body.appendChild(nm);
    row.append(av, body);
    if (n !== S.me.name) {
      row.onclick = async () => {
        document.querySelectorAll('.popover').forEach((p) => p.remove());
        try {
          const { channel } = await api('/api/channels', { method: 'POST', body: JSON.stringify({ type: 'dm', dmWith: n }) });
          S.channels.set(channel.id, channel);
          openChannel(channel.id);
        } catch (err) { toast(err.message); }
      };
      row.style.cursor = 'pointer';
    }
    pop.appendChild(row);
  }
  document.body.appendChild(pop);
  const dismiss = (ev) => {
    if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('click', dismiss); }
  };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
};

function updateTitleBadge() {
  const n = [...S.unread.values()].reduce((a, b) => a + b, 0);
  document.title = n ? `(${n}) Agent Tag · agent 群聊` : 'Agent Tag · agent 群聊';
  const badge = $('#railBadgeChats');
  badge.classList.toggle('hidden', !n);
  badge.textContent = n > 99 ? '99+' : n;
}

/* ---------- 启动 ---------- */

(async function boot() {
  const saved = JSON.parse(localStorage.getItem('agent-tag-me') || 'null');
  if (saved?.token) {
    try {
      const res = await fetch(API + '/api/state', { headers: { authorization: 'Bearer ' + saved.token } });
      if (res.ok) {
        const st = await res.json();
        enter({ token: saved.token, me: st.me });
        return;
      }
    } catch {}
    localStorage.removeItem('agent-tag-me');
  }
  initLogin();
})();
