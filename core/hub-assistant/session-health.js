'use strict';
// 会话健康：前台派出的每个会话走 4 道检查点，全部由 Hub 程序判断，不调用模型。
//
//   已建立  进程起来、CLI 就绪或原生记录已生成          默认 30 秒   不过：重建一次
//   已送达  原生记录里出现任务原文（首尾各取一段比对）  默认 1 分钟  不过：同一 operationKey 补发一次
//   已开工  出现第一条回复或工具调用                    默认 3 分钟  不过：关掉空会话、按挑号规则改派
//   有产出  新提交、新文件或进展卡更新（或本轮已答完）  默认 2 小时  不过：标「疑似卡住」，先读画面自查，再告警
//
// 原生记录只有 task_started + turn_aborted，没有用户消息。这种「开工前被中断」不等 1 分钟，立即补发。
//
// 所有处置动作都由调用方注入（deps），本模块只做判定和记账；每个动作最多执行一次，记录在 entry.actions。
//
// 次数预算（2026-11-15 Codex 复审 P1）：补发、重建/改派的次数按 operationKey 累计（换了新会话也不清零），
// 各自上限 1 次，超过只告警不再动作，避免「改派 → 新会话又没开工 → 再改派」无限循环。
// 补发只针对本次提交：中断事件必须发生在本次登记之后、且之后没有新回合开始；会话正有回合在跑时不补发。
const fs = require('node:fs');
const path = require('node:path');

const BUDGET = { resubmit: 1, rebuild: 1 };
const DEFAULTS = { establishMs: 30_000, deliverMs: 60_000, startMs: 180_000, produceMs: 2 * 3600_000, tickMs: 5_000, keepDoneMs: 24 * 3600_000 };
const CHECKPOINTS = ['established', 'delivered', 'started', 'producing'];
const LABEL = { established: '已建立', delivered: '已送达', started: '已开工', producing: '有产出' };
const TAIL_BYTES = 1024 * 1024;

const norm = text => String(text || '').replace(/\s+/g, '');
// 任务原文的首尾两段：Hub 会在原文前加规则块、CLI 会压掉空白，所以去空白后各取 48 字比对。
function fingerprint(text) {
  const t = norm(text);
  if (t.length <= 96) return { head: t, tail: '' };
  return { head: t.slice(0, 48), tail: t.slice(-48) };
}
function containsTask(haystack, fp) {
  const h = norm(haystack);
  return !!fp.head && h.includes(fp.head) && (!fp.tail || h.includes(fp.tail));
}

// ---- 原生记录读取（只读尾部，Claude 与 Codex 两种格式）----
function readTail(file, bytes = TAIL_BYTES) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, mtimeMs: stat.mtimeMs };
  } finally { fs.closeSync(fd); }
}
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(c => typeof c === 'string' ? c : (c?.text || c?.input_text || '')).join('') : '';

