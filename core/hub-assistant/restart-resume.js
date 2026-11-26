'use strict';
// Hub 重启后一键续跑：重启打断了哪些正在答题的会话，在助理对话流里出一张卡，点了才给它们各发一句继续。
//
// 「被打断」= 上一个 Hub 进程退出那一刻，会话的回合还在进行（CLI hook 报告的状态，不看屏幕）。两条线索：
//   1. 正常关闭：关闭流程一开始拍下此刻在答题的会话，退出前写成清单
//      <数据目录>/assistant/restart-resume/interrupted-<pid>.json，新 Hub 读完就删。
//   2. 崩溃或关机没走到关闭流程：用残留的周期快照 diagnostics/session-manifest-<pid>.json
//      （每 10 秒写一次，正常退出会删，所以留下来的就是没正常退出的进程）。
// 发版重启时新 Hub 往往先开、旧 Hub 几十秒后才关，所以新 Hub 监听清单目录，清单出现且写它的进程退出后出卡。
// 卡片是对话流里的一条记录（card: 'restart-resume'）；处理结果作为同一个 id 的新记录追加，读取时后一条替换前一条。
// 不在这里处理：会话当时不在答题、只是它起的后台等待或定时器被重启杀掉的情况。
const fs = require('node:fs');
const path = require('node:path');

const CARD = 'restart-resume';
const RESUME_TEXT = '继续。Hub 刚才重启，打断了你正在做的事。先自查再动手：1) 读进展卡和你最后一条回复，列出已完成和未完成；2) 核对最后一个工具操作的实际结果（文件、进程、远端作业），已完成的不要重做；3) 被重启杀掉的后台等待和定时任务要重新起：先确认要等的作业还在，再按原参数重挂监视，不要重跑作业本身；4) 下一步若涉及删除数据、花钱、对外发布、刷固件或要用户拍板，停下写明待确认；5) 任务其实已完成就只回 [[hub:no-update]]。然后从中断处接着做。';
const MAX_PARALLEL = 2;
// 「当前概览 → 续跑」Tab 列近几天的重启卡；每张卡的行状态短时缓存，Tab 每 20 秒刷新一次不必每次重读会话记录。
const LIST_DAYS = 3;
const ROW_CACHE_MS = 25_000;
const USER_OVERRIDABLE = new Set(['asking-user', 'needs-input', 'delivered', 'lead-active', 'dismissed']);
const { classifyReceipt } = require('../auto-resume/controller');
const fingerprint = text => require('node:crypto').createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
const overrideKey = st => `${st.code}|${st.evidence || ''}`;
const DONE_CARD_RE = /状态[:：]\s*(?:已完成|已交卷)/;
// 成员把结果交给负责人后停下（「回执已交给负责人」「已交负责人返修」「交卷：」）。
const DELIVERED_RE = /已交(?:给)?负责人|回执已交|已经?交卷|交卷[:：]|已提交给负责人|已交负责人/;
// 这个时刻之前的打断线索都已处理或作废（存在助理的数据库里，多开 Hub 共用）。
const WATERMARK = 'restartResume:watermark';
const LIST_RE = /^interrupted-(\d+)\.json$/;
const EXIT_WAIT_MS = 30_000;

const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const beijingTime = at => clock.format(new Date(at));
const names = rows => rows.map(row => row.title).join('、');
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// 普通工作会话含前台代开的任务和旧领域助理会话；前台、拍图助理和其他专用调度仍由各自机制管理。
function isOrdinarySession(meta) {
  if (!meta || meta.meetingId) return false;
  if (meta.purpose && !['hub-assistant-task', 'hub-assistant-desk'].includes(meta.purpose) && !require('../session-scenes').isScenePurpose(meta.purpose)) return false;
  return require('../ai-kinds').isAiKind(String(meta.kind || '').replace(/-resume$/, ''));
}

// 卡片的文字版：手机通知、语音识别背景和不认识这种卡的旧界面都用它。
function cardText(card) {
  const count = card.sessions.length, when = beijingTime(card.restartAt);
  if (card.state === 'dismissed') return `Hub ${when} 重启打断了 ${count} 个会话，没有继续：${names(card.sessions)}`;
  if (card.state === 'resuming') return `正在给 ${count} 个会话发继续（${card.results.length}/${count}）：${names(card.sessions)}`;
  if (card.state === 'resumed') {
    const sent = card.results.filter(r => r.ok), failed = card.results.filter(r => !r.ok);
    return [sent.length ? `已给 ${sent.length} 个会话发了继续：${names(sent)}` : '继续没有发出去', ...failed.map(r => `${r.title} 没发出去：${r.message}`)].join('；');
  }
  return `Hub ${when} 重启，打断了 ${count} 个正在干活的会话：${names(card.sessions)}`;
}

