'use strict';
// 只分三种：完成、等你拍板、卡住。「有没有看过」「是不是在等他」用界面侧栏发布的同一份状态，这里不另判。
const { isOrdinarySession } = require('./restart-resume');
const { isNoUpdateReply } = require('../team-silent-reply');

// 界面收到完成事件后才更新侧栏状态，所以隔几秒再看；还显示在跑就再等一次，仍在跑说明它没停（后台任务还在干）。
const CHECK_DELAYS = [4000, 20000];
const LABELS = { done: '完成', decide: '等你拍板', stuck: '卡住' };
// 第一行结论自己说了要他定、或说卡住了的，按它说的算（侧栏的「等你响应」只认答复结尾的提问形式）。
const DECIDE = /等你|要你定|请你定|你来定|需要你|拍板/;
const STUCK = /卡住|受阻|中断|失败|没法继续|无法继续/;

// 答复的第一行结论：去掉「📌」、标题井号和加粗符号。
function conclusion(text, max = 120) {
  const line = String(text || '').split('\n').map(row => row.trim()).find(Boolean) || '';
  const plain = line.replace(/^#+\s*/, '').replace(/^📌\s*/, '').replace(/\*\*/g, '').trim();
  return plain.length > max ? plain.slice(0, max) + '…' : plain;
}

// 对话记录里同一个会话只留最新一条进展：旧的不再显示，也不该占「最近 N 条」的名额把真正的对话挤出去。
function latestOnly(rows) {
  const last = new Map();
  for (const row of rows) if (row.progress?.sessionId) last.set(row.progress.sessionId, row);
  return rows.filter(row => !row.progress?.sessionId || last.get(row.progress.sessionId) === row);
}

class ProgressFeed {
  constructor(assistant, { delays = CHECK_DELAYS } = {}) { this.a = assistant; this.delays = delays; this.pending = new Map(); }
  // 组队成员向负责人汇报，负责人的答复会出现；已被关注的会话另有原文提醒，不重复出。
  eligible(sessionId, meta) {
    if (!isOrdinarySession(meta)) return false;
    let teams = []; try { teams = this.a.deps.getTeams?.() || []; } catch {}
    if (teams.some(team => (team.members || []).some(member => member.sid === sessionId))) return false;
    return !this.a.watches.list().some(watch => watch.sessionId === sessionId);
  }
  // entries：这一轮新记进账本的最终答复（账本按答复去重，重复的完成事件不会再来一次）。
  onTurn(sessionId, meta, entries = []) {
    const entry = entries.at(-1);
    if (!entry || isNoUpdateReply(entry.text) || !String(entry.text || '').trim() || !this.eligible(sessionId, meta)) return;
    this.wait(sessionId, { entry, title: meta.title || meta.name || '未命名会话', attempt: 0 });
  }
  wait(sessionId, item) {
    clearTimeout(this.pending.get(sessionId)?.timer);
    const timer = setTimeout(() => { try { this.check(sessionId); } catch (error) { console.warn('[assistant] progress', error.message); } }, this.delays[item.attempt]);
    timer.unref?.();
    this.pending.set(sessionId, { ...item, timer });
  }
  check(sessionId) {
    const item = this.pending.get(sessionId);
    if (!item) return null;
    this.pending.delete(sessionId);
    const view = this.a.deps.getSession(sessionId) && this.a.sessionViews.get(sessionId)?.hubState;
    if (!view) return null;
    if (view.state === 'run') { if (item.attempt + 1 < this.delays.length) this.wait(sessionId, { ...item, attempt: item.attempt + 1 }); return null; }
    if (!view.hasUnread) return null; // 他正看着这个会话，或已经点开看过
    const line = conclusion(item.entry.text);
    if (!line) return null;
    const state = view.state === 'wait' || DECIDE.test(line) ? 'decide' : view.state === 'error' || STUCK.test(line) ? 'stuck' : 'done';
    return this.a.watches.addNotice({ id: 'progress:' + sessionId + ':' + item.entry.id, title: item.title, kind: 'session-progress', label: '会话进展',
      text: `**${LABELS[state]}**　${line}`, progress: { sessionId, state, line } });
  }
  close() { for (const item of this.pending.values()) clearTimeout(item.timer); this.pending.clear(); }
}
module.exports = { ProgressFeed, conclusion, latestOnly, LABELS };