// 归一成 {kind:'user'|'reply'|'tool'|'abort'|'complete', text, at}
function parseNativeEvents(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const at = Date.parse(d.timestamp || '') || null;
    const p = d.payload;
    if (p && typeof p === 'object') { // Codex rollout
      if (d.type === 'response_item' && p.type === 'message' && p.role === 'user') out.push({ kind: 'user', text: textOf(p.content), at });
      else if (d.type === 'event_msg' && p.type === 'user_message') out.push({ kind: 'user', text: String(p.message || ''), at });
      else if (d.type === 'response_item' && p.type === 'message' && p.role === 'assistant') out.push({ kind: 'reply', text: textOf(p.content), at });
      else if (d.type === 'response_item' && /(^|_)call$/.test(String(p.type))) out.push({ kind: 'tool', at });
      else if (d.type === 'event_msg' && p.type === 'turn_aborted') out.push({ kind: 'abort', reason: p.reason || null, at });
      else if (d.type === 'event_msg' && p.type === 'task_complete') out.push({ kind: 'complete', at });
      else if (d.type === 'event_msg' && p.type === 'task_started') out.push({ kind: 'turn-start', at });
      continue;
    }
    const m = d.message; // Claude transcript
    if (d.type === 'user' && m) {
      const c = m.content;
      if (Array.isArray(c) && c.some(x => x?.type === 'tool_result')) continue;
      out.push({ kind: 'user', text: textOf(c), at });
    } else if (d.type === 'assistant' && m && Array.isArray(m.content)) {
      if (m.content.some(x => x?.type === 'tool_use')) out.push({ kind: 'tool', at });
      const t = m.content.filter(x => x?.type === 'text').map(x => x.text).join('');
      if (t.trim()) out.push({ kind: 'reply', text: t, at });
      if (m.stop_reason === 'end_turn') out.push({ kind: 'complete', at });
    } else if (d.type === 'system' && d.subtype === 'turn_duration') out.push({ kind: 'complete', at });
    else if (d.type === 'USER_INPUT' || d.source === 'USER_EXPLICIT') {
      const agyAt = Date.parse(d.created_at || '') || at;
      const rawContent = typeof d.content === 'string' ? d.content : '';
      const userText = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(rawContent)?.[1] ?? rawContent;
      out.push({ kind: 'user', text: userText, at: agyAt });
    } else if (d.type === 'PLANNER_RESPONSE' && d.source === 'MODEL') {
      const agyAt = Date.parse(d.created_at || '') || at;
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) out.push({ kind: 'tool', at: agyAt });
      const text = typeof d.content === 'string' ? d.content : '';
      if (text.trim()) out.push({ kind: 'reply', text, at: agyAt });
      // Do NOT emit 'complete' from step status === 'DONE': a step can finish before tool/turn completion
      // or an aborted turn can leave a DONE step behind; authoritative completion comes from Stop receipts.
    }
  }
  return out;
}

// 找原生记录：优先会话已登记的 transcriptPath；Codex 首轮前还没登记时，按会话自己的 sessions 目录找建会后最新的 rollout。
function locateTranscript(meta, sinceMs) {
  if (meta?.transcriptPath && fs.existsSync(meta.transcriptPath)) return meta.transcriptPath;
  const root = meta?.codexSessionsRoot;
  if (!root) return null;
  let best = null;
  const walk = (dir, depth) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) {
        try { const m = fs.statSync(p).mtimeMs; if (m >= (sinceMs || 0) - 5000 && (!best || m > best.m)) best = { p, m }; } catch {}
      }
    }
  };
  walk(root, 0);
  return best?.p || null;
}

function readNative(meta, sinceMs) {
  const file = locateTranscript(meta, sinceMs);
  if (!file) return { exists: false, events: [] };
  try {
    const { text, mtimeMs } = readTail(file);
    const events = parseNativeEvents(text);
    // Antigravity authoritative turn outcome comes from verified Stop receipts, not step status.
    const agyId = meta?.geminiChatId || /[\\/]antigravity-cli[\\/]brain[\\/]([0-9a-f-]{36})[\\/]/i.exec(file)?.[1] || '';
    if (agyId && /^gemini(?:-resume)?$/i.test(String(meta?.kind || ''))) {
      try {
        const receiptFile = require('../antigravity-config').receiptsFile(agyId);
        if (fs.existsSync(receiptFile)) {
          const receipts = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
          for (const r of Object.values(receipts || {})) {
            const at = Number(r?.completedAt || r?.ts || r?.observedAt || 0);
            if (!at) continue;
            if (r?.outcome === 'completed') events.push({ kind: 'complete', at });
            else if (r?.outcome === 'aborted' || r?.outcome === 'error') events.push({ kind: 'abort', reason: r.error || r.outcome, at });
          }
        }
      } catch {}
    }
    return { exists: true, file, mtimeMs, events };
  } catch { return { exists: false, events: [] }; }
}