// 同一张卡的后一条记录替换前一条，在对话流里的位置保持首次出现时的。
// 自动续跑卡（auto-resume-card.js）用同一套折叠。
const FOLDED = new Set([CARD, 'auto-resume']);
function mergeCard(entries, entry) {
  const index = FOLDED.has(entry?.card) ? entries.findIndex(e => e.card === entry.card && e.id === entry.id) : -1;
  if (index < 0) entries.push(entry); else entries[index] = { ...entry, at: entries[index].at };
  return entries;
}
const foldCards = entries => entries.reduce((out, entry) => mergeCard(out, entry), []);

class RestartResume {
  constructor(assistant, { pid = process.pid, isAlive = require('../session-open-ownership').alive } = {}) {
    this.a = assistant; this.pid = pid; this.isAlive = isAlive;
    this.dir = path.join(assistant.deps.dataDir, 'assistant', CARD);
    this.diagnostics = path.join(assistant.deps.dataDir, 'diagnostics');
    this.captured = null; this.bootScanned = false; this.watcher = null; this.timer = null;
    this.running = new Map(); this.progress = new Map(); this.rowCache = new Map();
    this.maxParallel = MAX_PARALLEL; this.active = 0; this.waiters = []; this.inflight = new Set();
  }

  resumable(meta) { return isOrdinarySession(meta); }

  // 关闭流程一开始调用：此刻回合还在进行的普通会话。终端停下之后这个状态就没有了，所以先拍下来。
  capture() {
    const { deps } = this.a, mine = new Set(this.a.assistantIds());
    this.captured = (deps.getAllSessions?.() || [])
      .filter(s => deps.isAgentTurnActive?.(s.id) && !mine.has(s.id) && this.resumable(s))
      .map(s => ({ id: s.id, title: s.title || '未命名会话' }));
    return this.captured;
  }

