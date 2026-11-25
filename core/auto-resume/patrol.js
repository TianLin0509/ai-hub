'use strict';
// 自动续跑 P1 巡逻器：只提醒、不自动发。每 60 秒扫一遍已打开的会话，按 patrol-judge 判「疑似停住」，
// 隔一个阈值二次确认后出提醒；提醒进账本（auto-resume-ledger.jsonl，kind=patrol-*）和前台「当前概览 → 续跑」Tab。
//
const { summarize } = require('./transcript-state');
const { judgeStall, VERSION } = require('./patrol-judge');

class Patrol {
  // deps：
  //   now()、enabled()、listSessions() → [{ id, kind, title, transcriptPath }]（已打开、有 writer 的会话）
  //   facts(id, session) → judgeStall 的运行事实（role、processAlive、turnActive、needsInput、userInputAt、draftPending、intent、closed、autoResumeDisabled、interruption）
  //   readEntries(transcriptPath) → 会话记录末尾一段解析后的记录数组
  //   ledger（append）、onChange(list)、notify(reminder)（新提醒、非成员会话时调用）
  constructor(deps = {}, { intervalMs = 60_000 } = {}) {
    this.d = { now: Date.now, enabled: () => true, listSessions: () => [], facts: () => ({}), readEntries: () => [],
      ledger: null, onChange: () => {}, notify: () => {}, ...deps };
    this.intervalMs = intervalMs;
    this.candidates = new Map(); // sid → { sig, firstAt }
    this.reminders = new Map();  // sid → 提醒
    this.dismissed = new Set();  // `${sid}|${since}`
    this.timer = null; this.scanning = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.scan(); }, this.intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  log(event) { try { this.d.ledger?.append({ ...event, version: VERSION }); } catch (error) { console.warn('[auto-resume] 巡逻账本写入失败', error.message); } }

  // 扫一遍。返回本轮新出的提醒。
  async scan() {
    if (this.scanning) return [];
    this.scanning = true;
    const fresh = [];
    let changed = false;
    const started = Date.now();
    try {
      const now = this.d.now();
      const enabled = !!this.d.enabled();
      let sessions = [];
      try { sessions = enabled ? this.d.listSessions() || [] : []; } catch (error) { console.warn('[auto-resume] 巡逻取会话列表失败', error.message); return []; }
      const seen = new Set();
      for (const session of sessions) {
        if (!session || !session.id) continue;
        seen.add(session.id);
        let result;
        try { result = this.check(session, now); } catch (error) { console.warn('[auto-resume] 巡逻判定出错', session.id, error.message); continue; }
        if (result === 'new') { fresh.push(this.reminders.get(session.id)); changed = true; }
        else if (result === 'resolved' || result === 'updated') changed = true;
      }
      // 会话关了 / 总开关关了：提醒一并撤掉。
      for (const sid of [...this.reminders.keys()]) if (!seen.has(sid)) { this.resolve(sid, enabled ? '会话已关闭' : '自动续跑总开关已关'); changed = true; }
      for (const sid of [...this.candidates.keys()]) if (!seen.has(sid)) this.candidates.delete(sid);
    } catch (error) {
      console.warn('[auto-resume] 巡逻扫描出错', error.message);
    } finally {
      this.scanning = false;
      const took = Date.now() - started;
      if (took > 200) console.log(`[auto-resume] 巡逻扫描用时 ${took} ms`);
    }
    if (changed) { try { this.d.onChange(this.list()); } catch {} }
    for (const r of fresh) if (r && r.role !== 'member') { try { this.d.notify(r); } catch {} }
    return fresh;
  }