// ---- 状态机 ----
class SessionHealth {
  constructor(deps = {}, options = {}) {
    this.deps = deps;
    this.opts = { ...DEFAULTS, ...options };
    this.entries = new Map();
    this.budgets = new Map(); // chainKey -> { resubmit, rebuild }
    this.file = deps.stateFile || null;
    this.timer = null;
    this.busy = false;
    this.load();
  }
  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const legacy = Array.isArray(data);
      const rows = legacy ? data : (Array.isArray(data?.entries) ? data.entries : []);
      for (const row of rows) if (row?.sessionId) this.entries.set(row.sessionId, row);
      if (!legacy) for (const [k, v] of Object.entries(data?.budgets || {})) this.budgets.set(k, { resubmit: Number(v?.resubmit) || 0, rebuild: Number(v?.rebuild) || 0 });
      else for (const row of rows) { // 旧格式（只有数组）没有预算表：按同链条已有记录补算。
        if (!row?.sessionId) continue;
        const b = this.budget(row);
        b.resubmit += Number(row.resubmits) || 0;
        b.rebuild += (row.actions || []).filter(x => x.type === 'recreate' || x.type === 'redispatch').length;
      }
    } catch {}
  }
  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const live = new Set([...this.entries.values()].map(chainOf));
      const budgets = Object.fromEntries([...this.budgets].filter(([k]) => live.has(k)));
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ entries: [...this.entries.values()], budgets }));
      require('./atomic-rename').renameRetry(this.file + '.tmp', this.file);
    } catch (error) { console.warn('[session-health] save failed:', error.message); }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(error => console.warn('[session-health] tick', error.message)); }, this.opts.tickMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  // 同一 operationKey 的整条链（原会话、重建、改派出来的新会话）共用一份次数预算。
  budget(e) {
    const k = chainOf(e);
    if (!this.budgets.has(k)) this.budgets.set(k, { resubmit: 0, rebuild: 0 });
    return this.budgets.get(k);
  }
  canSpend(e, kind) { return (this.budget(e)[kind] || 0) < BUDGET[kind]; }
  spend(e, kind) { const b = this.budget(e); b[kind] = (b[kind] || 0) + 1; }

  // 前台派出后登记。text 是任务原文（未加 Hub 规则块）；operationKey 是这次派工的幂等键。
  track({ sessionId, kind, title, text, operationKey, cwd, progressCard, produceMs, dispatch, startedAt, chainKey } = {}) {
    if (!sessionId || typeof text !== 'string') throw new Error('会话健康登记缺少会话编号或任务原文');
    const at = startedAt || this.now();
    const prev = this.entries.get(sessionId);
    const entry = {
      sessionId, kind: kind || prev?.kind || null, title: title || prev?.title || '', operationKey: operationKey || null,
      chainKey: chainKey || (operationKey ? `op:${operationKey}` : `session:${sessionId}`),
      cwd: cwd || prev?.cwd || null, progressCard: progressCard || null,
      produceMs: Number(produceMs) > 0 ? Number(produceMs) : this.opts.produceMs,
      fp: fingerprint(text), textChars: text.length, text: text.length <= 50000 ? text : text.slice(0, 50000),
      trackedAt: at, phaseAt: at, dispatch: dispatch || null,
      checkpoints: Object.fromEntries(CHECKPOINTS.map(k => [k, { state: 'pending', at: null }])),
      state: 'establishing', actions: [], resubmits: 0, lastProgressAt: at, baseline: null, notes: [],
    };
    this.entries.set(sessionId, entry);
    this.save();
    this.deps.onChange?.(this.snapshot(entry));
    return this.snapshot(entry);
  }

  // prompt-submit 报 stuck 时提前检查送达，不必等满 1 分钟。
  onStuck(sessionId) {
    const e = this.entries.get(sessionId);
    if (!e || e.checkpoints.delivered.state === 'pass') return false;
    e.stuckReportedAt = this.now();
    return true;
  }

  snapshot(e) {
    if (!e) return null;
    return {
      sessionId: e.sessionId, title: e.title, state: e.state, operationKey: e.operationKey,
      checkpoints: Object.fromEntries(CHECKPOINTS.map(k => [k, { ...e.checkpoints[k], label: LABEL[k] }])),
      summary: this.describe(e), actions: e.actions.slice(-6), resubmits: e.resubmits, budget: { ...this.budget(e), limit: { ...BUDGET } },
      replacedBy: e.replacedBy || null, lastProgressAt: e.lastProgressAt,
      // 前台重派时要用到原任务（E2E 里前台说过「我手上没有原任务文本」）：给开头 300 字和总长度。
      taskPreview: String(e.text || '').slice(0, 300), taskChars: e.textChars,
    };
  }
  describe(e) {
    const done = CHECKPOINTS.filter(k => e.checkpoints[k].state === 'pass').map(k => LABEL[k]);
    const failing = CHECKPOINTS.find(k => ['fail', 'recovering'].includes(e.checkpoints[k].state));
    const head = { establishing: '建立中', delivering: '等送达', starting: '等开工', working: '在干活', 'suspect-stuck': '疑似卡住',
      done: '本轮已完成', redispatched: '已改派', failed: '处置失败' }[e.state] || e.state;
    return head + (done.length ? `（已过：${done.join('、')}）` : '') + (failing ? `；${LABEL[failing]}未过` : '');
  }
  status(sessionId) { return this.snapshot(this.entries.get(sessionId)); }
  // 给 list_sessions（m1 改成一行一个会话）用的短状态词；不在跟踪里返回 null。
  word(sessionId) {
    const e = this.entries.get(sessionId);
    return e ? ({ establishing: '建立中', delivering: '等送达', starting: '等开工', working: '在干活', 'suspect-stuck': '疑似卡住',
      done: '已完成', redispatched: '已改派', failed: '处置失败' }[e.state] || e.state) : null;
  }
  list() { return [...this.entries.values()].map(e => this.snapshot(e)); }

  pass(e, key, note) {
    const c = e.checkpoints[key];
    if (c.state === 'pass') return;
    c.state = 'pass'; c.at = this.now(); if (note) c.note = note;
    e.phaseAt = this.now();
  }
  fail(e, key, note) { const c = e.checkpoints[key]; c.state = 'fail'; c.at = this.now(); c.note = note; }
  act(e, type, detail) { e.actions.push({ type, at: this.now(), ...detail }); }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const e of [...this.entries.values()]) {
        try { await this.check(e); }
        catch (error) { e.notes.push(String(error.message).slice(0, 200)); }
      }
      // 完成或改派超过 24 小时的记录清掉，文件不无限增长。
      for (const [id, e] of this.entries) if (['done', 'redispatched', 'failed'].includes(e.state) && this.now() - e.phaseAt > this.opts.keepDoneMs) this.entries.delete(id);
      this.save();
    } finally { this.busy = false; }
  }

  async check(e) {
    if (['done', 'redispatched', 'failed'].includes(e.state)) return;
    const now = this.now();
    const meta = this.deps.getSession?.(e.sessionId) || null;
    const before = e.state;
    if (!meta) {
      e.state = 'failed'; e.phaseAt = now; this.act(e, 'gone', { note: '会话已不在打开列表，停止跟踪' });
      return this.changed(e, before);
    }
    const native = this.deps.readNative ? this.deps.readNative(meta, e.trackedAt) : readNative(meta, e.trackedAt);
    const events = (native.events || []).filter(ev => !ev.at || ev.at >= e.trackedAt - 5000);

    // 1 已建立
    if (e.checkpoints.established.state !== 'pass') {
      const ready = native.exists || this.deps.isReady?.(e.sessionId, meta) === true;
      if (ready) this.pass(e, 'established');
      else if (now - e.trackedAt >= this.opts.establishMs) {
        const rebuiltHere = e.actions.some(a => a.type === 'recreate');
        if (!rebuiltHere && this.canSpend(e, 'rebuild')) {
          this.fail(e, 'established', `${Math.round(this.opts.establishMs / 1000)} 秒内进程没就绪`);
          e.checkpoints.established.state = 'recovering';
          this.spend(e, 'rebuild');
          this.act(e, 'recreate', {});
          this.save(); // 先落盘次数和动作再执行：动作执行中崩溃，重启后按已用次数不再重复重建（2026-11-15 Codex 复审 P1）
          const r = await this.deps.recreate?.(this.publicEntry(e)).catch(error => ({ ok: false, error: error.message }));
          if (r && r.ok === false) {
            await this.alert(e, 'establish-failed', `「${e.title}」${Math.round(this.opts.establishMs / 1000)} 秒没建起来，${r.blocked ? '没有自动重建' : '重建失败'}：${r.error || '原因不明'}`,
              r.blocked ? '会话保留未关' : '尝试重建 1 次', '看一眼这个会话，决定是否手动重派');
          }
          return this.replaced(e, r, 'recreate', before);
        }
        this.fail(e, 'established', rebuiltHere ? '重建后仍没就绪' : '这项任务已重建或改派过 1 次，不再重建');
        e.state = 'failed';
        await this.alert(e, 'establish-failed', `「${e.title}」建不起来，这项任务已重建或改派过 1 次，不再自动重建`, '已重建或改派 1 次', '看一眼这个会话，决定是否手动重派');
        return this.changed(e, before);
      } else { e.state = 'establishing'; return this.changed(e, before); }
    }

    // 2 已送达
    const delivered = events.some(ev => ev.kind === 'user' && containsTask(ev.text, e.fp));
    if (e.checkpoints.delivered.state !== 'pass') {
      e.state = 'delivering';
      if (delivered) this.pass(e, 'delivered');
      else {
        // 只认本次提交（补发后则是补发）之后的中断，且中断之后没有新回合开始——新回合已在跑就不是「开工前被中断」。
        const abortedBeforeDelivery = lastTurnEvent(events, e.resubmittedAt || e.trackedAt)?.kind === 'abort';
        const overdue = now - e.trackedAt >= this.opts.deliverMs;
        if ((abortedBeforeDelivery || overdue) && this.deps.isTurnActive?.(e.sessionId) === true) {
          // 会话正有回合在跑（可能就是这次任务、原生记录还没落盘）：补发会排队重复，等这一轮结束再判。
          if (!e.actions.some(a => a.type === 'resubmit-deferred')) this.act(e, 'resubmit-deferred', { reason: '会话正有回合在跑，暂不补发' });
          return this.changed(e, before);
        }
        if (abortedBeforeDelivery || overdue) {
          if (e.resubmits < 1 && this.canSpend(e, 'resubmit')) {
            e.resubmits += 1;
            this.spend(e, 'resubmit');
            e.checkpoints.delivered.state = 'recovering';
            e.checkpoints.delivered.note = abortedBeforeDelivery ? '原文进入原生记录前被中断' : `${Math.round(this.opts.deliverMs / 1000)} 秒内原生记录里没有任务原文`;
            this.act(e, 'resubmit', { reason: e.checkpoints.delivered.note });
            e.resubmittedAt = now;
            this.save(); // 先落盘再补发：补发后崩溃，重启时已记 1 次，不会再补发第 2 次
            // 补发前先看一眼：会话若正停在开工前被中断的状态，补发即可；补发结果记进动作。
            const r = await this.deps.resubmit?.(this.publicEntry(e)).catch(error => ({ ok: false, error: error.message }));
            e.actions[e.actions.length - 1].result = r ? { ok: r.ok !== false, state: r.state || r.sendStatus || null, error: r.error || null, message: r.message ? String(r.message).slice(0, 200) : null } : null;
            return this.changed(e, before);
          }
          // 补发过一次仍未送达：补发后再给 1 分钟。同一 operationKey 在之前的会话里已补发过的，到点直接判失败。
          if (now - (e.resubmittedAt || e.trackedAt) >= this.opts.deliverMs) {
            this.fail(e, 'delivered', e.resubmits ? '补发 1 次后仍没送达' : '这项任务已补发过 1 次（在之前的会话里），不再补发');
            e.state = 'failed';
            const hint = screenHint(await Promise.resolve(this.deps.readScreen?.(e.sessionId)).catch(() => null));
            await this.alert(e, 'deliver-failed', `「${e.title}」任务没送进会话${hint ? '：' + hint : ''}`, '已自动补发 1 次' + (hint ? '，已读画面' : ''),
              hint ? '画面停在等选择，请你点开会话选一下' : '请你点开会话看一眼输入框，必要时让前台重派');
          }
        }
        return this.changed(e, before);
      }
    }

    // 3 已开工
    const startedEv = events.find(ev => ev.kind === 'reply' || ev.kind === 'tool');
    if (e.checkpoints.started.state !== 'pass') {
      e.state = 'starting';
      if (startedEv) this.pass(e, 'started');
      else if (e.redispatchBlocked) return this.changed(e, before);
      else if (now - (e.checkpoints.delivered.at || e.trackedAt) >= this.opts.startMs) {
        this.fail(e, 'started', `送达后 ${Math.round(this.opts.startMs / 60000)} 分钟没有任何回复或工具调用`);
        if (!this.canSpend(e, 'rebuild')) {
          e.state = 'failed'; e.phaseAt = now;
          await this.alert(e, 'start-timeout', `「${e.title}」送达 ${Math.round(this.opts.startMs / 60000)} 分钟没开工；这项任务已重建或改派过 1 次，不再自动改派`,
            '已重建或改派 1 次', '看一眼这个会话，决定是否手动重派');
          return this.changed(e, before);
        }
        this.spend(e, 'rebuild');
        this.act(e, 'redispatch', {});
        this.save(); // 先落盘再改派：改派后崩溃，重启时预算已用完，不会再改派第 2 次
        const r = await this.deps.redispatch?.(this.publicEntry(e)).catch(error => ({ ok: false, error: error.message }));
        await this.alert(e, 'start-timeout', `「${e.title}」送达 ${Math.round(this.opts.startMs / 60000)} 分钟没开工${r?.ok ? '，已关掉空会话并改派' : r?.blocked ? '，没有自动改派（会话保留未关）' : '，改派失败'}`,
          r?.ok ? `已改派到 ${String(r.sessionId || '').slice(0, 8)}${r.account ? `（${r.account}）` : ''}` : `${r?.blocked ? '未改派' : '改派失败'}：${r?.error || '原因不明'}`,
          r?.ok ? '' : '看一眼这个会话，决定是否手动重派');
        return this.replaced(e, r, 'redispatch', before);
      } else return this.changed(e, before);
    }

    // 4 有产出
    const lastNative = events.reduce((m, ev) => Math.max(m, ev.at || 0), 0);
    const turnComplete = events.some(ev => ev.kind === 'complete' && (ev.at || 0) >= (e.checkpoints.started.at ? e.checkpoints.started.at - 600_000 : 0));
    const progress = await Promise.resolve(this.deps.probeProgress?.(this.publicEntry(e), meta)).catch(() => null);
    if (progress && progress > e.lastProgressAt) e.lastProgressAt = progress;
    if (progress && progress > e.trackedAt) this.pass(e, 'producing', '有新提交、新文件或进展卡更新');
    if (turnComplete && !this.deps.isTurnActive?.(e.sessionId)) {
      this.pass(e, 'producing', e.checkpoints.producing.note || '本轮已答完');
      e.state = 'done'; e.phaseAt = now;
      return this.changed(e, before);
    }
    const idleFor = now - Math.max(e.lastProgressAt, e.checkpoints.started.at || 0);
    if (idleFor >= e.produceMs) {
      if (e.state !== 'suspect-stuck') {
        e.state = 'suspect-stuck';
        e.checkpoints.producing.state = 'fail'; e.checkpoints.producing.at = now;
        e.checkpoints.producing.note = `${Math.round(idleFor / 60000)} 分钟没有新提交、新文件或进展卡更新（原生记录最后活动 ${lastNative ? new Date(lastNative).toISOString() : '无'}）`;
        const screen = await Promise.resolve(this.deps.readScreen?.(e.sessionId)).catch(() => null);
        const hint = screenHint(screen);
        this.act(e, 'self-check', { hint });
        await this.alert(e, 'suspect-stuck', `「${e.title}」疑似卡住：${Math.round(idleFor / 60000)} 分钟没有产出`,
          hint ? `已读画面：${hint}` : '已读画面，没看出在等选择', hint ? '画面停在等选择，请你点开会话选一下' : '你点开看一眼是否还在推进');
      }
      return this.changed(e, before);
    }
    e.state = 'working';
    return this.changed(e, before);
  }

  replaced(e, r, how, before) {
    if (r?.ok && r.sessionId && r.sessionId !== e.sessionId) {
      e.state = 'redispatched'; e.replacedBy = r.sessionId; e.phaseAt = this.now();
      // 新会话接着走完整的 4 道检查点。
      const next = this.track({ sessionId: r.sessionId, kind: r.kind || e.kind, title: e.title, text: e.text, operationKey: e.operationKey, chainKey: chainOf(e),
        cwd: e.cwd, progressCard: e.progressCard, produceMs: e.produceMs, dispatch: { ...(e.dispatch || {}), [how + 'From']: e.sessionId } });
      const n = this.entries.get(next.sessionId);
      // 新会话与原会话共用同一 operationKey 的次数预算，补发、重建/改派都不会超过上限。
      n.actions.push({ type: how + '-from', at: this.now(), from: e.sessionId });
    } else if (r && r.ok === false && r.blocked) {
      if (how === 'redispatch') e.redispatchBlocked = true;
      else { e.state = 'failed'; e.phaseAt = this.now(); }
      e.notes.push(`${how} 未执行：${r.error || '保护条件不满足'}`);
    } else if (r && r.ok === false) {
      e.state = 'failed'; e.phaseAt = this.now();
      e.notes.push(`${how} 失败：${r.error || '原因不明'}`);
    }
    return this.changed(e, before);
  }

  publicEntry(e) {
    return { sessionId: e.sessionId, kind: e.kind, title: e.title, text: e.text, operationKey: e.operationKey, cwd: e.cwd,
      progressCard: e.progressCard, dispatch: e.dispatch, resubmits: e.resubmits };
  }

  async alert(e, type, conclusion, tried, ask = '') {
    this.act(e, 'alert', { alertType: type });
    try { await this.deps.alert?.({ key: `health:${type}:${e.sessionId}`, category: 'session-health', type, sessionId: e.sessionId, title: e.title, conclusion, tried, ask }); }
    catch (error) { e.notes.push('告警发送失败：' + error.message); }
  }

  changed(e, before) {
    if (e.state !== before) this.deps.onChange?.(this.snapshot(e));
    return this.snapshot(e);
  }
}

