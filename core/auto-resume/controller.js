'use strict';
// 自动续跑 P0 主控：后台任务快照 + Hub 重启 / CLI 重开后叫醒。
//
// 触发只有一个真信号：Claude CLI 的 SessionStart(source=resume/startup) hook（onCliStarted）。
// 每次 SessionStart 记一个「CLI 代次」= 原生会话 id + 启动时刻（真实 Claude 进程的代次；外层 PowerShell 的进程号
// 在同一外壳里重开 Claude 时不变，不能用——返工单 1 第 9 条）。回合结束时把当时的代次记进快照。
//
// 是谁把 CLI 拉起来的决定发不发（返工单 1 第 1 条）：
//   - Hub 后台恢复（启动扫描、重启续作恢复、重启卡、openInBackground 的恢复）先调 expectBackground 打标记 → 自动发；
// Hub 启动时另做一次扫描（bootScan）：上个 Hub 进程退出时还开着、挂着后台任务的会话，在后台恢复后再判。
//
// 每一步：等 CLI 站稳（settle）→ 判定（decide.js）→ 统一认领（claims.js，防双发）→ 拿发送名额 →
// 经闭环提交入口发续跑语；真正写入前 shouldWrite 再判一次全部排除条件（返工单 1 第 3 条）。
// 送达不明 → 「需核对」不重发、也不走后台补发（noStuckRecovery）；明确没发出去 → 1/5/15 分钟退避，最多 3 次。
// 「同时最多 2 个」= 同时处在「正在发续跑语、还没收到新回合开工确认」的会话数；收到确认（新回合开出）即释放名额，
// 与已经在跑的 CLI 总数无关。错峰 60 秒两处：相邻两次开工（后台拉起冷启动 CLI 抢 CPU），以及拿到名额之后、
// 实际发送之前（返工单 2 第 5 条：旧版间隔只卡在排队处，两个任务等名额后会同一毫秒发出）。
//
// 后台标记（返工单 2 第 1 条）：每次后台恢复发一个标记，只认紧接着的那一次 SessionStart；恢复失败、
// 不带标记）→ 排队的任务改成「亲手打开」：不自动发，给按钮。
//
// 认领交接（返工单 2 第 4 条）：认领之后写入前复核变成「在等你拍板 / 你亲自打开」这类可一键续跑的未续，
const { SnapshotStore } = require('./snapshots');
const { AutoResumeLedger } = require('./ledger');
const { claimResume, peekClaim, pruneClaims, handoffClaim, releaseClaim, claimSession, renewSession, holdsSession, releaseSession, leaseRetryDelay, readLease, ownerLabel } = require('./claims');
const { decideAutoResume, resumeText, patrolResumeText, STOP_INTENT } = require('./decide');

const OWNER = 'auto-resume';
const HANDOFF = 'user-button-ready';
const BACKGROUND_MARK_MS = 2 * 60_000;
const MAX_LEASE_WAITS = 10;
// 重查时会话已开出新回合 → 算对方续上了。
const CONTINUED_CODES = new Set(['new-turn', 'turn-active', 'snapshot-changed']);
const sleep = ms => new Promise(resolve => { const t = setTimeout(resolve, Math.max(0, ms)); t.unref?.(); });
const defaultAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

class AutoResume {
  constructor(deps = {}, { settleMs = 6000, spacingMs = 60_000, maxSending = 2, retryDelaysMs = [60_000, 300_000, 900_000] } = {}) {
    if (!deps.dataDir) throw new Error('自动续跑缺少数据目录');
    this.d = { hubPid: process.pid, now: Date.now, enabled: () => true, isAlive: defaultAlive,
      getLive: () => null, loadMeta: () => null, isTurnActive: () => false, userInputAt: () => 0,
      accountSwitching: () => false, accountRisk: () => false, readFirstPrompt: () => '', readLastReply: () => '',
      resumeSession: async () => null, sendPrompt: async () => ({ ok: false, notSent: true, message: '未接入发送' }), report: () => {}, ...deps };
    Object.assign(this, { settleMs, spacingMs, maxSending, retryDelaysMs });
    this.store = new SnapshotStore({ dataDir: deps.dataDir, now: this.d.now });
    this.ledger = new AutoResumeLedger({ dataDir: deps.dataDir, now: this.d.now });
    this.queue = []; this.running = new Set(); this.handled = new Set(); this.lastStartAt = 0; this.lastSendAt = 0; this.timer = null; this.markSeq = 0;
    this.cliGens = new Map(); this.background = new Map();
    this.sending = 0; this.slotWaiters = [];
    this.closed = false;
  }

