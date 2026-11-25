'use strict';
// 自动续跑巡逻器：每 60 秒扫一遍已打开的会话，按 patrol-judge 判「疑似停住」，隔一个阈值二次确认后出提醒；
// 提醒进账本（auto-resume-ledger.jsonl，kind=patrol-*）和前台「当前概览 → 续跑」Tab。
//
//
// P2 自动续：
//     退避：第 1 次判停即发，第 2 次距上次 5 分钟，第 3 次距上次 15 分钟；连续 3 次续了没产出（又停）就停、标红。
//     续了之后正常结束（已交卷 / 等拍板 / 正常等后台任务）清零。明确没发出去不计次。
//   - 熔断：同一类报错 15 分钟内在 3 个不同会话出现 → 这一类停自动续 30 分钟。
//   - 额度：报错里读到重置时间、额度续跑开关开着、不是原生 stream-json 会话（那边已有额度续跑）→ 重置后 1 分钟自动续一次，与 mode 无关。
//
// 第二批返工 1：
//   - 「续了没产出」清零：上次自动续之后出现过正常干活（工具结果、或非报错回复后正常结束回合）就清零——夜里长任务偶发一次断线不累计。
//   - 每会话自动续次数、上次发送时间、标红停手，以及各类报错的熔断截止时间落盘（stateFile），Hub 重启后接着算；
//   - 被租约挡住（blocked）/ P0 正在处理（deferred）/ 发前资格变了（declined）都不算续过：到时再判。
//   - 额度分支同样：只有发出去（或结果不明）才算完成；被挡到期再看；没发出去同一停顿最多试 3 次。
const fs = require('node:fs');
const path = require('node:path');
const { summarize } = require('./transcript-state');
const { judgeStall, VERSION } = require('./patrol-judge');
const { parseResetAt } = require('./quota-reset');

const MIN = 60_000;
// 只续原因明确的故障类；说了等结果、阶段汇报后停这类靠语义判的仍只提醒。
const AUTO_CAUSES = new Set(['api-error', 'partial-reply', 'not-started', 'compact', 'hub-restart', 'cli-reopen']);
const BACKOFF_MS = [0, 5 * MIN, 15 * MIN];
const MAX_AUTO = 3;
const NOT_SENT_RETRY_MS = MIN;
const PRODUCTIVE = new Set(['delivered', 'asking-user', 'waiting-background']);
const BREAKER = { windowMs: 15 * MIN, sessions: 3, pauseMs: 30 * MIN };
const QUOTA_GRACE_MS = MIN;
const RECHECK = new Set(['blocked', 'deferred', 'declined']);

// 上次自动续之后是否正常干过活：有工具结果回来，或非报错的回复之后正常结束了回合。
function workedSince(entries, since) {
  let reply = false;
  for (const e of entries || []) {
    const at = Date.parse(e && e.timestamp);
    if (!(at > since)) continue;
    const content = e.message && e.message.content;
    if (e.type === 'user' && Array.isArray(content) && content.some(p => p && p.type === 'tool_result' && !p.is_error)) return true;
    if (e.type === 'assistant' && !e.isApiErrorMessage && !/^API Error|hit your .{0,20}limit/i.test(String((Array.isArray(content) ? content.map(p => (p && p.text) || '').join('') : content) || '').trim())) reply = true;
    if (e.type === 'system' && e.subtype === 'turn_duration' && reply) return true;
  }
  return false;
}

// 报错签名：网络类按错误名、HTTP 按状态码，其余归「其他」。
function faultSig(text) {
  const s = String(text || '');
  // 先认具体的错误码，再认笼统的说法（同一条报错常同时写「Connection error」和「ECONNRESET」）。
  for (const re of [/ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i, /overloaded/i, /socket hang up|Connection (?:lost|error|closed)|fetch failed/i]) {
    const m = re.exec(s);
    if (m) return m[0].toLowerCase().replace(/\s+/g, '-');
  }
  const http = /\b([45]\d\d)\b/.exec(s);
  if (http) return 'http-' + http[1];
  return 'other';
}
// 远程桌面、Hub 放在另一块屏上时窗口不一定是前台，人还在就算在看；人离开 10 分钟以上，选中的会话也照常自动续。
const VIEW_IDLE_MS = 10 * MIN;
function isViewing({ selected = false, windowFocused = false, minimized = false, idleMs = Infinity } = {}) {
  if (!selected || minimized) return false;
  return !!windowFocused || Number(idleMs) < VIEW_IDLE_MS;
}
const clock = at => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

