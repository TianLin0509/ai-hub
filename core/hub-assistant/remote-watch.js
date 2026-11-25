'use strict';
//
// 顺序（总纲第 9 条）：
//   2. 只有作业账里有「还可能在跑」的远端作业时，才查远端，每个后端每 30 分钟最多 1 次；
//      单条超过 50 KB 直接截断不再细看（只取文本摘要）。
// 报三种情况：资源空着（有排队却没用上卡 / 本机在跑重任务而远端空闲）、作业卡住、作业失败。同一作业同一种情况由 alerts.js 限频。
// 订阅直通（2026-11-18）：作业账 submit 行带 hub_session（提交它的 Hub 会话，fastlane.journal 取 CLAUDE_HUB_SESSION_ID）时，
// 旧记录没有 hub_session 的照旧走前台。
const fs = require('node:fs');

const DEFAULTS = {
  intervalMs: 30 * 60_000,      // 远端查询间隔
  activeWindowMs: 48 * 3600_000,
  pendingStuckMs: 60 * 60_000,  // 排队超过 1 小时算卡住
  runningStuckMs: 3 * 3600_000, // 运行中但进度行 3 小时没变算卡住
  localHeavyMs: 10 * 60_000,    // 本机重任务跑超过 10 分钟才提示可迁远端
  maxReplyBytes: 50 * 1024,
  openGraceMs: 6 * 3600_000,    // 交卷判断：提交后多久没有任何状态更新就不再算「还在跑」
};
const FAILED = /^(failed|error|killed|cancelled_by_system|timeout|notfound|rejected)$/i;
const DONE = /^(succeeded|success|finished|completed|done|cancelled|canceled)$/i;
const RUNNING = /^(running|executing)$/i;
const PENDING = /^(pending|queued|queuing|waiting|submitted|submitunknown)$/i;