  // 启动后开始等清单。延时的那一次兼顾「旧进程早就退出了」和崩溃残留。
  watch({ delayMs = 5000 } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    this.watcher = fs.watch(this.dir, { persistent: false }, () => this.schedule(300));
    this.watcher.on('error', error => console.warn('[assistant] restart-resume watch', error.message));
    this.schedule(delayMs);
  }
  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { try { this.scan(); } catch (error) { console.warn('[assistant] restart-resume', error.message); } }, ms);
    this.timer.unref?.();
  }
  // 停止监听；拍到过在答题的会话就落盘。走到这里终端都已停下，关闭中途被取消时不会留下清单。
  close() {
    clearTimeout(this.timer); this.watcher?.close(); this.watcher = null;
    if (!this.captured?.length) return;
    const file = path.join(this.dir, `interrupted-${this.pid}.json`);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, pid: this.pid, at: Date.now(), sessions: this.captured }));
    require('./atomic-rename').renameRetry(file + '.tmp', file);
    this.captured = null;
  }

  mark(at) { if (at > (this.a.store.get(WATERMARK) || 0)) this.a.store.set(WATERMARK, at); }

  scan(now = Date.now()) {
    let waiting = false;
    for (const name of fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : []) {
      const pid = Number(LIST_RE.exec(name)?.[1]), file = path.join(this.dir, name), list = pid ? readJson(file) : null;
      if (!list || !Array.isArray(list.sessions)) continue;
      // 写清单的进程还没退完：这些会话还归它，等它退出再出卡。
      if (this.isAlive(pid) && now - list.at < EXIT_WAIT_MS) { waiting = true; continue; }
      this.publish({ key: `${pid}:${list.at}`, at: list.at, sessions: list.sessions });
      this.mark(list.at);
      fs.rmSync(file, { force: true });
    }
    if (!this.bootScanned) { this.bootScanned = true; this.scanCrashed(now); }
    if (waiting) this.schedule(500);
  }

  // 崩溃或关机：上次检查之后才停止刷新的周期快照，就是那个进程最后的状态。
  scanCrashed(now) {
    const since = this.a.store.get(WATERMARK);
    this.mark(now);
    if (!since) return; // 第一次运行：以前留下的残留不追溯
    const { MANIFEST_FRESH_MS } = require('../session-manifest-exchange');
    for (const name of fs.existsSync(this.diagnostics) ? fs.readdirSync(this.diagnostics) : []) {
      if (!/^session-manifest-\d+\.json$/.test(name)) continue;
      const manifest = readJson(path.join(this.diagnostics, name));
      if (!manifest || !Array.isArray(manifest.sessions) || !(manifest.writtenAt > since) || now - manifest.writtenAt <= MANIFEST_FRESH_MS) continue;
      // pty-turn-unfinished = 终端里的 CLI 经 hook 报告回合还在进行。
      this.publish({ key: `${manifest.pid}:${manifest.writtenAt}`, at: manifest.writtenAt, sessions: manifest.sessions.filter(s => s.blockReason === 'pty-turn-unfinished') });
    }
  }

  // 出卡前再看一眼现在的情况：已经删掉的、不是普通会话的、打断之后已经接着干或答完一轮的、之后被关掉的，都不列。
  eligible(rows, at) {
    const { deps } = this.a, mine = new Set(this.a.assistantIds()), out = [];
    for (const row of rows) {
      const meta = this.a.sessionMetadata(row.id);
      if (!meta || mine.has(row.id) || !this.resumable({ ...meta, id: row.id })) continue;
      if (deps.isAgentTurnActive?.(row.id) || meta.lastCompletedAt > at) continue;
      if (!deps.getSession(row.id) && meta.suspendReason === 'user-close' && meta.suspendedAt > at) continue;
      out.push({ id: row.id, title: meta.title || row.title || '未命名会话' });
    }
    return out;
  }

  publish({ key, at, sessions }) {
    const rows = this.eligible(sessions, at);
    if (!rows.length) return null;
    const card = { id: `${CARD}:${key}`, role: 'system', card: CARD, restartAt: at, sessions: rows, state: 'pending' };
    card.text = cardText(card);
    // 通知表的主键保证同一次重启只出一张卡（多开 Hub 时也只有一个写得进去）；手机经这条通知看到同一段文字。
    if (!this.a.watches.addNotice({ id: card.id, title: 'Hub 重启', kind: CARD, label: '重启续跑', text: card.text })) return null;
    return this.a.logDialog(card);
  }

  // 对话流读取：每张卡只留最新状态；正在发送的卡显示实时进度。
  view(entries) {
    const out = foldCards(entries);
    for (const live of this.progress.values()) mergeCard(out, live);
    return out;
  }

  // 卡片上的两个按钮。只有还没处理过的卡能点；正在发送时再点，等的是同一次发送。
  async act({ id, action } = {}) {
    if (this.running.has(id)) return this.running.get(id);
    const card = foldCards(this.a.dialog.recent({ limit: 2000 })).find(e => e.card === CARD && e.id === id);
    if (!card) throw new Error('这张卡已经不在对话记录里');
    if (card.state !== 'pending') return { ok: true, card };
    if (action === 'dismiss') return { ok: true, card: this.settle(card, { state: 'dismissed' }) };
    if (action !== 'resume') throw new Error('未知操作');
    const job = this.resumeAll(card).finally(() => this.running.delete(id));
    this.running.set(id, job);
    return job;
  }

  settle(card, change) {
    const { at: _at, ...rest } = card, next = { ...rest, ...change };
    next.text = cardText(next);
    this.a.watches.markRead(card.id);
    return this.a.logDialog(next);
  }

  // 对话流「全部继续」：与 Tab「全部续跑」同一套判定（审查 P1-1：旧入口不看防误续规则），不该续的行带原因记为未续。
  async resumeAll(card) {
    this.prepare();
    const results = await this.runPool(card.sessions, card, 'batch', done => {
      const live = { ...card, state: 'resuming', results: [...done] };
      live.text = cardText(live); this.progress.set(card.id, live);
      try { this.a.deps.onDialogEntry?.(live); } catch {}
    });
    this.progress.delete(card.id);
    return { ok: true, card: this.saveResults(card.id, results) };
  }

  // 结果按原顺序排。所有入口（对话流卡片、Tab 全部续跑、Tab 单行）共用一个名额池：同时最多 maxParallel 个在恢复、发续跑语（审查 P2-5）。
  async runPool(rows, card, mode, onProgress = () => {}) {
    const results = new Array(rows.length), done = [];
    onProgress(done);
    await Promise.all(rows.map(async (row, i) => {
      await this.slot();
      try { results[i] = { id: row.id, title: row.title, ...await this.resumeOne(row, card, mode) }; }
      finally { this.unslot(); }
      done.push(results[i]); onProgress(done);
    }));
    return results;
  }
  slot() { if (this.active < this.maxParallel) { this.active++; return Promise.resolve(); } return new Promise(resolve => this.waiters.push(resolve)); }
  unslot() { const next = this.waiters.shift(); if (next) next(); else this.active--; }

  // 不用 Tab 刷新时建的缓存（Codex 复审 R1）。
  // 单行覆盖只认点击那一刻的证据（row.override = 当时的未续原因 + 证据指纹：哪条回复、哪版进展卡、哪次确认窗口）：
  // 之后又点了「不用了」、冒出新的提问（哪怕同样是提问）、卡片改了，这次点击的授权就作废，要重新点（Codex 三审、四审 T1）。
  // 点击时是「待续」的，后来变成要判断的，同样不发。
  allowed(row, card, mode, { fresh = false, authorize = false } = {}) {
    const latest = fresh ? (this.cards(Infinity).find(c => c.id === card.id) || card) : card;
    const st = this.rowState(row, latest, { fresh });
    if (st.action === 'interrupted') return { ok: true, st };
    if (mode === 'single' && st.canResume && st.action === 'skipped' && USER_OVERRIDABLE.has(st.code) && (authorize || row.override === overrideKey(st))) return { ok: true, st };
    return { ok: false, st };
  }

  // 发一句续跑语。三重保护：同一次重启的认领（claimResume，与自动续跑 P0 互斥）、会话级租约（claimSession，与巡逻、额度、换号互斥，
  // 审查 P1-3）、真正写入前复核（shouldWrite，审查 P1-1）。回执分三类（与自动续跑同一口径，审查 P1-2）：
  // 确认开工 → 已续；明确没发出去（notSent）→ 交还认领，可再点；其余（未确认、发送中途异常）→ 送达不明，保留认领、不重发。
  async resumeOne(row, card, mode = 'batch') {
    const { deps } = this.a, claims = require('../auto-resume/claims');
    const fail = (message, extra = {}) => ({ ok: false, message, ...extra });
    if (this.inflight.has(row.id)) return fail('另一个按钮正在给它发续跑语，没有重复发', { busy: true });
    this.inflight.add(row.id);
    const oldPid = Number(String(card.id).split(':')[1]) || card.restartAt, interruption = `hub-${oldPid}`;
    let claimed = false, lease = null, writing = false;
    // 确定没写出去（写入前被拦、恢复失败、明确 notSent）才交还认领和会话租约；已发或送达不明都留到租约自然过期，
    const giveBack = () => {
      if (claimed) claims.releaseClaim(deps.dataDir, row.id, interruption, 'restart-card'); claimed = false;
      if (lease?.ok) claims.releaseSession(deps.dataDir, row.id, lease.token); lease = null;
    };
    try {
      const first = this.allowed(row, card, mode, { fresh: true });
      if (!first.ok) return fail(first.st.reason);
      const meta = this.a.sessionMetadata(row.id);
      const claim = claims.claimResume(deps.dataDir, row.id, interruption, 'restart-card');
      if (!claim.ok) return fail(claim.by === 'auto-resume' ? '自动续跑已经给它发过续跑语，没有重复发'
        : claim.by === 'restart-card' ? '这次重启已经给它发过续跑语，没有重复发' : '另一条续跑通道已经接手，没有重复发');
      claimed = true;
      const got = claims.claimSession(deps.dataDir, row.id, 'restart-card', { note: card.id });
      if (!got.ok) { giveBack(); return fail(`${claims.ownerLabel(got.by)}正在处理它，这次没发；它处理完你可以再点`); }
      lease = got;
      if (!deps.getSession(row.id)) {
        // 只恢复能接回原对话的会话，不新建替代会话。在后台恢复：界面留在助理页，不跳到被唤醒的会话。
        if (!require('./live-history').nativeId(meta)) { giveBack(); return fail('找不到它的原生会话记录，没法恢复'); }
        await deps.resumeSession(row.id, null, { openInBackground: true });
        if (!deps.getSession(row.id)) { giveBack(); return fail('会话没能恢复'); }
      }
      // 恢复要时间，期间可能被关掉、开出新回合、换号被封：再判一次。
      const again = this.allowed(row, card, mode, { fresh: true });
      if (!again.ok) { giveBack(); return fail(again.st.reason); }
      claims.renewSession(deps.dataDir, row.id, lease.token);
      const token = lease.token;
      const shouldWrite = () => claims.holdsSession(deps.dataDir, row.id, token) && this.allowed(row, card, mode, { fresh: true }).ok;
      writing = true;
      // 提交编号只能是字母数字、下划线和连字符：带冒号时会话刚恢复、要随消息补发规则或记忆索引就被拒「提交编号无效」（2026-11-26 E2E 抓到）。
      const receipt = await deps.sendPrompt(row.id, RESUME_TEXT, `${card.id}-${row.id}`.replace(/[^\w-]/g, '-').slice(0, 160), { shouldWrite, noStuckRecovery: true });
      const outcome = classifyReceipt(receipt), text = String(receipt?.message || receipt?.error || receipt?.reason || '').slice(0, 200);
      if (outcome === 'sent') return { ok: true };
      if (outcome === 'not-sent') { giveBack(); return fail(text || '没发出去'); }
      return fail(`送达结果不明（${text || '没收到开工确认'}），请到会话里看一眼；没有重发`, { uncertain: true });
    } catch (error) {
      // 写入开始之前出错：确定没发，交还认领；写入中途出错：可能已写出，按送达不明处理。
      if (!writing) { giveBack(); return fail(error.message); }
      return fail(`送达结果不明（${error.message}），请到会话里看一眼；没有重发`, { uncertain: true });
    } finally {
      this.inflight.delete(row.id);
    }
  }

  // 把这一批的结果并进卡片最新一版（不拿开始时的旧快照覆盖别的入口刚写的结果，审查 P2-5）。
  // 同一行多条结果按「已续 > 送达不明 > 没发出去」取，同级取新的；顺序跟卡片列的会话一致。
  // flip：对话流「全部继续」处理完卡就算处理过；Tab 的补续只有真发出去了才把还没处理的卡标成已续（否则对话流的「不用了」还能点）。
  saveResults(id, results, { flip = true } = {}) {
    const latest = this.cards(Infinity).find(c => c.id === id);
    if (!latest) return null;
    const rank = r => r.ok ? 2 : r.uncertain ? 1 : 0, pick = new Map();
    for (const r of [...(latest.results || []), ...results]) {
      if (r.busy) continue;
      const old = pick.get(r.id);
      if (!old || rank(r) >= rank(old)) pick.set(r.id, r);
    }
    const merged = latest.sessions.map(s => pick.get(s.id)).filter(Boolean).map(({ id: rid, title, ok, message, uncertain }) => ({ id: rid, title, ok, ...(ok ? {} : { message }), ...(uncertain ? { uncertain: true } : {}) }));
    const state = latest.state === 'dismissed' ? 'dismissed' : flip || merged.some(r => r.ok) ? 'resumed' : latest.state;
    const saved = this.settle(latest, { state, results: merged });
    this.rowCache.delete(id);
    return saved;
  }

  // ---------- 「当前概览 → 续跑」Tab（2026-11-26）----------
  // 旧版只在前台对话流里出卡；「续跑」Tab 只认自动续跑的快照和巡逻（巡逻只看打开着的会话），
  // 普通重启后会话全成了「未打开」，Tab 就显示 0。这里把近几天的重启卡按 Tab 的卡片格式交出去，每行带现在的状态。

  // 一行现在该怎么显示：已续上的、不该续的带原因；其余「待续」，带一键续跑。规则沿用自动续跑的防误续口径。
  rowState(row, card, { fresh = false } = {}) {
    const results = (card.results || []).filter(r => r.id === row.id && !r.busy), last = results[results.length - 1];
    if (results.some(r => r.ok)) return { action: 'resumed', code: 'sent', reason: '已发续跑语' };
    const { deps } = this.a, meta = this.a.sessionMetadata(row.id);
    const skip = (code, reason, extra = {}) => ({ action: 'skipped', code, reason, ...extra });
    if (!meta) return skip('deleted', '会话已被删除');
    if (deps.isAgentTurnActive?.(row.id)) return { action: 'resumed', code: 'working', reason: '重启后它已经在干活了，不用再续' };
    if (meta.lastCompletedAt > card.restartAt) return { action: 'resumed', code: 'continued', reason: '重启后它已经接着干完一轮' };
    if (results.some(r => r.uncertain) || (last && /没收到开工确认/.test(last.message || ''))) {
      return { action: 'uncertain', code: 'stuck', reason: (results.find(r => r.uncertain) || last).message };
    }
    const { STOP_INTENT } = require('../auto-resume/decide');
    if (STOP_INTENT.has(meta.suspendReason) && meta.suspendedAt > card.restartAt) {
      return skip('user-stop', meta.suspendReason === 'team-delivered' ? '重启后它已交卷离队' : '重启后被主动关闭');
    }
    let snap = null, intent = null;
    try { const store = new (require('../auto-resume/snapshots').SnapshotStore)({ dataDir: deps.dataDir }); snap = store.get(row.id); intent = store.intent(row.id); } catch {}
    if (intent) return skip('user-stop', intent.reason === 'esc' ? '这一轮你按过 Esc 停止' : '你主动关闭或休眠过它');
    if (meta.autoResumeDisabled) return skip('session-disabled', '这个会话关了自动续跑');
    if (meta.claudeProfile && deps.accountBlocked?.(meta.claudeProfile)) return skip('account', '账号不可用（到期、风控或已登出）：先换号再续');
    if (card.state === 'dismissed') return skip('dismissed', '你在重启卡上点过「不用了」', { canResume: true, evidence: `dismissed@${card.at || ''}` });
    if (snap?.needsInputAt && !snap.supersededAt) return skip('needs-input', '重启前停在授权或确认窗口（危险步骤待确认），先打开看一眼', { canResume: true, evidence: `input@${snap.needsInputAt}` });
    // 组队成员：负责人重启后已经在推进，就由负责人决定叫不叫它（它可能已派人接手），全部续跑不替负责人做主。
    const team = (this._teams || []).find(t => t.leadSid !== row.id && (t.members || []).some(m => m.sid === row.id && m.status === 'active'));
    const lead = team && this.a.sessionMetadata(team.leadSid);
    if (lead && (deps.isAgentTurnActive?.(team.leadSid) || lead.lastCompletedAt > card.restartAt)) {
      return skip('lead-active', `负责人「${String(lead.title || '').slice(0, 24)}」重启后已在推进，由它决定叫不叫这个成员`, { canResume: true, evidence: `lead@${team.leadSid}` });
    }
    const reply = this.replyOf(row.id, fresh);
    const answered = snap?.supersededAt && reply?.at && snap.supersededAt > reply.at;
    if (reply?.text && !answered) {
      const { looksLikeAskingUser } = require('../auto-resume/decide');
      const ev = `reply@${reply.at || ''}#${fingerprint(reply.text)}`;
      if (looksLikeAskingUser(reply.text)) return skip('asking-user', '它最后一条回复在等你拍板，由你决定续不续', { canResume: true, evidence: ev });
      if (DELIVERED_RE.test(String(reply.text).slice(-600))) return skip('delivered', '它最后一条回复已交卷，等负责人或你安排', { canResume: true, evidence: ev });
    }
    const cardState = this.progressOf(row.id, meta, fresh).state;
    if (DONE_CARD_RE.test(cardState)) return skip('delivered', '进展卡写着已完成，确认没做完再续', { canResume: true, evidence: `card#${fingerprint(cardState)}` });
    const why = `Hub ${beijingTime(card.restartAt)} 重启时它正在干活，被打断`;
    return { action: 'interrupted', code: 'interrupted', canResume: true, reason: last?.message ? `${why}（上次没发出去：${last.message}）` : why };
  }

  // 每轮（Tab 刷新一次 / 一次续跑）先建好索引：最新回复按会话一次扫完账本，进展卡每个会话只读一次（审查性能项）。
  prepare() {
    this.loadTeams();
    this._progress = new Map();
    this._replies = new Map();
    try { for (const e of this.a.ledger?.entries?.() || []) { const old = this._replies.get(e.sessionId); if (!old || e.at > old.at) this._replies.set(e.sessionId, e); } }
    catch { this._replies = null; }
  }
  replyOf(id, fresh = false) {
    if (this._replies && !fresh) return this._replies.get(id) || null;
    try { return this.a.lastReplyOf?.(id) || null; } catch { return null; }
  }

  progressOf(id, meta, fresh = false) {
    if (!fresh && this._progress?.has(id)) return this._progress.get(id);
    let out = { state: '', line: '' };
    try {
      const p = require('./slim').readProgress({ ...meta, id }, { cardPathFor: this.a.deps.progressCardPath, lastReply: sid => this.replyOf(sid, fresh) });
      const forYou = p.ok ? String(p.forYou || '') : '', status = p.ok ? String(p.status || '') : '';
      const one = forYou.match(/一句话[:：]\s*(.+)/)?.[1] || (p.lastReply?.head || '').split('\n')[0] || '';
      out = { state: `${forYou}\n${status}`, line: one.replace(/^[📌\s*]+/u, '').replace(/\*\*/g, '').trim().slice(0, 140) };
    } catch {}
    if (!fresh) this._progress?.set(id, out);
    return out;
  }

  loadTeams() { try { this._teams = this.a.deps.getTeams?.() || []; } catch { this._teams = []; } }

  cards(days = LIST_DAYS, now = Date.now()) {
    const since = now - days * 86400_000;
    return foldCards(this.a.dialog.recent({ limit: 2000 })).filter(e => e.card === CARD && Array.isArray(e.sessions) && (e.restartAt || 0) >= since);
  }

  // Tab 用的卡片：{ id, card, trigger:'hub-restart-turn', startedAt, rows:[{ id, title, action, code, reason, canResume, progress, at }] }。
  list({ days = LIST_DAYS, now = Date.now() } = {}) {
    const cards = this.cards(days, now);
    let prepared = false;
    return cards.map(card => {
      const key = `${(card.results || []).length}|${this.inflight.size}`, hit = this.rowCache.get(card.id);
      if (hit && hit.key === key && now - hit.at < ROW_CACHE_MS) return hit.view;
      if (!prepared) { this.prepare(); prepared = true; }
      const rows = card.sessions.map(row => {
        const state = this.rowState(row, card), meta = this.a.sessionMetadata(row.id);
        const progress = meta && state.action !== 'resumed' ? this.progressOf(row.id, meta).line : '';
        return { id: row.id, title: meta?.title || row.title || '未命名会话', at: card.restartAt, trigger: 'hub-restart-turn', ...state, ...(progress ? { progress } : {}) };
      });
      const view = { id: card.id, card: CARD, trigger: 'hub-restart-turn', startedAt: card.restartAt, updatedAt: card.at, at: card.at, state: card.state, rows };
      this.rowCache.set(card.id, { key, at: now, view });
      return view;
    });
  }

  // Tab 上的「续跑」（单个）和「全部续跑」：卡片处理过也能点，只发给现在还该续的行（每行轮到名额时再判一次）。
  async resumeRows({ id, sessionId = null } = {}) {
    const key = `${id}|${sessionId || '*'}`;
    if (this.running.has(key)) return this.running.get(key);
    const card = this.cards(Infinity).find(c => c.id === id);
    if (!card) throw new Error('这张卡已经不在对话记录里');
    this.rowCache.delete(id); this.prepare();
    const mode = sessionId ? 'single' : 'batch';
    const picked = card.sessions.filter(row => !sessionId || row.id === sessionId).map(row => {
      // 单行：点击这一刻读最新证据，记下当时的未续原因作为这次点击的授权范围。
      const a = this.allowed(row, card, mode, { fresh: mode === 'single', authorize: true });
      return a.ok ? { ...row, override: a.st.action === 'skipped' ? overrideKey(a.st) : null } : null;
    }).filter(Boolean);
    if (sessionId && !picked.length) throw new Error('这一行现在不用续（已续上、已关或不该续），刷新看原因');
    const job = (async () => {
      const results = picked.length ? await this.runPool(picked, card, mode) : [];
      const saved = results.some(r => !r.busy) ? this.saveResults(id, results, { flip: false }) : card;
      return { ok: results.every(r => r.ok), sent: results.filter(r => r.ok).length, results, card: saved };
    })().finally(() => { this.running.delete(key); this.rowCache.delete(id); });
    this.running.set(key, job);
    return job;
  }
}

module.exports = { RestartResume, CARD, RESUME_TEXT, MAX_PARALLEL, beijingTime, cardText, isOrdinarySession, mergeCard, foldCards };