  // 一个会话：判一次，按「首次看到 → 隔一个阈值再看一次还是同一个停顿 → 出提醒」推进。
  check(session, now) {
    const facts = { now, kind: session.kind, ...(this.d.facts(session.id, session) || {}) };
    // 正在干活、进程活着：不可能判停（判定里也会返回 working），不读记录文件。
    const busy = facts.turnActive && facts.processAlive !== false;
    const entries = !busy && session.transcriptPath ? this.d.readEntries(session.transcriptPath) || [] : [];
    const state = summarize(entries);
    const j = busy ? { stalled: false, code: 'working', reason: '正在干活' } : judgeStall(state, facts);
    const existing = this.reminders.get(session.id);
    if (!j.stalled) {
      this.candidates.delete(session.id);
      if (existing) { this.resolve(session.id, j.code === 'working' || existing.since !== state.lastAt ? '开出了新回合' : `不再像停住（${j.reason || j.code}）`); return 'resolved'; }
      return 'none';
    }
    const sig = `${session.id}|${j.since}|${j.cause}`;
    if (existing) {
      if (existing.sig === sig) { existing.idleMs = j.idleMs; existing.idleText = j.idleText; return 'same'; }
      this.resolve(session.id, '换了一个停顿'); // 新回合又停了：旧的撤掉，新的重新走二次确认
    }
    if (this.dismissed.has(`${session.id}|${j.since}`)) return 'dismissed';
    const cand = this.candidates.get(session.id);
    if (!cand || cand.sig !== sig) { this.candidates.set(session.id, { sig, firstAt: now }); return 'candidate'; }
    if (now - cand.firstAt < j.thresholdMs) return 'candidate';
    this.candidates.delete(session.id);
    const reminder = { id: `patrol:${session.id}:${j.since}`, sessionId: session.id, title: session.title || '未命名会话', kind: session.kind,
      role: facts.role || null, sig, cause: j.cause, label: j.label, action: j.action, evidence: j.evidence, since: j.since,
      idleMs: j.idleMs, idleText: j.idleText, at: now, canResume: j.action === 'remind' };
    this.reminders.set(session.id, reminder);
    this.log({ kind: 'patrol-remind', sessionId: session.id, title: reminder.title, cause: j.cause, label: j.label, action: j.action,
      evidence: j.evidence, since: j.since, idleMs: j.idleMs, role: reminder.role });
    return 'new';
  }

  // 点「续跑」前现读重判：最后一条记录时间仍是提醒那一回合、且仍判停住才算数。返回 { ok, reason }。
  recheck(sessionId) {
    const r = this.reminders.get(sessionId);
    if (!r) return { ok: false, reason: '提醒已经不在' };
    let session = null;
    try { session = (this.d.listSessions() || []).find(s => s && s.id === sessionId) || null; } catch {}
    if (!session) return { ok: false, reason: '会话已关闭' };
    const state = summarize(session.transcriptPath ? this.d.readEntries(session.transcriptPath) || [] : []);
    const j = judgeStall(state, { now: this.d.now(), kind: session.kind, ...(this.d.facts(session.id, session) || {}) });
    if (state.lastAt !== r.since) return { ok: false, reason: '会话之后又有了新记录' };
    if (!j.stalled) return { ok: false, reason: j.reason || j.code };
    return { ok: true };
  }

  resolve(sessionId, reason) {
    const r = this.reminders.get(sessionId);
    if (!r) return false;
    this.reminders.delete(sessionId);
    this.log({ kind: 'patrol-resolved', sessionId, title: r.title, cause: r.cause, since: r.since, reason });
    return true;
  }

  dismiss(sessionId) {
    const r = this.reminders.get(sessionId);
    if (!r) return false;
    this.dismissed.add(`${sessionId}|${r.since}`);
    this.reminders.delete(sessionId);
    this.log({ kind: 'patrol-dismiss', sessionId, title: r.title, cause: r.cause, since: r.since });
    try { this.d.onChange(this.list()); } catch {}
    return true;
  }

  get(sessionId) { return this.reminders.get(sessionId) || null; }
  // 面板用：故障类（可续）在前，停得久的在前。
  list() {
    const rank = r => (r.action === 'remind' ? 0 : 1);
    return [...this.reminders.values()].sort((a, b) => rank(a) - rank(b) || a.since - b.since).map(r => ({ ...r }));
  }
}

module.exports = { Patrol };