function readLedger(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// 作业账 → 每个后端「可能还在跑」的票号。
function activeFromLedger(rows, now, windowMs) {
  const byBackend = new Map();
  const cancelled = new Set(rows.filter(r => r.action === 'cancel' && r.ok !== false).map(r => r.ticket).filter(Boolean));
  for (const r of rows) {
    if (r.action !== 'submit' || r.ok === false || !r.ticket || cancelled.has(r.ticket)) continue;
    const at = Date.parse(r.at || '');
    if (!Number.isFinite(at) || now - at > windowMs || at - now > 3600_000) continue;
    const backend = r.backend || 'unknown';
    if (!byBackend.has(backend)) byBackend.set(backend, []);
    byBackend.get(backend).push({ ticket: r.ticket, name: r.name || '', submittedAt: at, hubSession: r.hub_session || null });
  }
  return byBackend;
}

// 远端回执归一：接受 {jobs:[{ticket,status|last_status,name,progress,result_exit}], quota_remain, cards_in_use} 等写法
function normalizeReply(reply) {
  const obj = typeof reply === 'string' ? (() => { try { return JSON.parse(reply); } catch { return {}; } })() : (reply || {});
  const list = obj.jobs || obj.items || obj.tasks || obj.result?.jobs || [];
  const jobs = (Array.isArray(list) ? list : []).map(j => ({
    ticket: j.ticket || j.id || j.task_id || null, name: j.name || '', status: String(j.status || j.last_status || j.state || ''),
    progress: j.progress || j.last_line || j.progress_line || null,
    exit: j.result_exit ?? j.exit_code ?? null, startedAt: Date.parse(j.started_at || j.start_time || '') || null,
  }));
  const quota = Number(obj.quota_remain ?? obj.status?.quota_remain ?? obj.quotaRemain);
  const inUse = Number(obj.cards_in_use ?? obj.in_use ?? obj.status?.cards_in_use ?? obj.cardsInUse);
  return { jobs, quotaRemain: Number.isFinite(quota) ? quota : null, cardsInUse: Number.isFinite(inUse) ? inUse : null };
}

class RemoteWatch {
  constructor(deps = {}, options = {}) {
    this.deps = deps;
    this.opts = { ...DEFAULTS, ...options };
    this.lastQueryAt = new Map();
    this.progress = new Map(); // ticket -> {progress, since}
    this.failed = new Set(); // 查到已失败或已取消的 backend:ticket（交卷判断「还在跑」时排除；deps.closedSeen 落盘，重启后仍记得）
    this.openConfirmed = new Map(); // backend -> 最近一次成功查询里仍在排队/运行的票号
    this.lastResultAt = new Map(); // backend -> 最近一次成功查询的时间
    this.idleSince = new Map(); // backend -> 上次查到第 1 页没有在跑/排队作业的时间；之后没有新提交就不再查远端
    this.timer = null;
    this.history = [];
  }
  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  start(periodMs = 5 * 60_000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(error => console.warn('[remote-watch]', error.message)), periodMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  markClosed(key) { this.failed.add(key); try { this.deps.closedSeen?.add(key); } catch (error) { console.warn('[remote-watch] closed', error.message); } }
  isClosed(key) { return this.failed.has(key) || !!this.deps.closedSeen?.has(key); }
  // 交卷判断用：这张票还算不算「可能在跑」（2026-11-18 复审）。
  //   完成 / 失败 / 取消过的不算；最近一次成功查询确认仍在排队或运行的算；
  //   提交后还没有成功查询过、且提交不到 openGraceMs（6 小时）的算；其余（查询结果里没它、比如被挤出第一页，或 6 小时没任何状态）不算。
  ticketOpen(backend, t, isDone = () => false) {
    const key = `${backend}:${t.ticket}`;
    if (isDone(key) || this.isClosed(key)) return false;
    if (this.openConfirmed.get(backend)?.has(String(t.ticket))) return true;
    return !((this.lastResultAt.get(backend) || 0) > t.submittedAt) && this.now() - t.submittedAt < this.opts.openGraceMs;
  }

  async tick() {
    const now = this.now();
        const rows = await Promise.resolve(this.deps.readLedger ? this.deps.readLedger() : readLedger(this.opts.ledgerFile || require('path').join(require('os').homedir(), '.ai-hub-remote-jobs.jsonl')));
    const active = activeFromLedger(rows, now, this.opts.activeWindowMs);
    const slots = await Promise.resolve(this.deps.machineSlots?.()).catch(() => null);
    const report = { at: now, active: Object.fromEntries([...active].map(([k, v]) => [k, v.length])), queried: [], alerts: [] };

    // 本机在跑重任务、而远端一个作业都没有：提示可以迁到远端（合入闸门本来就只能在本机跑，不算）。
    const heavy = (slots?.entries || []).filter(e => e.state === 'running' && !e.gate && Number(e.cores) >= 2
      && now - Number(e.started || 0) * 1000 >= this.opts.localHeavyMs);
    if (heavy.length && !active.size) {
      report.alerts.push(this.raise({ key: 'remote:idle:local-heavy', type: 'resource-idle',
                conclusion: `本机在跑 ${heavy.length} 个重任务（${heavy.map(e => e.label).slice(0, 3).join('、')}），远端都空着`,
                tried: '只读了本机算力账本和远端作业账，没查远端', ask: '能离开本机的重任务下次派到远端' }));
    }

    for (const [backend, tickets] of active) {
      const query = this.deps.query?.[backend];
      if (!query) continue;
      if (now - (this.lastQueryAt.get(backend) || 0) < this.opts.intervalMs) continue;
      const idle = this.idleSince.get(backend);
      if (idle && tickets.every(t => t.submittedAt <= idle)) continue;
      this.lastQueryAt.set(backend, now);
      let raw;
      try { raw = await query({ tickets }); }
      catch (error) { report.queried.push({ backend, ok: false, error: error.message }); continue; }
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
      if (Buffer.byteLength(text, 'utf8') > this.opts.maxReplyBytes) { report.queried.push({ backend, ok: false, error: '远端回执超过 50 KB，不细看' }); continue; }
      const snap = normalizeReply(raw);
      report.queried.push({ backend, ok: true, jobs: snap.jobs.length });
      const mine = new Set(tickets.map(t => String(t.ticket)));
      const jobs = snap.jobs.filter(j => !mine.size || mine.has(String(j.ticket)) || tickets.some(t => t.name && t.name === j.name));
      const pending = jobs.filter(j => PENDING.test(j.status));
      const running = jobs.filter(j => RUNNING.test(j.status));
      this.openConfirmed.set(backend, new Set(pending.concat(running).map(j => String(j.ticket))));
      this.lastResultAt.set(backend, now);
      if (!pending.length && !running.length) this.idleSince.set(backend, now); else this.idleSince.delete(backend);
      const ownerOf = j => tickets.find(t => String(t.ticket) === String(j.ticket)) || tickets.find(t => t.name && t.name === j.name) || null;
      const to = j => { const sid = ownerOf(j)?.hubSession; return sid ? { deliverTo: sid } : {}; };
      for (const j of jobs) {
        if (FAILED.test(j.status) || (j.exit != null && Number(j.exit) !== 0 && !RUNNING.test(j.status))) {
          this.markClosed(`${backend}:${j.ticket}`);
          report.alerts.push(this.raise({ key: `remote:failed:${backend}:${j.ticket}`, type: 'job-failed', ticket: j.ticket, ...to(j),
            conclusion: `${label(backend)}作业 ${j.name || j.ticket} 失败（${j.status || 'exit ' + j.exit}）`,
            tried: '已从远端取回状态', ask: to(j).deliverTo ? '请你取日志看原因，决定是否重提' : '让负责这批作业的会话取日志看原因' }));
        } else if (/^cancel/i.test(j.status)) {
          this.markClosed(`${backend}:${j.ticket}`);
        } else if (DONE.test(j.status)) {
          const sid = ownerOf(j)?.hubSession, seenKey = `${backend}:${j.ticket}`;
          if (sid && this.deps.onJobDone && !this.deps.doneSeen?.has(seenKey)) {
            // 投递成功（含已排队，排队后会话被关由投递口兜底）才记「已报过」；送不出去下一轮再报（2026-11-18 独立审查：先记后投会永久丢）。
            let r = null;
            try { r = await this.deps.onJobDone({ backend, ticket: j.ticket, name: j.name, status: j.status, sessionId: sid, text: `${label(backend)}作业 ${j.name || j.ticket}（票号 ${j.ticket}）已成功完成（${j.status}${j.exit != null ? '，exit ' + j.exit : ''}），可以取结果接着干。` }); }
            catch (error) { r = { ok: false, error: error.message }; }
            if (r?.ok) { this.deps.doneSeen?.add(seenKey); report.done = (report.done || []).concat({ backend, ticket: j.ticket, sessionId: sid, via: r.via || null }); }
            else { console.warn('[remote-watch] done 没送出去，下一轮再报', seenKey, r?.error || ''); report.doneFailed = (report.doneFailed || []).concat({ backend, ticket: j.ticket, sessionId: sid, error: r?.error || null }); }
          }
        }
      }
      // 有完成没送出去的：不进「空闲不再查」状态，下一轮（intervalMs 后）照常再查再报。
      if ((report.doneFailed || []).some(d => d.backend === backend)) this.idleSince.delete(backend);
      // 卡住：排队太久，或运行中进度行长时间不变。
      for (const j of pending) {
        const sub = tickets.find(t => String(t.ticket) === String(j.ticket))?.submittedAt;
        if (sub && now - sub >= this.opts.pendingStuckMs) {
          report.alerts.push(this.raise({ key: `remote:stuck:${backend}:${j.ticket}`, type: 'job-stuck', ticket: j.ticket, ...to(j),
            conclusion: `${label(backend)}作业 ${j.name || j.ticket} 排队 ${Math.round((now - sub) / 60000)} 分钟还没开跑`,
            tried: '已查远端状态', ask: '' }));
        }
      }
      for (const j of running) {
        const key = `${backend}:${j.ticket}`;
        const prev = this.progress.get(key);
        if (!prev || prev.progress !== j.progress) this.progress.set(key, { progress: j.progress, since: now });
        else if (j.progress != null && now - prev.since >= this.opts.runningStuckMs) {
          report.alerts.push(this.raise({ key: `remote:stuck:${backend}:${j.ticket}`, type: 'job-stuck', ticket: j.ticket, ...to(j),
            conclusion: `${label(backend)}作业 ${j.name || j.ticket} 进度 ${Math.round((now - prev.since) / 60000)} 分钟没变`,
            tried: '连续两次查远端，进度行相同', ask: '让负责的会话看一下日志，必要时取消重提' }));
        }
      }
      // 资源空着：有排队、卡却没用上（团队还有配额）。
      if (pending.length && !running.length && (snap.cardsInUse === 0 || (snap.quotaRemain != null && snap.quotaRemain > 0))) {
        report.alerts.push(this.raise({ key: `remote:idle:${backend}`, type: 'resource-idle',
          conclusion: `${label(backend)}有 ${pending.length} 个作业在排队，但卡没用上${snap.quotaRemain != null ? `（团队剩余配额 ${snap.quotaRemain}）` : ''}`,
          tried: '已查远端状态', ask: '' }));
      }
    }
    this.history.push(report); if (this.history.length > 50) this.history.shift();
    return report;
  }

  raise(item) {
    const r = this.deps.alert?.({ category: 'remote-watch', ...item });
    return { key: item.key, type: item.type, ...(r && typeof r === 'object' ? r : {}) };
  }
}
const label = backend => backend;

module.exports = { RemoteWatch, readLedger, activeFromLedger, normalizeReply, DEFAULTS };
