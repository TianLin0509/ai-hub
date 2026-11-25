'use strict';
// 前台工具返回瘦身（2026-11-15 前台一期）：工具单次返回 ≤8 KB。11-15 实测 list_sessions 一次 91.6 万字、
// history_context 7.3 万字，前台每回合上下文中位约 11.6 万 token。这里把大结果改成「摘要 + 分段编号」，
// 要细节时按编号再取；会话列表一会话一行。
const fs = require('node:fs');
const path = require('node:path');

const TOOL_CAP = 8 * 1024;
const PROGRESS_CAP = 4 * 1024;
const RECENT_MS = 48 * 3600 * 1000;
const bytes = text => Buffer.byteLength(String(text), 'utf8');
function clip(text, cap) {
  const s = String(text);
  if (bytes(s) <= cap) return s;
  return Buffer.from(s, 'utf8').subarray(0, Math.max(0, cap - 3)).toString('utf8').replace(/\uFFFD+$/, '') + '…';
}
function oneLine(text, max = 40) { return String(text || '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function beijing(ms) {
  if (!ms) return '-';
  const d = new Date(Number(ms) + 8 * 3600000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
const ACTIVE = new Set(['running', 'waiting', 'starting', 'busy']);
function lastActive(s) { return Number(s.lastMessageTime || s.lastCompletedAt || s.lastRunStartedAt || s.updatedAt || s.savedAt || 0); }
function account(s) { return s.claudeProfileLabel || s.codexProfileLabel || s.codeagentPoolLabel || s.antigravityProfileLabel || s.claudeProfile || ''; }
// 短状态词：在办 / 等你 / 空闲 / 已关；m3 的会话健康给出 s.health（如「卡住」「未送达」）时并列显示。
// 以 Hub 侧栏的运行真相（hubState）为准，没有时退回原始状态。
function stateWord(s) {
  const h = s.hubState || {};
  let base;
  if (h.needsUserInput || s.needsUserInput) base = '等你';
  else if (h.isActive === true || (h.isActive === undefined && ACTIVE.has(s.status))) base = '在办';
  else if (h.state === 'error' || s.status === 'error') base = '出错';
  else base = s.isOpen ? '空闲' : '已关';
  if (h.hasUnread) base += '·新回复';
  const health = typeof s.health === 'string' ? s.health : s.health?.word || s.health?.state || '';
  return health ? `${base}/${oneLine(health, 8)}` : base;
}

// list_sessions：默认只列在办和最近 48 小时活动的会话；group（任务组，m2 的 taskGroups）和 keyword 过滤；all=true 看全部（仍 ≤8 KB）。
function listSessions(sessions, { group = '', keyword = '', all = false, limit = 0, now = Date.now(), taskGroups = null } = {}) {
  let rows = sessions.slice();
  let groupNote = '';
  if (group) {
    if (taskGroups?.filterSessions) rows = taskGroups.filterSessions(rows, String(group));
    else groupNote = '（这台 Hub 还没有任务组功能，group 过滤未生效）';
  }
  if (keyword) {
    const k = String(keyword).toLowerCase();
    rows = rows.filter(s => [s.id, s.title, s.name, s.purpose, s.scene, account(s)].some(v => String(v || '').toLowerCase().includes(k)));
  }
  const total = rows.length;
  const busy = s => s.hubState?.isActive === true || ACTIVE.has(s.status);
  if (!all && !group && !keyword) rows = rows.filter(s => s.isOpen || busy(s) || now - lastActive(s) <= RECENT_MS);
  rows.sort((a, b) => (busy(b) - busy(a)) || lastActive(b) - lastActive(a));
  const header = '编号 | 标题 | 状态 | 账号 | 最后活动（北京时间）';
  const lines = [];
  let used = bytes(header) + 400, shown = 0;
  for (const s of rows) {
    if (limit && shown >= limit) break;
    const line = `${s.id} | ${oneLine(s.title || s.name, 40) || '(无标题)'} | ${stateWord(s)} | ${oneLine(account(s), 16) || '-'} | ${beijing(lastActive(s))}`;
    if (used + bytes(line) + 1 > TOOL_CAP) break;
    lines.push(line); used += bytes(line) + 1; shown++;
  }
  const scope = group ? `任务组 ${group}` : keyword ? `关键词「${keyword}」` : all ? '全部会话' : '在办和最近 48 小时的会话';
  const more = rows.length - shown;
  return { scope: scope + groupNote, shown, matched: rows.length, total, columns: header,
    sessions: lines.join('\n'),
    note: (more > 0 ? `还有 ${more} 个没列出（超出 8 KB），用 keyword 或 group 缩小范围。` : '')
      + '会话详情用 read_progress（进展卡；没有卡时给最后回复开头）。' };
}

// 大资料包的目录：每个顶层字段一段，带编号、大小和一句话内容提示；按 section 编号或名字再取，长段按 page 分页。
function brief(value) {
  if (Array.isArray(value)) {
    const first = value[0];
    const hint = first && typeof first === 'object' ? oneLine(first.title || first.name || first.text || first.id || Object.keys(first).slice(0, 4).join(','), 40) : oneLine(first, 40);
    return `${value.length} 项${hint ? '，如：' + hint : ''}`;
  }
  if (value && typeof value === 'object') return '字段：' + Object.keys(value).slice(0, 8).join('、');
  return oneLine(value, 60);
}
function outline(packet, { title = '资料', keep = [] } = {}) {
  const entries = Object.entries(packet || {});
  const sections = entries.map(([name, value], i) => ({ no: i + 1, name, bytes: bytes(JSON.stringify(value) ?? ''), brief: brief(value) }));
  const kept = Object.fromEntries(keep.filter(k => packet?.[k] !== undefined).map(k => [k, packet[k]]));
  const result = { kind: title + '摘要', sections, ...kept,
    howTo: '要细节时用同一工具再调一次，带 section（编号或名字）；大段再带 page（从 1 开始），每页 ≤8 KB。' };
  let text = JSON.stringify(result);
  while (bytes(text) > TOOL_CAP && result.sections.length) { result.sections.pop(); result.truncatedSections = true; text = JSON.stringify(result); }
  return result;
}
function section(packet, ref, page = 1) {
  const entries = Object.entries(packet || {});
  const index = /^\d+$/.test(String(ref)) ? Number(ref) - 1 : entries.findIndex(([name]) => name === String(ref));
  if (index < 0 || index >= entries.length) throw new Error(`没有第 ${ref} 段；可用：` + entries.map(([n], i) => `${i + 1}.${n}`).join(' '));
  const [name, value] = entries[index];
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  const pageBytes = TOOL_CAP - 600;
  const buf = Buffer.from(text, 'utf8');
  const pages = Math.max(1, Math.ceil(buf.length / pageBytes));
  const p = Math.min(Math.max(1, Number(page) || 1), pages);
  let start = (p - 1) * pageBytes, end = Math.min(buf.length, start + pageBytes);
  while (start > 0 && (buf[start] & 0xc0) === 0x80) start--;
  while (end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
  return { section: index + 1, name, page: p, pages, content: buf.subarray(start, end).toString('utf8'),
    ...(p < pages ? { next: `section=${index + 1} page=${p + 1}` } : {}) };
}

// 没有时到原生记录末尾找这个会话写过的进展卡（与进展卡服务同一套识别规则）。
function cardSections(text) {
  const pick = re => { const m = re.exec(text); return m ? m[1].trim() : ''; };
  const forYou = pick(/^##\s*给用户看[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  const status = pick(/^##\s*(?:当前状态|当前步骤|状态)[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  return { forYou, status };
}
function findCardPath(session, { cardPathFor = null, tailBytes = 2 * 1024 * 1024 } = {}) {
  const known = cardPathFor?.(session.id);
  if (known && fs.existsSync(known)) return known;
  const transcript = session.transcriptPath;
  if (!transcript || !fs.existsSync(transcript)) return null;
  const size = fs.statSync(transcript).size, fd = fs.openSync(transcript, 'r');
  try {
    const length = Math.min(size, tailBytes), buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const { writtenCardPaths, cardsInOwnDirectory } = require('../../main/progress-card-service');
    const text = buf.toString('utf8');
    const found = [...writtenCardPaths(text, session.cwd || ''), ...cardsInOwnDirectory(text, session.cwd || '')].filter(p => fs.existsSync(p));
    return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  } finally { fs.closeSync(fd); }
}
function readProgress(session, opts = {}) {
  if (!session) throw new Error('没有这个会话；先用 list_sessions 找编号');
  const file = findCardPath(session, opts);
  if (!file) {
    // 2026-11-18：前台不再读整段答复原文；没有进展卡时给最后一次回复的开头几行（≤1 KB），再细就转问负责人。
    let reply = null; try { reply = opts.lastReply?.(session.id) || null; } catch {}
    const head = reply ? String(reply.text || '').split(/\r?\n/).filter(l => l.trim()).slice(0, 6).join('\n') : '';
    return { ok: false, sessionId: session.id, title: session.title || '',
      ...(head ? { lastReply: { at: beijing(reply.at), head: clip(head, 1024) } } : {}),
      note: head ? '这个会话没有进展卡，上面是它最后一次回复的开头；更细的转问它本人。' : '这个会话没有进展卡，也没有回复记录；要细节就转问它本人。' };
  }
  const text = fs.readFileSync(file, 'utf8');
  const { forYou, status } = cardSections(text);
  const half = Math.floor((PROGRESS_CAP - 600) / 2);
  return { ok: true, sessionId: session.id, title: session.title || '', cardPath: file, updatedAt: beijing(fs.statSync(file).mtimeMs),
    forYou: clip(forYou || '（卡里没有「给用户看」这一段）', half), status: clip(status || '（卡里没有「当前状态」这一段）', half),
    note: '以上是卡片原文；转述时照引用，自己的判断单独标出。' };
}

module.exports = { TOOL_CAP, PROGRESS_CAP, listSessions, outline, section, readProgress, cardSections, findCardPath, stateWord, bytes, clip };