  // —— hook 与会话事件：只更新快照 ——
  onStop({ sessionId, ccSessionId = null, tasks = [], turnId = null, at = this.d.now() } = {}) {
    try { return this.store.recordStop({ sessionId, ccSessionId, tasks, turnId, hubPid: this.d.hubPid, cliGen: this.cliGens.get(sessionId) || null, at }); }
    catch (error) { console.warn('[auto-resume] 快照写入失败', error.message); return null; }
  }
  onPrompt(sessionId, at = this.d.now()) { this._mark(sessionId, 'supersededAt', at); }
  onUserInput(sessionId, at = this.d.now(), kind = 'input') {
    if (kind === 'esc') { this._safe(() => this.store.setIntent(sessionId, 'esc', at)); return; }
    if (kind === 'submit') this._safe(() => this.store.clearIntent(sessionId));
    this._mark(sessionId, 'userInputAt', at);
  }
  onNeedsInput(sessionId, at = this.d.now()) { this._mark(sessionId, 'needsInputAt', at); }
  onAuthError(sessionId, at = this.d.now()) { this._mark(sessionId, 'authErrorAt', at); }
  onSuspended(sessionId, reason) {
    if (!reason || reason === 'shutdown-cancelled') return; // Hub 退出时的进程清理不算休眠
    if (STOP_INTENT.has(reason)) this._safe(() => this.store.setIntent(sessionId, reason));
    else this._mark(sessionId, 'suspendedReason', reason);
  }
  onClosed(sessionId) { this._safe(() => this.store.forget(sessionId)); }
  _mark(sessionId, field, value) { this._safe(() => this.store.mark(sessionId, field, value)); }
  _safe(fn) { try { return fn(); } catch (error) { console.warn('[auto-resume] 快照更新失败', error.message); return null; } }

  // 返回撤销函数：恢复失败、或站稳后没等到 SessionStart，调用方立刻撤掉，只撤自己打的那一个。
  expectBackground(sessionId) {
    if (!sessionId) return () => false;
    const mark = { at: this.d.now(), token: ++this.markSeq };
    this.background.set(sessionId, mark);
    return () => this.clearBackground(sessionId, mark.token);
  }
  clearBackground(sessionId, token) {
    const mark = this.background.get(sessionId);
    if (!mark || (token != null && mark.token !== token)) return false;
    this.background.delete(sessionId); return true;
  }
  takeBackground(sessionId) {
    const mark = this.background.get(sessionId);
    this.background.delete(sessionId);
    return !!mark && this.d.now() - mark.at < BACKGROUND_MARK_MS;
  }

  // 中断出在哪：快照所在的 Hub 进程已经没了 → Hub 重启；还在（本进程或另一个多开的 Hub）→ CLI 进程重开。
  interruptionOf(snap) {
    if (snap.hubPid !== this.d.hubPid && !this.d.isAlive(snap.hubPid)) return { trigger: 'hub-restart', interruption: `hub-${snap.hubPid}`, batch: `hub-${snap.hubPid}` };
    return { trigger: 'cli-reopen', interruption: `cli-${snap.cliGen || snap.at}`, batch: `cli-${snap.sessionId}-${snap.at}` };
  }

  // CLI 起来了（SessionStart hook）。只认 resume/startup（/clear、/compact 不是新进程）。
  onCliStarted(sessionId, { ccSessionId = null, source = null, forkedFrom = null, at = this.d.now() } = {}) {
    if (this.closed || !['resume', 'startup'].includes(source)) return false;
    const gen = `${ccSessionId || '?'}@${at}`;
    this.cliGens.set(sessionId, gen);
    const background = this.takeBackground(sessionId);
    const snap = this.store.get(sessionId);
    if (!snap || snap.cliGen === gen) return false;
    const where = this.interruptionOf(snap);
    // 错峰等待期间亲手点开）→ 任务改成亲手打开，不自动发、给按钮（返工单 2 第 1 条）。
    const queued = this.queue.find(q => q.sessionId === sessionId) || [...this.running].find(q => q.sessionId === sessionId);
    if (queued) {
      if (!queued.cliGen) queued.cliGen = gen;
      queued.cliStarted ||= { ccSessionId, forkedFrom };
      if (!background) queued.origin = 'manual';
      return false;
    }
    return this.enqueue({ sessionId, ...where, origin: background ? 'background' : 'manual', cliStarted: { ccSessionId, forkedFrom }, snapAt: snap.at, cliGen: gen });
  }

