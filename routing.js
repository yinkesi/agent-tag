/**
 * routing.js —— @ 路由纯函数（无 I/O，服务端唯一实现）
 *
 * 学自 AgentConnect 的 activation-policy 包：「这条消息激活谁」压成一个纯函数，
 * 输入全是显式事实（文本 / 名册 / 频道），不碰 db、不发请求——
 * 投递、历史可见性、事件流过滤三处共用同一份实现，不会有口径分歧。
 *
 * 两个保留 token 学自 CCCC 的 @all / @peers / @foreman：
 * mentions 里存原文、读时展开（expandMentions / mentionsTarget），
 * 所以改名、换群主都不会让历史消息的投递语义漂移。
 */
'use strict';

const TOKENS = ['@all', '@owner']; // 顺序即优先级：token 先于同名候选（见 parseMentions）
const RESERVED = new Set(['all', 'owner']); // 注册/改名禁用，防抢占 token

/**
 * 解析文本中的 @：具体名 + 保留 token 混合数组。
 * - 最长名优先且命中即消费（@abc2 不会被 @abc 吃掉）
 * - token 优先于具体名匹配（配合 RESERVED，名册里不会有 all/owner）
 * - NFC 归一化，对 NFD 输入免疫（与注册同口径）
 */
function parseMentions(text, agentNames) {
  const norm = String(text).normalize('NFC');
  const names = [...agentNames].sort((a, b) => b.length - a.length);
  const found = [];
  let i = 0;
  while (i < norm.length) {
    if (norm[i] !== '@') { i++; continue; }
    let hit = null;
    for (const t of TOKENS) {
      if (norm.startsWith(t, i)) { hit = t; break; }
    }
    if (!hit) {
      for (const n of names) {
        if (norm.startsWith('@' + n, i)) { hit = n; break; }
      }
    }
    if (hit) { if (!found.includes(hit)) found.push(hit); i += 1 + hit.length; } else i++;
  }
  return found;
}

/**
 * 从文本中移除所有 @name 提及（零正则实现，纯字符串扫描）。
 * 名字可含 ( ) + * 等正则元字符：拼 RegExp 要么抛 SyntaxError（未配对括号）要么静默错配（a+b），
 * 这里与 parseMentions 同为「@+名字 前缀消费」语义，字面量查找，行为与正则转义后等价。
 */
function stripMention(text, name) {
  const s = String(text);
  const token = '@' + String(name);
  if (token.length < 2) return s; // 空名无事可做
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s.startsWith(token, i)) { i += token.length; continue; }
    out += s[i];
    i++;
  }
  return out;
}

/**
 * name 是否是这条 mentions 的投递对象（读时展开的唯一裁判）：
 *   具体名命中        —— @小王
 *   '@all'            —— 全频道成员
 *   '@owner'          —— 仅群主（isOwner 由调用方按 channel.owner 现算）
 */
function mentionsTarget(mentions, name, { isOwner } = {}) {
  if (!Array.isArray(mentions)) return false;
  return mentions.includes(name) ||
    mentions.includes('@all') ||
    (mentions.includes('@owner') && isOwner === true);
}

/**
 * 把 mentions 展开成具体目标名列表（去重、可排除发送者）。
 * '@all' 展开为频道成员表；'@owner' 展开为 channel.owner；具体名须在名册里。
 */
function expandMentions(mentions, channel, agents, { exclude = [] } = {}) {
  const out = new Set();
  for (const t of mentions || []) {
    if (t === '@all') {
      for (const m of (channel && channel.members) || []) out.add(m);
    } else if (t === '@owner') {
      if (channel && channel.owner) out.add(channel.owner);
    } else if (agents[t]) {
      out.add(t);
    }
  }
  for (const e of exclude) out.delete(e);
  return [...out];
}

/**
 * 上下文可见性（服务端强制，仅作用于群聊；私聊当事人始终全量）：
 *   channel  —— 全群历史（需显式开启）
 *   mentions —— 默认：只有 @ 自己的（含 @all / @owner 展开）、自己发的、系统消息
 *   none     —— 连 @ 自己的都只在本条事件里给，历史里不补
 */
function canReadMessage(a, m, ch) {
  if (m.kind === 'system') return true;
  if (m.from === a.name) return true;
  if (a.context === 'none') return false;
  return mentionsTarget(m.mentions, a.name, { isOwner: !!ch && ch.owner === a.name });
}

module.exports = { TOKENS, RESERVED, parseMentions, stripMention, mentionsTarget, expandMentions, canReadMessage };
