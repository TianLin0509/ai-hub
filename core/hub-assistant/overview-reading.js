'use strict';
// 和「待我决策」分开：还在等你拍板的不进这里；只列负责人和零碎会话，组队成员、子会话不单列（同任务进展的第一级口径）。
//
// 「做完了」三种依据，取最新的一种：
//   交卷：前台派出的负责人答完一轮、被交卷直送判成交卷（handoff-feed 记下时刻和原文）；
//   最终回复：没有进展卡的零碎会话，最后一条有内容的答复（[[hub:no-update]] 这类暗号不算）。
//   有进展卡但状态不是「已完成」的负责人不算做完（中途汇报）；仍在跑、在等输入、出错、成员还在干的都不算。
//
// 「看过」：
//   1) 你在 Hub 里点开过这个会话（focus-session）或在侧栏点了全部已读、在这个 Tab 点了已读 —— 记下时刻，完成时刻不晚于它就算看过；
//   2) 会话开着、侧栏显示没有未读：说明结果你已经看过，把「看过」推到现在（落盘，重启后还认）；
//   3) 会话没打开（Hub 普通重启后所有会话都是未打开）：只看 1) 的记录和会话自带的未读数；
//      功能第一次运行的时刻记为基线，基线之前完成、又没有未读数的一律当看过 —— 不会因为重启或刚上线就把所有会话都刷成待读。
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../atomic-write');

const HOUR = 3600000, DAY = 24 * HOUR;
const RECENT_MS = 3 * DAY;   // 默认只列最近 3 天
const KEEP_MS = 14 * DAY;    // 更早的折叠；14 天以前的不再列
const SKEW_MS = 2000;
const clip = (s, n) => { const c = [...String(s || '').replace(/\s+/g, ' ').trim()]; return c.length > n ? c.slice(0, n).join('') + '…' : c.join(''); };

