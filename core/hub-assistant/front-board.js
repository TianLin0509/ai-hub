'use strict';
//   1. 负责人：认领表里的负责人（claims.leads()），另加还没登记、但由前台派出且 24 小时内活跃的旧派活会话；
//   2. 你自己开的：近 24 小时用过、没被认领、也不是组队成员的会话，只报名字、状态、最后输出时间。
//   3. 其余开着的会话折叠成一个数字。
// 程序给的 ⚠ 矛盾标记，规则故意只有两条，前台原样带上、不自己圆：
//   ⚠A 进展卡写着在跑（状态是「顺利」或「有风险」），但会话超过 1 小时没有任何输出；
//   ⚠B 会话正在跑，但进展卡超过 3 小时没更新。
// 整个输出 ≤4 KB，超出时负责人从最旧的开始折叠成「另有 N 个」；细节用 read_progress 按会话取。
// 纯函数：会话、认领、进展卡快照、答复账本都由调用方传入；读卡文件只通过 readCardFirst 回调。

const BOARD_CAP = 4 * 1024;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const SILENT_WARN_MS = HOUR;      // ⚠A
const CARD_STALE_WARN_MS = 3 * HOUR; // ⚠B
const LEAD_KEEP_MS = 7 * DAY;     // 负责人一周没动静、会话也没开着，就不占行，只计数
const bytes = s => Buffer.byteLength(String(s), 'utf8');
const one = (s, n) => { const t = String(s || '').replace(/[\r\n|｜]+/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const firstLine = text => String(text || '').split(/\r?\n/).map(l => l.replace(/^[\s>#*\-📌✅]+|\*\*/g, '').trim()).find(Boolean) || '';

function ago(at, now) {
  if (!at) return '没有输出记录';
  const ms = Math.max(0, now - at);
  if (ms < 60000) return '刚刚';
  if (ms < HOUR) return Math.round(ms / 60000) + ' 分钟前';
  if (ms < DAY) return (Math.round(ms / HOUR * 10) / 10) + ' 小时前';
  return Math.round(ms / DAY) + ' 天前';
}
const RUNNING_CARD = new Set(['顺利', '有风险']);
const STUCK_HEALTH = /卡住|未送达|等送达|处置失败|失败/;

function lastOutputAt(s, reply) {
  return Math.max(Number(reply?.at) || 0, ...['lastOutputAt', 'lastMessageTime', 'lastCompletedAt'].map(k => Number(s?.[k]) || 0));
}
function status(s, { busy, health, card }) {
  if (s?.hubState?.state === 'error' || s?.status === 'error' || (health && STUCK_HEALTH.test(health)) || card?.plain?.status === '卡住' || s?.hubState?.needsUserInput) return '卡住';
  if (busy) return '在跑';
  return s?.isOpen ? '空闲' : '空闲（已关）';
}
function decisionOf(s, card, now) {
  let d = null;
  try { d = require('./lead-board').cardView(card, now)?.decision || null; } catch {}
  if (d) return '等你拍板：' + one(d.question, 40) + (d.recommendation ? '（推荐 ' + one(d.recommendation, 24) + '）' : '');
  if (s?.hubState?.needsUserInput) return '在等输入';
  return '不等你';
}
function warnings({ busy, card, outAt, now }) {
  const out = [];
  if (card?.plain && RUNNING_CARD.has(card.plain.status) && now - (outAt || 0) > SILENT_WARN_MS)
    out.push(`⚠ 卡写在跑，但 ${outAt ? ago(outAt, now).replace('前', '') : '一直'}没输出`);
  if (busy && card?.mtimeMs && now - card.mtimeMs > CARD_STALE_WARN_MS)
    out.push(`⚠ 在跑，但进展卡 ${ago(card.mtimeMs, now).replace('前', '')}没更新`);
  return out;
}

function buildFrontBoard({ sessions = [], leads = [], cards = [], ledger = [], teams = [], now = Date.now(),
  isBusy = s => s?.hubState?.isActive === true || ['running', 'waiting'].includes(s?.status), healthWord = () => null, readCardFirst = () => '' } = {}) {
  const byId = new Map(sessions.map(s => [s.id, s]));
  const cardOf = new Map(cards.map(c => [c.sessionId, c]));
  const reply = new Map();
  for (const e of ledger) if (e?.sessionId && (!reply.has(e.sessionId) || reply.get(e.sessionId).at < e.at)) reply.set(e.sessionId, e);
  const members = new Set();
  for (const t of teams) for (const m of t.members || []) if (m.sid && m.status !== 'dismissed') members.add(m.sid);

  // 负责人：认领表 + 未登记的前台旧派活（24 小时内活跃）。
  const leadIds = new Map(leads.map(c => [c.sessionId, c]));
  for (const s of sessions) if (s.purpose === 'hub-assistant-task' && !leadIds.has(s.id) && !members.has(s.id)
    && now - lastOutputAt(s, reply.get(s.id)) <= DAY) leadIds.set(s.id, { sessionId: s.id, title: s.title, by: 'dispatch', legacy: true });
  const leadRows = [];
  let staleLeads = 0;
  for (const [id, claim] of leadIds) {
    const s = byId.get(id) || { id, title: claim.title, isOpen: false, status: 'closed' };
    const card = cardOf.get(id) || null, r = reply.get(id) || null, outAt = lastOutputAt(s, r);
    if (!s.isOpen && now - Math.max(outAt, card?.mtimeMs || 0, Number(claim.at) || 0) > LEAD_KEEP_MS) { staleLeads++; continue; }
    const busy = !!isBusy(s), health = healthWord(id) || '';
    let first = card?.plain?.line || (card?.cardPath ? readCardFirst(card.cardPath) : '');
    if (!first && r) first = '最后回复：' + firstLine(r.text);
    const st = status(s, { busy, health, card });
    const decision = decisionOf(s, card, now);
    const warn = warnings({ busy, card, outAt, now });
    const name = one(s.title || s.name || claim.title || id, 24);
    const line = `- ${name}｜${st}${health && !st.includes(health) ? '/' + one(health, 6) : ''}｜${one(first, 60) || '（没有进展卡，也没有回复记录）'}｜最后输出 ${ago(outAt, now)}｜${decision}${warn.length ? '｜' + warn.join('；') : ''}`;
    leadRows.push({ id, line, rank: decision.startsWith('等你拍板') ? 0 : warn.length || st === '卡住' ? 1 : 2, outAt });
  }
  leadRows.sort((a, b) => a.rank - b.rank || b.outAt - a.outAt);

  // 你自己开的：近 24 小时、没被认领、不是组队成员、不是负责人。
  const ownSessions = sessions.filter(s => !leadIds.has(s.id) && !members.has(s.id) && s.purpose !== 'hub-assistant-task'
    && now - lastOutputAt(s, reply.get(s.id)) <= DAY);
  const own = ownSessions.map(s => ({ s, outAt: lastOutputAt(s, reply.get(s.id)) })).sort((a, b) => b.outAt - a.outAt)
    .map(({ s, outAt }) => `- ${one(s.title || s.name || s.id, 24)}｜${status(s, { busy: !!isBusy(s), health: healthWord(s.id) || '', card: null })}｜最后输出 ${ago(outAt, now)}`);
  const shown = new Set([...leadIds.keys(), ...ownSessions.map(s => s.id)]);
  const rest = sessions.filter(s => s.isOpen && !shown.has(s.id)).length;

  // 4 KB 装箱：先保证三组标题和「其余」行，再按优先级放负责人，最后放自己开的。
  const decide = leadRows.filter(r => r.rank === 0).length;
  const head = `负责人 ${leadRows.length} 个（${decide} 个等你拍板）`;
  const restLine = `其余：开着的会话还有 ${rest} 个（组队成员、更早的会话）${staleLeads ? `；一周没动静的负责人 ${staleLeads} 个` : ''}。细节用 read_progress 按会话取。`;
  let budget = BOARD_CAP - bytes(head) - bytes('你自己开的（近 24 小时）') - bytes(restLine) - 200;
  const take = (rows, label) => {
    const out = []; let dropped = 0;
    for (const r of rows) { const b = bytes(r) + 1; if (b > budget) { dropped++; continue; } out.push(r); budget -= b; }
    if (dropped) { const more = `- ……另有 ${dropped} 个${label}没列出`; out.push(more); budget -= bytes(more) + 1; }
    return out;
  };
  const leadLines = take(leadRows.map(r => r.line), '负责人');
  const ownLines = take(own, '会话');
  const text = [`【${head}】`, ...(leadLines.length ? leadLines : ['- （没有）']), `【你自己开的（近 24 小时，${own.length} 个）】`,
    ...(ownLines.length ? ownLines : ['- （没有）']), restLine].join('\n');
  return { board: text, bytes: bytes(text), counts: { leads: leadRows.length, decide, own: own.length, rest, staleLeads },
    howTo: '一人一行原样转述；⚠ 是程序发现的矛盾，照带不解释；追问细节先 read_progress，没有再转问负责人。' };
}

module.exports = { buildFrontBoard, BOARD_CAP, SILENT_WARN_MS, CARD_STALE_WARN_MS, ago, firstLine };
