'use strict';
// 不按在跑会话数堵人，只限制同一时刻正在启动的会话数，避免一口气拉起几十个 CLI；内存紧张时在回执里软提醒，不拦。
// 落盘：排队项和「开工中」项都存，派工账本写入后才清。重启时账本里没有的开工中项重新排队，有的不重发。
const os = require('node:os');

const MAX_LAUNCHING = 4;
const POLL_MS = 5000;
const LOW_MEM_FREE_BYTES = 2 * 1024 ** 3;
const LOW_MEM_FREE_RATIO = 0.1;

function memoryNote({ free = os.freemem(), total = os.totalmem() } = {}) {
  if (!(free > 0 && total > 0) || (free >= LOW_MEM_FREE_BYTES && free / total >= LOW_MEM_FREE_RATIO)) return '';
  return `内存偏紧：本机只剩 ${Math.round(free / 1024 ** 3 * 10) / 10} GB 可用，任务照常派出`;
}

class DispatchQueue {
  constructor({ run, hasLedger = () => false, store = null, notify = () => {}, softNote = memoryNote, maxLaunching = MAX_LAUNCHING, pollMs = POLL_MS }) {
    Object.assign(this, { runJob: run, hasLedger, store, notify, softNote, maxLaunching, pollMs });
    this.jobs = []; this.running = new Map(); this.timer = null;
    if (store) {
      const saved = store.load('dispatch').filter(x => x?.id && x.action);
      const redo = saved.filter(x => x.starting && !this.hasLedger(x.id)).map(({ starting, ...x }) => x);
      this.jobs = [...redo, ...saved.filter(x => !x.starting)];
      if (saved.length) this.persist();
      if (this.jobs.length) this.arm();
    }
  }
  // 开工中且账本还没写的排在前面，重启后最先补上。
  persist() {
    const starting = [...this.running.values()].filter(x => !x.ledgered).map(x => ({ ...x.job, starting: true }));
    try { this.store?.save('dispatch', [...starting, ...this.jobs], { now: true }); } catch (error) { console.warn('[dispatch-queue] 落盘失败', error.message); }
  }
  free() { return this.running.size < this.maxLaunching; }
  note() { try { return this.softNote() || ''; } catch { return ''; } }
  receipt(job) {
    const ahead = this.jobs.findIndex(x => x.id === job.id), note = this.note();
    return { ok: true, state: 'queued', queued: true, requestId: job.id, position: ahead + 1,
      summary: `排队中（前面还有 ${ahead} 个）：正在依次启动会话，轮到自动开工`, ...(note ? { resourceNote: note } : {}) };
  }
  async submit(job) {
    if (this.running.has(job.id)) return { ok: true, state: 'dispatching', requestId: job.id, summary: '这个任务正在开工，未重复派发' };
    if (this.jobs.some(x => x.id === job.id)) return this.receipt(job);
    if (!this.jobs.length && this.free()) {
      const result = await this.start(job), note = this.note();
      return note && result && typeof result === 'object' ? { ...result, resourceNote: note } : result;
    }
    this.jobs.push(job); this.persist(); this.arm();
    return this.receipt(job);
  }
  async start(job) {
    const row = { job, ledgered: false };
    this.running.set(job.id, row); this.persist();
    let result;
    try { result = await this.runJob(job, () => { if (!row.ledgered) { row.ledgered = true; this.persist(); } }); }
    catch (error) { result = { ok: false, state: 'unknown', error: error.message }; }
    finally { this.running.delete(job.id); this.persist(); this.pump(); }
    return result;
  }
  pump() {
    while (this.jobs.length && this.free()) {
      const job = this.jobs.shift();
      void this.start(job).then(result => { if (!result?.ok) this.notify(job, result); });
    }
    if (!this.jobs.length) { clearInterval(this.timer); this.timer = null; }
  }
  arm() {
    if (this.timer || !(this.pollMs > 0)) return;
    this.timer = setInterval(() => this.pump(), this.pollMs);
    this.timer.unref?.();
  }
  close() { clearInterval(this.timer); this.timer = null; }
}

module.exports = { DispatchQueue, MAX_LAUNCHING, memoryNote };