function chainOf(e) { return e.chainKey || (e.operationKey ? `op:${e.operationKey}` : `session:${e.sessionId}`); }
// 本次提交之后最后一个回合事件（开始 / 中断 / 完成）。
function lastTurnEvent(events, sinceMs) {
  let last = null;
  for (const ev of events) if (['turn-start', 'abort', 'complete'].includes(ev.kind) && ev.at && ev.at >= sinceMs) last = ev;
  return last;
}

function screenHint(screen) {
  const text = String(screen?.text || screen || '');
  if (!text) return '';
  const tail = text.slice(-3000);
  if (/\b(1\.|❯\s*1)\s.*\n.*\b2\./s.test(tail) && /\?|？|Do you want|是否|Allow|允许|approve/i.test(tail)) return '画面停在一个选择题上';
  if (/Press enter to continue|按回车继续|\(y\/n\)|\[Y\/n\]/i.test(tail)) return '画面在等确认（回车或 y/n）';
  if (/rate limit|usage limit|额度|quota/i.test(tail)) return '画面提示额度或限流';
  return '';
}

module.exports = { SessionHealth, BUDGET, lastTurnEvent, fingerprint, containsTask, parseNativeEvents, readNative, locateTranscript, screenHint, DEFAULTS, CHECKPOINTS, LABEL };