  // Hub 启动：上个 Hub 进程退出时还开着、挂着后台任务的会话。之前就休眠了的不算这次重启的受害者，等它被重开时再判。
  // 发版重启时新 Hub 往往先起、旧 Hub 几十秒后才退：旧进程还活着的快照每 30 秒再看一次，最多看 10 分钟。
  bootScan({ rescanMs = 30_000, rescanForMs = 600_000 } = {}) {
    if (this.closed) return 0;
    if (!this.bootAt) {
      this.bootAt = this.d.now();
      try { pruneClaims(this.d.dataDir, { now: this.d.now() }); this.ledger.prune(); } catch {}
      // 过期快照文件落盘清理（返工单 2 第 6 条），停止意图留着。
      try { this.store.pruneExpired(); } catch (error) { console.warn('[auto-resume] 过期快照清理失败', error.message); }
    }
    let count = 0, waiting = false;
    for (const snap of this.store.all()) {
      if (snap.hubPid === this.d.hubPid || snap.suspendedReason) continue;
      const where = this.interruptionOf(snap);
      if (where.trigger !== 'hub-restart') { waiting = true; continue; }
      if (this.enqueue({ sessionId: snap.sessionId, ...where, origin: 'background', wake: true, snapAt: snap.at, cliGen: null })) count++;
    }
    if (waiting && this.d.now() - this.bootAt < rescanForMs) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = setTimeout(() => { try { this.bootScan({ rescanMs, rescanForMs }); } catch (error) { console.warn('[auto-resume]', error.message); } }, rescanMs);
      this.rescanTimer.unref?.();
    }
    return count;
  }

  enqueue(item) {
    const key = `${item.sessionId}|${item.interruption}`;
    if (this.handled.has(key) || [...this.running].some(q => q.sessionId === item.sessionId) || this.queue.some(q => q.sessionId === item.sessionId)) return false;
    this.queue.push({ ...item, key, attempts: 0, notBefore: this.d.now() + this.settleMs });
    this.pump();
    return true;
  }

  pump() {
    if (this.closed) return;
    clearTimeout(this.timer); this.timer = null;
    const now = this.d.now();
    let wait = Infinity;
    for (;;) {
      const ready = this.queue.filter(q => q.notBefore <= now);
      const next = ready.find(q => q.attempts > 0) || ready[0];
      if (!next) break;
      // 重试不占错峰间隔；首发相邻开工至少隔 spacingMs。
      const gap = next.attempts === 0 ? this.lastStartAt + this.spacingMs - now : 0;
      if (gap > 0) { wait = Math.min(wait, gap); break; }
      this.queue.splice(this.queue.indexOf(next), 1);
      if (next.attempts === 0) this.lastStartAt = now;
      this.running.add(next);
      void this.run(next).finally(() => { this.running.delete(next); this.pump(); });
    }
    for (const q of this.queue) wait = Math.min(wait, Math.max(0, q.notBefore - now));
    if (this.queue.length && Number.isFinite(wait)) { this.timer = setTimeout(() => this.pump(), Math.max(50, wait)); this.timer.unref?.(); }
  }

  async spacing() {
    const sendAt = Math.max(this.d.now(), this.lastSendAt + this.spacingMs);
    this.lastSendAt = sendAt;
    if (sendAt > this.d.now()) await sleep(sendAt - this.d.now());
  }

  async takeSlot() {
    if (this.sending < this.maxSending) { this.sending++; return; }
    await new Promise(resolve => this.slotWaiters.push(resolve));
    this.sending++;
  }
  releaseSlot() { this.sending = Math.max(0, this.sending - 1); const next = this.slotWaiters.shift(); if (next) next(); }

  sessionInfo(sessionId) {
    const live = this.d.getLive(sessionId);
    const meta = live || this.d.loadMeta(sessionId);
    if (!meta) return null;
    return { live: !!live, kind: meta.kind, title: meta.title || '未命名会话', meetingId: meta.meetingId || null,
      autoResumeDisabled: meta.autoResumeDisabled === true, suspendReason: meta.suspendReason || null, suspendedAt: meta.suspendedAt || 0,
      turnActive: !!live && !!this.d.isTurnActive(sessionId), accountRisk: !!this.d.accountRisk(meta), meta };
  }

  decide(item) {
    const snapshot = this.store.get(item.sessionId);
    const session = this.sessionInfo(item.sessionId);
    const held = peekClaim(this.d.dataDir, item.sessionId, item.interruption);
    const base = { enabled: !!this.d.enabled(), snapshot, now: this.d.now(), session, cliStarted: item.cliStarted || null,
      intent: this.store.intent(item.sessionId), userInputAt: this.d.userInputAt(item.sessionId) || 0,
      claimedBy: held && held.owner !== OWNER ? held.owner : null, accountSwitching: !!this.d.accountSwitching(item.sessionId),
      origin: item.origin, expectedSnapAt: item.snapAt ?? null, expectedCliGen: item.cliGen || null, currentCliGen: this.cliGens.get(item.sessionId) || null };
    const first = decideAutoResume(base);
    if (!first.send && !first.canResume) return { verdict: first, snapshot, session };
    if (item.firstPromptText === undefined) { try { item.firstPromptText = this.d.readFirstPrompt(session.meta) || ''; } catch { item.firstPromptText = ''; } }
    let lastReplyText = '';
    try { lastReplyText = this.d.readLastReply(session.meta) || ''; } catch {}
    return { verdict: decideAutoResume({ ...base, firstPromptText: item.firstPromptText, lastReplyText }), snapshot, session };
  }

  // 出错不吞：任何一步抛错都记成「未续：出错原因」，进账本和卡片（返工单 1 第 8 条）。
  async run(item) {
    try { return await this.runInner(item); }
    catch (error) {
      console.warn('[auto-resume]', error.message);
      let snapshot = null, session = null;
      try { snapshot = this.store.get(item.sessionId); session = this.sessionInfo(item.sessionId); } catch {}
      return this.finish(item, { verdict: { code: 'error', reason: '' }, snapshot, session }, 'failed', `自动续跑出错：${error.message}`);
    }
  }

  async runInner(item) {
    if (this.closed) return 'closed';
    // 休眠中的会话（Hub 普通启动）：先判一次，过了才在后台恢复；恢复后等 CLI 站稳再判一次。
    if (item.wake && !this.d.getLive(item.sessionId)) {
      const pre = this.decide(item);
      if (!pre.verdict.send) return this.finish(item, pre, 'skipped');
      const unmark = this.expectBackground(item.sessionId);
      try { await this.d.resumeSession(item.sessionId); }
      catch (error) { unmark(); return this.finish(item, pre, 'failed', `后台恢复会话失败：${error.message}`); }
      if (!this.d.getLive(item.sessionId)) { unmark(); return this.finish(item, pre, 'failed', '后台恢复会话失败'); }
      await sleep(this.settleMs);
      if (!item.cliGen) item.cliGen = this.cliGens.get(item.sessionId) || null;
      unmark(); // 站稳了还没等到 SessionStart：标记不留，后面哪次启动都不再算后台
    }
    const checked = this.decide(item);
    if (!checked.verdict.send) {
      const note = item.blockedBy && CONTINUED_CODES.has(checked.verdict.code) ? `已由${ownerLabel(item.blockedBy)}续上（${checked.verdict.reason}）` : null;
      return this.finish(item, checked, 'skipped', note);
    }
    if (!item.claimed) {
      const claim = claimResume(this.d.dataDir, item.sessionId, item.interruption, OWNER, { now: this.d.now() });
      // 自己以前认领过（上个 Hub 进程发到一半就退出了）：可能已经发出，按需核对处理，不再发。
      if (!claim.ok && claim.by === OWNER) return this.finish(item, checked, 'uncertain', '上次自动续跑可能已经发出（Hub 中途退出），未重发，请到会话里看一眼');
      if (!claim.ok) return this.finish(item, { ...checked, verdict: decideAutoResume({ snapshot: checked.snapshot, session: checked.session, now: this.d.now(), claimedBy: claim.by }) }, 'skipped');
      item.claimed = true;
    }
    // 不算已续（返工 1）：保留快照和认领，等对方租约到期后重查。
    const lease = claimSession(this.d.dataDir, item.sessionId, OWNER, { now: this.d.now(), note: item.trigger });
    if (!lease.ok) return this.waitLease(item, checked, lease);
    const token = lease.token;
    item.attempts++;
    let receipt, last = checked, gateCalls = 0, lostLease = false;
    const keep = () => { if (!lostLease && !renewSession(this.d.dataDir, item.sessionId, token, { now: this.d.now() })) lostLease = true; return !lostLease; };
    await this.takeSlot();
    // 等名额可能很久：拿到名额先续租，续不上（过期被别人拿走）就不写，按「被挡」处理。
    keep();
    // 错峰（P2：移到 CLI 就绪之后、首次写入之前）：写入链路就绪后调 beforeWrite，这里先占住发送时刻再等，等完续租，写入链路再复核一次。
    const beforeWrite = async () => { await this.spacing(); keep(); };
    try {
      if (lostLease) receipt = { ok: false, notSent: true, message: '租约已过期' };
      else receipt = await this.d.sendPrompt(item.sessionId, resumeText(item.trigger), `auto-resume:${item.key}:${item.attempts}`.slice(0, 160), {
        beforeWrite,
        shouldWrite: () => {
          gateCalls++;
          if (lostLease || !holdsSession(this.d.dataDir, item.sessionId, token, { now: this.d.now() })) { lostLease = true; return false; }
          last = this.decide(item); return last.verdict.send;
        },
      });
    } catch (error) { receipt = { ok: false, notSent: !!error.notSent, message: error.message }; }
    finally { this.releaseSlot(); }
    // 复核拒绝但正文已经写进输入框（Codex 编辑器回填后）：按「已写入、结果不明」处理，不还租约、不交按钮（返工 1 第 7 条）。
    if ((lostLease || !last.verdict.send) && receipt?.written === true) {
      return this.finish(item, checked, 'uncertain', `续跑语已写进输入框但没提交（${receiptText(receipt) || '复核未通过'}），未重发，请到会话里看一眼`);
    }
    if (lostLease) {
      this._safe(() => releaseSession(this.d.dataDir, item.sessionId, token));
      item.attempts--;
      const holder = readLease(this.d.dataDir, item.sessionId);
      return this.waitLease(item, checked, holder ? { by: holder.owner, until: holder.until } : { by: 'busy' });
    }
    if (!last.verdict.send) {
      this._safe(() => releaseSession(this.d.dataDir, item.sessionId, token));
      // 复核拦下、一个字没写：可一键续跑的未续把认领交给按钮，按钮才点得动。
      if (last.verdict.canResume && gateCalls > 0) { try { handoffClaim(this.d.dataDir, item.sessionId, item.interruption, OWNER, HANDOFF, { now: this.d.now() }); } catch {} }
      return this.finish(item, last, 'skipped');
    }
    const outcome = classifyReceipt(receipt);
    if (outcome === 'sent') return this.finish(item, checked, 'resumed', '已发续跑语，已收到开工确认');
    if (outcome === 'uncertain') return this.finish(item, checked, 'uncertain', `送达结果不明（${receiptText(receipt) || '没有拿到开工确认'}），未重发，请到会话里看一眼`);
    this._safe(() => releaseSession(this.d.dataDir, item.sessionId, token)); // 明确没发出去：租约还回去
    if (item.attempts > this.retryDelaysMs.length) return this.finish(item, checked, 'failed', `连续 ${item.attempts} 次没发出去：${receiptText(receipt)}`);
    const delay = this.retryDelaysMs[item.attempts - 1];
    this.record(item, checked.session, 'retrying', 'not-sent', `没发出去（${receiptText(receipt)}），${Math.round(delay / 60000)} 分钟后重试第 ${item.attempts} 次`);
    this.queue.push({ ...item, notBefore: this.d.now() + delay });
    return 'retrying';
  }

  waitLease(item, checked, lease) {
    item.blockedBy = lease.by && !['busy', 'error'].includes(lease.by) ? lease.by : (item.blockedBy || lease.by);
    item.leaseWaits = (item.leaseWaits || 0) + 1;
    const who = ownerLabel(item.blockedBy);
    if (item.leaseWaits > MAX_LEASE_WAITS) return this.finish(item, checked, 'failed', `${who}一直占着这个会话，等了 ${MAX_LEASE_WAITS} 轮没续上，请到会话里看一眼`);
    const delay = leaseRetryDelay(lease, this.d.now());
    this.record(item, checked.session, 'retrying', 'lease-busy', `${who}正在给它发，等它发完（约 ${Math.max(1, Math.round(delay / 60000))} 分钟）再看是否已续上`);
    this.queue.push({ ...item, notBefore: this.d.now() + delay });
    return 'retrying';
  }

  finish(item, { verdict, snapshot, session }, action, note = null) {
    this.handled.add(item.key);
    // 只清这次任务绑定的那份快照（入队时的 snapAt）：期间又有新回合结束写了新快照就留着，按新情况另判。
    const own = item.snapAt ?? snapshot?.at;
    if (own != null) this._safe(() => this.store.drop(item.sessionId, own));
    const canResume = action === 'skipped' && !!verdict?.canResume;
    this.record(item, session, action, action === 'skipped' ? verdict.code : (verdict?.code === 'error' ? 'error' : action), note || verdict.reason, snapshot, { canResume });
    return action;
  }

  record(item, session, action, code, reason, snapshot = null, extra = {}) {
    const event = { batch: item.batch, trigger: item.trigger, interruption: item.interruption, sessionId: item.sessionId,
      title: session?.title || item.title || '未命名会话', action, code, reason, attempts: item.attempts || 0,
      ...(extra.canResume ? { canResume: true } : {}), ...(item.by ? { by: item.by } : {}),
      ...(snapshot ? { tasks: snapshot.tasks.map(t => t.description || t.type || t.id).slice(0, 4), snapshotAt: snapshot.at } : {}) };
    let row = event;
    try { row = this.ledger.append(event); } catch (error) { console.warn('[auto-resume] 账本写入失败', error.message); }
    try { this.d.report(row); } catch (error) { console.warn('[auto-resume] 助理页卡片更新失败', error.message); }
    return row;
  }

  async resumeByUser({ sessionId, batch, trigger = 'cli-reopen', interruption = null, text = null } = {}) {
    const item = { sessionId, batch, trigger, interruption: interruption || `user-${this.d.now()}`, key: `${sessionId}|user|${batch}`, attempts: 0, by: 'user-button' };
    const fail = (reason, code = 'user-button') => this.record(item, this.sessionInfo(sessionId), 'failed', code, reason);
    try {
      if (!this.sessionInfo(sessionId)) return { ok: false, row: fail('会话已删除') };
      this._safe(() => this.store.clearIntent(sessionId)); // 他亲手点了续跑：本轮停止意图作废
      if (!this.d.getLive(sessionId)) {
        await this.d.resumeSession(sessionId);
        if (!this.d.getLive(sessionId)) return { ok: false, row: fail('会话没能恢复') };
      }
      if (this.d.isTurnActive(sessionId)) return { ok: false, row: fail('它已经在干活了，没有重复发') };
      let claim = claimResume(this.d.dataDir, sessionId, item.interruption, 'user-button', { now: this.d.now() });
      // 自动续跑认领后复核拦下、把认领交给了按钮：接过来。
      if (!claim.ok && claim.by === HANDOFF) claim = handoffClaim(this.d.dataDir, sessionId, item.interruption, HANDOFF, 'user-button', { now: this.d.now() });
      if (!claim.ok) return { ok: false, row: fail(claim.by === 'user-button' ? '已经点过续跑，没有重复发' : `${ownerLabel(claim.by)}已经接手，没有重复发`) };
      const lease = claimSession(this.d.dataDir, sessionId, 'user-button', { now: this.d.now(), note: trigger });
      if (!lease.ok) {
        this._safe(() => releaseClaim(this.d.dataDir, sessionId, item.interruption, 'user-button'));
        return { ok: false, retry: true, row: fail(`${ownerLabel(lease.by)}正在给它发续跑语，没有重复发；过几分钟还停着可以再点`) };
      }
      item.attempts = 1;
      let receipt;
      try { receipt = await this.d.sendPrompt(sessionId, text || resumeText(trigger), `auto-resume:user:${sessionId}:${batch}`.slice(0, 160), {}); }
      catch (error) { receipt = { ok: false, notSent: !!error.notSent, message: error.message }; }
      const outcome = classifyReceipt(receipt);
      const session = this.sessionInfo(sessionId);
      if (outcome === 'sent') return { ok: true, row: this.record(item, session, 'resumed', 'user-button', '你点了续跑，已收到开工确认') };
      if (outcome === 'uncertain') return { ok: false, row: this.record(item, session, 'uncertain', 'user-button', `送达结果不明（${receiptText(receipt) || '没有拿到开工确认'}），未重发`) };
      this._safe(() => releaseClaim(this.d.dataDir, sessionId, item.interruption, 'user-button'));
      this._safe(() => releaseSession(this.d.dataDir, sessionId, lease.token));
      return { ok: false, retry: true, row: fail(`没发出去：${receiptText(receipt)}，可以再点一次续跑`) };
    } catch (error) { return { ok: false, row: fail(`续跑出错：${error.message}`, 'error') }; }
  }

  startPatrol(deps = {}, options = {}) {
    if (this.patrol || this.closed) return this.patrol;
    const { Patrol } = require('./patrol');
    this.patrol = new Patrol({ now: this.d.now, enabled: this.d.enabled, ledger: this.ledger, autoSend: (r, o) => this.autoFromPatrol(r, o), ...deps }, options);
    if (options.autoStart !== false) this.patrol.start();
    return this.patrol;
  }
  // 巡逻提醒上的「续跑」：同一回合认领一次（patrol-<回合时间>），发带原因的续跑语，结果记进「近 3 天记录」。
  // 发之前（P1 返工单 1 第 1 条）：
  //   - 同会话 P0 自动续跑还在排队或在发 → 不发（巡逻认领 patrol-<回合> 和 P0 的 hub-/cli- 认领互不拦，这里显式互斥）；
  async resumeFromPatrol(sessionId) {
    const r = this.patrol?.get(sessionId);
    if (!r) return { ok: false, error: '这条提醒已经不在了（会话可能已接着干活）' };
    if (!r.canResume) return { ok: false, error: r.action === 'login' ? '需要先重新登录，续跑发不出去' : '在等额度，交给额度续跑 / 自动换号' };
    if (this.p0Busy(sessionId) || this.patrol.isPending(sessionId)) {
      return { ok: false, error: 'Hub 正在自动续跑这个会话，没有重复发' };
    }
    const fresh = this.patrol.recheck(sessionId);
    if (!fresh.ok) {
      this.patrol.resolve(sessionId, `点续跑前重判：${fresh.reason}`);
      try { this.patrol.d.onChange(this.patrol.list()); } catch {}
      return { ok: false, error: `它已经不像停住了（${fresh.reason}），没有发` };
    }
    const result = await this.resumeByUser({ sessionId, batch: `patrol-${sessionId}-${r.since}`, trigger: 'patrol', interruption: `patrol-${r.since}`, text: patrolResumeText(r.label) });
    if (result?.ok) { this.patrol.resolve(sessionId, '用户点了续跑'); this.patrol.clearAuto(sessionId); } // 亲手续跑：标红停手解除
    try { this.patrol.d.onChange(this.patrol.list()); } catch {}
    return result;
  }

  p0Busy(sessionId) { return this.queue.some(q => q.sessionId === sessionId) || [...this.running].some(q => q.sessionId === sessionId); }

  // P2 巡逻自动续（故障类 / 额度重置后）：与 P0、按钮、换号、软压缩共用同一套认领和租约，共用发送名额与错峰。
  // 返回 { outcome:'sent'|'uncertain'|'not-sent'|'skipped'|'blocked'|'deferred'|'declined', reason, retryAt }；结果另记一张卡（近 3 天记录）。
  async autoFromPatrol(r, { owner = 'patrol', key, label, attempt = 1 } = {}) {
    const sid = r.sessionId;
    const skip = reason => ({ outcome: 'skipped', reason });
    const quota = owner === 'quota-resume';
    const later = (outcome, reason, ms = 60_000) => ({ outcome, reason, retryAt: this.d.now() + ms });
    if (this.closed) return skip('Hub 正在退出');
    const allowed = () => this.patrol ? this.patrol.eligible(sid, { quota }) : { ok: !!this.d.enabled(), reason: '自动续跑总开关已关' };
    { const a = allowed(); if (!a.ok) return later('declined', a.reason); }
    if (this.p0Busy(sid)) return later('deferred', 'Hub 自动续跑正在处理这个会话');
    if (!this.d.getLive(sid)) return skip('会话不在运行');
    const fresh = this.patrol?.recheck(sid) || { ok: false, reason: '提醒已经不在' };
    if (!fresh.ok) return skip(fresh.reason);
    const claim = claimResume(this.d.dataDir, sid, key, owner, { now: this.d.now() });
    if (!claim.ok) return skip(claim.by === owner ? '这一回合已经自动续过' : `${ownerLabel(claim.by)}已经接手`);
    const blocked = held => {
      this._safe(() => releaseClaim(this.d.dataDir, sid, key, owner));
      return { outcome: 'blocked', by: held.by, label: ownerLabel(held.by), reason: `${ownerLabel(held.by)}正在给它发，等它发完再看`, retryAt: this.d.now() + leaseRetryDelay(held, this.d.now()) };
    };
    const lease = claimSession(this.d.dataDir, sid, owner, { now: this.d.now(), note: r.cause });
    if (!lease.ok) return blocked(lease);
    const token = lease.token;
    const item = { sessionId: sid, batch: `patrol-auto-${sid}-${r.since}`, trigger: 'patrol', interruption: key, key: `${sid}|patrol-auto|${key}`,
      attempts: attempt, by: owner === 'quota-resume' ? 'quota-resume' : 'patrol-auto', title: r.title };
    let receipt, gateOk = true, lostLease = false, declined = null;
    const keep = () => { if (!lostLease && !renewSession(this.d.dataDir, sid, token, { now: this.d.now() })) lostLease = true; return !lostLease; };
    await this.takeSlot();
    keep(); // 等名额可能很久：先续租，丢了就不写
    try {
      if (lostLease) receipt = { ok: false, notSent: true, message: '租约已过期' };
      else receipt = await this.d.sendPrompt(sid, patrolResumeText(label || r.label), `auto-resume:patrol:${sid}:${key}:${attempt}`.slice(0, 160), {
        beforeWrite: async () => { await this.spacing(); keep(); },
        shouldWrite: () => {
          if (lostLease || !holdsSession(this.d.dataDir, sid, token, { now: this.d.now() })) { lostLease = true; return false; }
          const a = allowed(); if (!a.ok) { declined = a.reason; return false; }
          gateOk = !!this.patrol?.recheck(sid)?.ok; return gateOk;
        },
      });
    } catch (error) { receipt = { ok: false, notSent: !!error.notSent, message: error.message }; }
    finally { this.releaseSlot(); }
    const session = this.sessionInfo(sid);
    const what = owner === 'quota-resume' ? '额度重置后自动续' : `巡逻自动续（第 ${attempt} 次）`;
    // 复核拒绝但正文已写进输入框：按结果不明，不还租约、不重发。
    if ((lostLease || !gateOk || declined) && receipt?.written === true) {
      this.record(item, session, 'uncertain', 'patrol-auto', `${what}：${r.label}，续跑语已写进输入框但没提交，未重发`);
      return { outcome: 'uncertain', reason: '已写入未提交' };
    }
    if (lostLease) {
      this._safe(() => releaseSession(this.d.dataDir, sid, token));
      const holder = readLease(this.d.dataDir, sid);
      return blocked(holder ? { by: holder.owner, until: holder.until } : { by: 'busy' });
    }
    if (declined) {
      this._safe(() => releaseSession(this.d.dataDir, sid, token)); this._safe(() => releaseClaim(this.d.dataDir, sid, key, owner));
      return later('declined', declined);
    }
    if (!gateOk) {
      this._safe(() => releaseSession(this.d.dataDir, sid, token)); this._safe(() => releaseClaim(this.d.dataDir, sid, key, owner));
      return skip('写入前重判：已经不像停住了');
    }
    const outcome = classifyReceipt(receipt);
    if (outcome === 'sent') { this.record(item, session, 'resumed', 'patrol-auto', `${what}：${r.label}，已收到开工确认`); return { outcome: 'sent' }; }
    if (outcome === 'uncertain') { this.record(item, session, 'uncertain', 'patrol-auto', `${what}：${r.label}，送达结果不明（${receiptText(receipt) || '没有拿到开工确认'}），未重发`); return { outcome: 'uncertain', reason: receiptText(receipt) }; }
    this._safe(() => releaseSession(this.d.dataDir, sid, token)); this._safe(() => releaseClaim(this.d.dataDir, sid, key, owner));
    return { outcome: 'not-sent', reason: receiptText(receipt) || '没发出去' };
  }

  close() { this.closed = true; clearTimeout(this.timer); clearTimeout(this.rescanTimer); this.timer = null; try { this.patrol?.stop(); } catch {} }
}

// 提交回执分三类：确认开工 / 明确没发出去（可重试）/ 不明（不重发）。
function classifyReceipt(receipt) {
  if (receipt?.ok === true && !receipt.notSent && receipt.sendStatus !== 'stuck') return 'sent';
  if (receipt?.notSent) return 'not-sent';
  return 'uncertain';
}
const receiptText = r => String(r?.message || r?.error || r?.reason || '').slice(0, 200);

module.exports = { AutoResume, classifyReceipt, OWNER, HANDOFF };