function conclusion(text, max = 90) {
  const line = String(text || '').split('\n').map(r => r.trim()).find(r => r && !/^\[\[hub:[\w-]+\]\]$/.test(r)) || '';
  return clip(line.replace(/^#+\s*/, '').replace(/^📌\s*/, '').replace(/\*\*/g, ''), max);
}

// 产物路径：答复里出现的 Windows 绝对路径，优先带扩展名的文件，最多 3 个。
function productPaths(text) {
  const out = [];
  const re = /(?<![\w/\\])[A-Za-z]:[\\/][^\s"'`<>|*?，。；、：:（）()【】「」\[\]]+/g;
  for (const m of String(text || '').matchAll(re)) {
    const p = m[0].replace(/[.,;!?。、]+$/, '');
    if (p.length > 4 && !out.includes(p)) out.push(p);
  }
  const file = p => /\.[A-Za-z0-9]{1,6}$/.test(p);
  return [...out.filter(file), ...out.filter(p => !file(p))].slice(0, 3);
}

function ago(ms) {
  if (!(ms >= 0)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

class ReadingStore {
  constructor(dir, { now = Date.now } = {}) { this.file = path.join(dir, 'overview-reading.json'); this.now = now; this.cache = null; }
  load() {
    if (this.cache) return this.cache;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') console.warn('[overview-reading] 记录读不出来，从空表开始（基线取现在，不会把旧会话刷成待读）：', error.message); }
    const ok = raw && typeof raw === 'object';
    this.cache = { version: 1, since: ok && raw.since > 0 ? raw.since : this.now(), viewed: ok && raw.viewed && typeof raw.viewed === 'object' ? raw.viewed : {}, handoffs: ok && raw.handoffs && typeof raw.handoffs === 'object' ? raw.handoffs : {} };
    if (!ok) this.save();
    return this.cache;
  }
  save() {
    const s = this.cache, cut = this.now() - KEEP_MS;
    for (const k of Object.keys(s.viewed)) if (!(s.viewed[k] > cut)) delete s.viewed[k];
    for (const k of Object.keys(s.handoffs)) if (!(s.handoffs[k]?.at > cut)) delete s.handoffs[k];
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeFileAtomic(fs, this.file, JSON.stringify(s, null, 2)); }
    catch (error) { console.warn('[overview-reading] 写记录失败', error.message); }
  }
  // 看过：把这个会话「看到哪儿」推到 at（只前进不后退）。返回是否有变化。
  view(ids, at = this.now(), { persist = true } = {}) {
    const s = this.load(); let changed = false;
    for (const id of [].concat(ids || [])) if (typeof id === 'string' && id && !(s.viewed[id] >= at)) { s.viewed[id] = at; changed = true; }
    if (changed && persist) this.save();
    return changed;
  }
  handoff(sessionId, { at = this.now(), text = '', title = '' } = {}) {
    if (!sessionId) return;
    this.load().handoffs[sessionId] = { at, title: clip(title, 60), text: String(text || '').slice(0, 4000) };
    this.save();
  }
}

// 纯函数。sessions：[{ id, title, isOpen, purpose, unreadCount, sidebarView, _isMeeting, meetingId }]；
// tasks：front-client 的任务行（看 state）；entries：账本答复（sessionId, at, text）；state：ReadingStore 内容；
// skip：不进这里的会话号（Hub 常驻席位、待我决策里正等你拍板的）。
// frontLeads：前台派出的负责人（交卷直送管着，只认交卷记录，不用最终回复兜底）；remoteOpen(sid)：它提交、可能还在跑的远端作业数。
function buildReading({ sessions = [], teams = [], cards = [], tasks = [], entries = [], state = {}, skip = new Set(), frontLeads = new Set(), remoteOpen = () => 0, now = Date.now() } = {}) {
  const leadOf = new Map(), membersOf = new Map(), queuedLead = new Set();
  for (const t of teams || []) {
    if (!t || !t.leadSid || !(t.members || []).length) continue;
    // 已批准但还在排队、没分到会话号的成员（审查第 3 项，同 HandoffFeed.membersBusy）：负责人这件活没做完。
    if (t.members.some(m => m && !m.delivered && m.status === 'queued')) queuedLead.add(t.leadSid);
    for (const m of t.members) if (m && m.sid) { leadOf.set(m.sid, t.leadSid); if (!membersOf.has(t.leadSid)) membersOf.set(t.leadSid, []); membersOf.get(t.leadSid).push(m.sid); }
  }
  const cardOf = new Map((cards || []).filter(c => c && c.sessionId).map(c => [c.sessionId, c]));
  const rowOf = new Map((tasks || []).map(r => [r.id, r]));
  const said = new Map();
  for (const e of entries || []) if (e?.sessionId && !/^\s*(\[\[hub:[\w-]+\]\]\s*)+$/.test(String(e.text || '')) && !(said.get(e.sessionId)?.at >= e.at)) said.set(e.sessionId, e);
  const viewed = state.viewed || {}, handoffs = state.handoffs || {}, since = state.since || 0;
  const BUSY = ['run', 'wait', 'error'];
  // 状态和未读都用 service.sessions() 投影过的 hubState：它核对过原生身份，会话换了身份时不会拿旧快照（审查第 1 项）。
  const liveState = s => rowOf.get(s.id)?.state || s.hubState?.state || null;
  const { classify } = require('./handoff-feed');
  const rows = [], seen = [];
  for (const s of sessions || []) {
    const id = s?.id;
    if (!id || skip.has(id) || leadOf.has(id) || s._isMeeting || s.meetingId) continue;
    if (s.purpose === 'hub-assistant' || s.purpose === 'hub-assistant-desk' || /（已换班）\s*$/.test(String(s.title || ''))) continue;
    if (BUSY.includes(liveState(s)) || queuedLead.has(id) || (membersOf.get(id) || []).some(m => BUSY.includes(rowOf.get(m)?.state))) continue;
    const card = cardOf.get(id), plain = card?.plain, cardDone = plain?.status === '已完成';
    const h = handoffs[id], e = said.get(id);
    const cand = [];
    if (h?.at) cand.push({ kind: 'handoff', at: h.at, line: conclusion(h.text), text: h.text });
    if (cardDone && card.mtimeMs) cand.push({ kind: 'card', at: card.mtimeMs, line: clip(plain.line || '', 90), text: '' });
    // 有进展卡、但卡上不是「已完成」：负责人在中途汇报，最后一条答复不算做完。
    // 最终回复兜底只给零碎会话：前台负责人只认交卷记录；其余按交卷同一判据，写着「等结果 / 已提交作业」或还有远端作业在跑的不算做完（审查第 2 项）。
    const textDone = !!e && classify({ text: e.text, idle: true, membersBusy: false, remoteOpen: Number(remoteOpen(id)) || 0 }) === 'handoff';
    // 交卷 / 卡片已完成之后又有一条不像做完的答复（等远端、等结果、请拍板）：负责人开了新一轮，旧的完成不算（复审 R1）。
    const strongAt = Math.max(h?.at || 0, cardDone ? card.mtimeMs || 0 : 0);
    if (strongAt && e && e.at > strongAt + 60000 && !textDone) continue;
    if (e && textDone && (cardDone || h || (!card && !frontLeads.has(id)))) cand.push({ kind: 'reply', at: e.at, line: conclusion(e.text), text: e.text });
    if (!cand.length) continue;
    cand.sort((a, b) => b.at - a.at);
    const top = cand[0];
    // 卡片在交卷之后又改了、而且不是「已完成」：负责人又开了新一轮，不算做完。
    if (card && !cardDone && (card.mtimeMs || 0) > top.at + 60000) continue;
    const at = top.at;
    if (now - at > KEEP_MS) continue;
    // 交卷 / 卡片已完成时，结论优先用负责人写的那句；路径从最近的原文里找。
    const strong = cand.find(c => c.kind !== 'reply');
    const line = (strong && top.kind === 'reply' && at - strong.at < 30 * 60000 ? strong.line : top.line) || cand.find(c => c.line)?.line || '';
    const text = [top.text, ...cand.map(c => c.text)].find(Boolean) || '';
    // 看过没有。
    const view = s.isOpen ? s.hubState : null;
    let unread;
    if ((viewed[id] || 0) >= at - SKEW_MS) unread = false;
    else if (view && view.hasUnread === false) { unread = false; seen.push(id); }
    else if (view && view.hasUnread === true) unread = true;
    else if (Number(s.unreadCount) > 0) unread = true;
    else unread = at >= since;
    if (!unread) continue;
    rows.push({ sessionId: id, title: String(s.title || s.name || id.slice(0, 8)), kind: top.kind === 'reply' && strong ? strong.kind : top.kind,
      line, paths: productPaths(text), completedAt: at, when: ago(now - at), isLead: membersOf.has(id) || !!card });
  }
  rows.sort((a, b) => b.completedAt - a.completedAt);
  const recent = rows.filter(r => now - r.completedAt <= RECENT_MS), older = rows.filter(r => now - r.completedAt > RECENT_MS);
  // 角标克制：只数最近 24 小时内交卷 / 卡片已完成的负责人，零碎会话的最终回复不进角标。
  const badge = recent.filter(r => now - r.completedAt <= DAY && r.kind !== 'reply').length;
  return { rows: recent, older, badge, total: recent.length, seen };
}

module.exports = { buildReading, ReadingStore, productPaths, conclusion, RECENT_MS, KEEP_MS };