class Patrol {
  // deps：
  //   now()、enabled()、listSessions() → [{ id, kind, title, transcriptPath, runtimeBackend }]（已打开、有 writer 的会话）
  //   facts(id, session) → judgeStall 的运行事实（role、processAlive、turnActive、needsInput、userInputAt、draftPending、intent、closed、autoResumeDisabled、interruption）
  //   readEntries(transcriptPath) → 会话记录末尾一段解析后的记录数组
  //   ledger（append）、onChange(list)、notify(reminder)（新提醒、非成员会话时调用）
  //   mode() → 'remind'|'auto'；quotaAutoResume() → bool
  //   autoSend(reminder, { owner, key, label, attempt }) → { outcome:'sent'|'uncertain'|'not-sent'|'skipped'|'blocked'|'deferred'|'declined', reason, retryAt }
  //   stateFile：自动续计数与熔断落盘的位置（不给就只在内存）
  constructor(deps = {}, { intervalMs = 60_000 } = {}) {
    this.d = { now: Date.now, enabled: () => true, listSessions: () => [], facts: () => ({}), readEntries: () => [],
      ledger: null, onChange: () => {}, notify: () => {}, mode: () => 'remind', quotaAutoResume: () => false, autoSend: null, stateFile: null, ...deps };
    this.intervalMs = intervalMs;
    this.candidates = new Map(); // sid → { sig, firstAt }
    this.reminders = new Map();  // sid → 提醒
    this.dismissed = new Set();  // `${sid}|${since}`
    this.auto = new Map();       // sid → { count, lastAt, retryAt }
    this.pending = new Set();    // 正在自动续的会话
    this.faults = [];            // { sig, sid, at }
    this.paused = new Map();     // sig → { until, sessions, at }
    this.timer = null; this.scanning = false;
    this.load();
  }

