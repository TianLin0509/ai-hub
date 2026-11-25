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
const RESUME_TEXT = '继续。Hub 刚才重启，打断了你正在做的事：先确认做到了哪一步，再接着做；被重启杀掉的后台等待和定时任务需要重新起。';
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
    this.running = new Map(); this.progress = new Map();
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

  // 一个一个来：同时冷启动一批 CLI 会抢 CPU。进度只推给界面，全部发完才落盘。
  async resumeAll(card) {
    const results = [];
    for (const row of card.sessions) {
      const live = { ...card, state: 'resuming', results: [...results] };
      live.text = cardText(live); this.progress.set(card.id, live);
      try { this.a.deps.onDialogEntry?.(live); } catch {}
      results.push({ ...row, ...await this.resumeOne(row, card) });
    }
    this.progress.delete(card.id);
    return { ok: true, card: this.settle(card, { state: 'resumed', results }) };
  }

  async resumeOne(row, card) {
    const { deps } = this.a, fail = message => ({ ok: false, message });
    try {
      const meta = this.a.sessionMetadata(row.id);
      if (!meta) return fail('会话已被删除');
      if (deps.isAgentTurnActive?.(row.id)) return fail('它已经在干活了，没有重复发');
      // 出卡之后、点按钮之前，用户已经自己到会话里续上并答完了一轮。
      if (meta.lastCompletedAt > card.restartAt) return fail('重启后它已经接着干完一轮，没有重复发');
      const oldPid = Number(String(card.id).split(':')[1]) || card.restartAt;
      const claim = require('../auto-resume/claims').claimResume(deps.dataDir, row.id, `hub-${oldPid}`, 'restart-card');
      if (!claim.ok) return fail(claim.by === 'auto-resume' ? '自动续跑已经给它发过续跑语，没有重复发' : '另一条续跑通道已经接手，没有重复发');
      if (!deps.getSession(row.id)) {
        // 只恢复能接回原对话的会话，不新建替代会话。在后台恢复：界面留在助理页，不跳到被唤醒的会话。
        if (!require('./live-history').nativeId(meta)) return fail('找不到它的原生会话记录，没法恢复');
        await deps.resumeSession(row.id, null, { openInBackground: true });
        if (!deps.getSession(row.id)) return fail('会话没能恢复');
      }
      const receipt = await deps.sendPrompt(row.id, RESUME_TEXT, `${card.id}:${row.id}`.slice(0, 160));
      if (receipt?.ok !== true || receipt.notSent) return fail(receipt?.message || receipt?.error || '没有拿到提交确认');
      if (receipt.sendStatus === 'stuck') return fail('已经写进输入框，但没收到开工确认，请到会话里看一眼');
      return { ok: true };
    } catch (error) { return fail(error.message); }
  }
}

module.exports = { RestartResume, CARD, RESUME_TEXT, beijingTime, cardText, isOrdinarySession, mergeCard, foldCards };