  // —— 落盘：{ auto: { sid: { count, lastAt, retryAt } }, paused: { sig: { until, sessions, at } } } ——
  load() {
    if (!this.d.stateFile) return;
    try {
      const s = JSON.parse(fs.readFileSync(this.d.stateFile, 'utf8'));
      for (const [sid, st] of Object.entries(s.auto || {})) if (st && st.count > 0) this.auto.set(sid, { count: st.count, lastAt: st.lastAt || 0, retryAt: 0 });
      const now = this.d.now();
      for (const [sig, b] of Object.entries(s.paused || {})) if (b && b.until > now) this.paused.set(sig, b);
    } catch {}
  }
  save() {
    if (!this.d.stateFile) return;
    try {
      const now = this.d.now();
      const data = { savedAt: now, auto: Object.fromEntries([...this.auto].filter(([, st]) => st.count > 0).map(([sid, st]) => [sid, { count: st.count, lastAt: st.lastAt }])),
        paused: Object.fromEntries([...this.paused].filter(([, b]) => b.until > now)) };
      fs.mkdirSync(path.dirname(this.d.stateFile), { recursive: true });
      const tmp = `${this.d.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.d.stateFile);
    } catch (error) { console.warn('[auto-resume] 巡逻状态落盘失败', error.message); }
  }
  clearAuto(sessionId) {
    if (!this.auto.has(sessionId)) return false;
    this.auto.delete(sessionId); this.save();
    const r = this.reminders.get(sessionId);
    if (r && r.autoStopped) { r.autoStopped = false; r._dirty = true; }
    return true;
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
        const r = this.reminders.get(session.id);
        if (r && r._dirty) { r._dirty = false; changed = true; }
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
    for (const r of fresh) if (r && r.role !== 'member' && !r.autoFiring) { try { this.d.notify(r); } catch {} }
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
    // 续了有产出：正常结束 / 上次自动续之后正常干过活 → 连续自动续次数清零（返工 1 第 5 条）。
    const st = this.auto.get(session.id);
    if (st && ((!j.stalled && PRODUCTIVE.has(j.code)) || (!busy && workedSince(entries, st.lastAt)))) this.clearAuto(session.id);
    if (!j.stalled) {
      this.candidates.delete(session.id);
      if (existing) {
        const moved = j.code === 'working' || existing.since !== state.lastAt;
        this.resolve(session.id, moved && existing.blockedBy ? `已由${existing.blockedLabel || existing.blockedBy}续上` : moved ? '开出了新回合' : `不再像停住（${j.reason || j.code}）`);
        return 'resolved';
      }
      return 'none';
    }
    const sig = `${session.id}|${j.since}|${j.cause}`;
    if (existing) {
      if (existing.sig === sig) { existing.idleMs = j.idleMs; existing.idleText = j.idleText; this.maybeAuto(existing, facts, now); return 'same'; }
      this.resolve(session.id, existing.blockedBy ? `已由${existing.blockedLabel || existing.blockedBy}续上，之后又停了` : '换了一个停顿'); // 新回合又停了：旧的撤掉，新的重新走二次确认
    }
    if (this.dismissed.has(`${session.id}|${j.since}`)) return 'dismissed';
    const cand = this.candidates.get(session.id);
    if (!cand || cand.sig !== sig) { this.candidates.set(session.id, { sig, firstAt: now }); return 'candidate'; }
    if (now - cand.firstAt < j.thresholdMs) return 'candidate';
    this.candidates.delete(session.id);
    const reminder = { id: `patrol:${session.id}:${j.since}`, sessionId: session.id, title: session.title || '未命名会话', kind: session.kind,
      role: facts.role || null, sig, cause: j.cause, label: j.label, action: j.action, evidence: j.evidence, since: j.since,
      idleMs: j.idleMs, idleText: j.idleText, at: now, canResume: j.action === 'remind', runtimeBackend: session.runtimeBackend || null };
    if (j.cause === 'api-error') reminder.faultSig = faultSig(state.errorText);
    if (j.cause === 'quota') reminder.resetAt = parseResetAt(state.errorText, j.since);
    this.reminders.set(session.id, reminder);
    this.log({ kind: 'patrol-remind', sessionId: session.id, title: reminder.title, cause: j.cause, label: j.label, action: j.action,
      evidence: j.evidence, since: j.since, idleMs: j.idleMs, role: reminder.role,
      ...(reminder.faultSig ? { faultSig: reminder.faultSig } : {}), ...(reminder.resetAt ? { resetAt: reminder.resetAt } : {}) });
    if (reminder.faultSig) this.noteFault(reminder.faultSig, session.id, now);
    this.maybeAuto(reminder, facts, now);
    return 'new';
  }

  // —— P2 熔断 ——
  noteFault(sig, sid, now) {
    this.faults = this.faults.filter(f => now - f.at < BREAKER.windowMs);
    this.faults.push({ sig, sid, at: now });
    const sessions = new Set(this.faults.filter(f => f.sig === sig).map(f => f.sid));
    const open = this.paused.get(sig);
    if (sessions.size >= BREAKER.sessions && !(open && open.until > now)) {
      this.paused.set(sig, { until: now + BREAKER.pauseMs, sessions: sessions.size, at: now });
      this.log({ kind: 'patrol-breaker', sig, sessions: sessions.size, until: now + BREAKER.pauseMs });
      this.save();
    }
  }
  breakers(now = this.d.now()) {
    return [...this.paused].filter(([, b]) => b.until > now).map(([sig, b]) => ({ sig, until: b.until, sessions: b.sessions,
      text: `同一类报错（${sig}）15 分钟内出现在 ${b.sessions} 个会话，像是服务端或网络整体出问题，这一类暂停自动续到 ${clock(b.until)}` }));
  }

  // —— P2 自动续：判断这条提醒现在该不该自动续；该就后台发（不阻塞扫描），结果回来再记。——
  maybeAuto(r, facts, now) {
    if (!r || this.pending.has(r.sessionId) || typeof this.d.autoSend !== 'function') return;
    const note = text => { if (r.autoNote !== text) { r.autoNote = text; r._dirty = true; } };
    if (r.blockedUntil && now < r.blockedUntil) return;
    if (r.cause === 'quota') {
      if (!this.d.quotaAutoResume() || r.runtimeBackend === 'claude-stream-json' || r.quotaDone) return;
      if (!r.resetAt) return note('没从报错里读到重置时间，额度恢复后请手动续');
      if (now < r.resetAt + QUOTA_GRACE_MS) return note(`额度 ${clock(r.resetAt)} 重置，到点后自动续一次`);
      if (r.retryAt && now < r.retryAt) return;
      return this.fire(r, { owner: 'quota-resume', key: `quota-${r.resetAt}`, label: '额度已重置', attempt: 1, quota: true });
    }
    if (this.d.mode() !== 'auto' || r.action !== 'remind' || !AUTO_CAUSES.has(r.cause)) return;
    if (facts.viewing) return note('你正在看这个会话，只提醒、不自动续');
    const open = r.faultSig && this.paused.get(r.faultSig);
    if (open && open.until > now) return note(`这一类报错已熔断，${clock(open.until)} 前不自动续`);
    const st = this.auto.get(r.sessionId) || { count: 0, lastAt: 0, retryAt: 0 };
    if (st.count >= MAX_AUTO) {
      if (!r.autoStopped) {
        r.autoStopped = true; r._dirty = true; r.autoNote = `连续 ${MAX_AUTO} 次续了没产出，已停自动续，请看一眼`;
        this.log({ kind: 'patrol-auto', sessionId: r.sessionId, title: r.title, cause: r.cause, since: r.since, attempt: st.count + 1, result: 'stopped' });
      }
      return;
    }
    // 这一个停顿已经续过（含送达结果不明、一直没新记录的）：不再续；满 3 次的上面已标红停手（E2E 实测：第 3 次结果不明时原来漏标）。
    if (r.autoTried) return;
    const due = Math.max(st.count ? st.lastAt + BACKOFF_MS[st.count] : now, st.retryAt || 0);
    if (now < due) return note(`${clock(due)} 自动续第 ${st.count + 1} 次`);
    this.fire(r, { owner: 'patrol', key: `patrol-${r.since}`, label: r.label, attempt: st.count + 1 });
  }

  fire(r, opts) {
    const sid = r.sessionId;
    this.pending.add(sid); r.autoFiring = true;
    const done = res => {
      const outcome = res?.outcome || 'skipped';
      const now = this.d.now();
      const sent = outcome === 'sent' || outcome === 'uncertain';
      if (RECHECK.has(outcome)) {
        // 被挡 / P0 在处理 / 发前资格变了：不算续过、不计次，到时再判（返工 1 第 1–3 条）。
        r.blockedUntil = Number(res.retryAt) > now ? Number(res.retryAt) : now + NOT_SENT_RETRY_MS;
        if (outcome === 'blocked' && res.by) { r.blockedBy = res.by; r.blockedLabel = res.label || null; }
      } else if (outcome === 'not-sent') {
        // 不计次，但同一个停顿连续 3 次都没发出去（CLI 进程没了、一直没就绪）就别每分钟再试了。
        r.notSentCount = (r.notSentCount || 0) + 1;
        r.retryAt = now + NOT_SENT_RETRY_MS;
        if (!opts.quota) { const st = this.auto.get(sid) || { count: 0, lastAt: 0 }; this.auto.set(sid, { ...st, retryAt: now + NOT_SENT_RETRY_MS }); }
        if (r.notSentCount >= MAX_AUTO) { r.autoTried = true; if (opts.quota) r.quotaDone = true; }
      } else if (opts.quota) r.quotaDone = true; // 发出去了 / 结果不明 / 现读重判已不停：这次重置不再续
      else if (sent) { this.auto.set(sid, { count: opts.attempt, lastAt: now, retryAt: 0 }); r.autoTried = true; this.save(); }
      else r.autoTried = true; // 现读重判不停了：这一回合不再自动续
      r.autoFiring = false; r._dirty = true;
      const why = res?.reason ? `（${res.reason}）` : '';
      r.autoNote = outcome === 'sent' ? (opts.quota ? '额度已重置，已自动续' : `已自动续第 ${opts.attempt} 次`)
        : outcome === 'uncertain' ? '已自动续，送达结果不明'
        : RECHECK.has(outcome) ? `${res?.reason || '暂时不续'}（${clock(r.blockedUntil)} 再看）`
        : outcome === 'not-sent' ? (r.autoTried ? `连续 ${MAX_AUTO} 次没发出去${why}，不再自动试，请打开会话看一眼` : `没发出去${why}，1 分钟后再试`) : `没自动续${why}`;
      this.log({ kind: 'patrol-auto', sessionId: sid, title: r.title, cause: r.cause, since: r.since, attempt: opts.attempt, owner: opts.owner, result: outcome, reason: res?.reason || null });
    };
    const task = Promise.resolve().then(() => this.d.autoSend(r, { owner: opts.owner, key: opts.key, label: opts.label, attempt: opts.attempt }))
      .then(done, error => done({ outcome: 'not-sent', reason: error.message }))
      .finally(() => { this.pending.delete(sid); try { this.d.onChange(this.list()); } catch {} });
    this.lastFire = task;
    return task;
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

  eligible(sessionId, { quota = false } = {}) {
    if (!this.d.enabled()) return { ok: false, reason: '自动续跑总开关已关' };
    if (quota) { if (!this.d.quotaAutoResume()) return { ok: false, reason: '额度续跑开关已关' }; }
    else if (this.d.mode() !== 'auto') return { ok: false, reason: '巡逻已切回只提醒' };
    let session = null;
    try { session = (this.d.listSessions() || []).find(s => s && s.id === sessionId) || null; } catch {}
    if (!session) return { ok: false, reason: '会话已关闭' };
    const facts = this.d.facts(sessionId, session) || {};
    if (facts.autoResumeDisabled) return { ok: false, reason: '这个会话关了自动续跑' };
    if (!quota && facts.viewing) return { ok: false, reason: '你正在看这个会话' };
    return { ok: true };
  }

  get(sessionId) { return this.reminders.get(sessionId) || null; }
  isPending(sessionId) { return this.pending.has(sessionId); }
  // 面板用：故障类（可续）在前，停得久的在前。
  list() {
    const rank = r => (r.action === 'remind' ? 0 : 1);
    return [...this.reminders.values()].sort((a, b) => rank(a) - rank(b) || a.since - b.since)
      .map(({ _dirty, ...r }) => ({ ...r, autoCount: this.auto.get(r.sessionId)?.count || 0 }));
  }
}

module.exports = { Patrol, faultSig, isViewing, workedSince, AUTO_CAUSES, BACKOFF_MS, MAX_AUTO, BREAKER, VIEW_IDLE_MS };
