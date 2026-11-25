'use strict';
// 电脑上的助理对话入口（助理 Tab 输入框）。2026-11-13 起取消千问快答：每条都交给前台会话；
// 前台会话连续 3 次收不下时，由 DeepSeek Flash（官方 API）兜底当场答一句（fallback-answer.js）。
const { randomUUID } = require('node:crypto');
const GIVE_UP_MS = 30 * 60000;

class AssistantDesk {
  constructor({ assistant, fallback = null, pollMs = 2000, store = null }) {
    this.a = assistant; this.fallback = fallback; this.pollMs = pollMs;
    this.queue = []; this.pending = null; this.timer = null; this.pumping = false;
    this.store = store;
    if (store) { this.queue = store.load('desk').filter(x => x && x.id && typeof x.text === 'string'); if (this.queue.length) this.arm(); }
  }
  persist(now = false) { try { this.store?.save('desk', this.queue.map(({ id, text, at }) => ({ id, text, at })), { now }); } catch (error) { console.warn('[assistant] desk 落盘失败', error.message); } }
  async ask(rawText, { to = 'auto', again = null } = {}) {
    const text = String(rawText || '').trim();
    if (!text || text.length > 50000) throw new Error('请输入要交给助理的内容');
    const id = randomUUID(), at = Date.now();
    if (!['auto', 'front', 'assistant'].includes(to)) throw new Error('请选择前台，或在会话工作区直接发送');
    if (to === 'front') to = 'auto';
    this.a.logDialog({ id, at, role: 'user', input: 'text', source: 'hub', text, ...(to === 'assistant' ? { forced: true } : {}), ...(again ? { again } : {}) });
    // 整条是拍板或列待定时由程序当场办完，不进前台会话；入口层出错就照常交给前台。
    try { const r = await this.a.frontDoor?.intake({ endpoint: 'desktop', text, requestId: id }); if (r?.handled) return { ok: true, id, lane: 'decision', reply: r.reply }; }
    catch (error) { console.warn('[assistant] intake', error.message); }
    this.a.logDialog({ id, role: 'route', lane: 'assistant', by: this.a.assistantLabel() });
    this.queue.push({ id, text, at }); this.persist(); this.arm(); void this.pump();
    return { ok: true, id, lane: 'assistant' };
  }
  // 助理空闲时把排队的话依次交给助理会话；忙时等它答完（turn 完成事件或兜底轮询）。
  async pump() {
    if (this.pumping || this.pending || !this.queue.length) return;
    this.pumping = true;
    try {
      const o = this.a.overview();
      if (o.submissionPending || ['running', 'waiting'].includes(o.status)) return;
      const job = this.queue[0];
      let r; try { r = await this.a.send({ text: job.text, requestId: job.id }); } catch (error) { r = { ok: false, error: error.message }; }
      if (!r?.ok) {
        job.tries = (job.tries || 0) + 1;
        if (job.tries >= 3) { this.queue.shift(); this.persist(); await this.giveUp(job, r?.error || r?.receipt?.message || '未知原因'); }
        return;
      }
      this.queue.shift(); this.persist(true); this.pending = { ...job, sessionId: r.sessionId, sentAt: Date.now() };
    } finally { this.pumping = false; }
  }
  // 前台会话收不下：有 DeepSeek Key 就兜底答一句，否则照旧提示稍后再说。
  async giveUp(job, reason) {
    if (this.fallback?.available?.()) {
      try {
        const r = await this.fallback.answer(job.text, { history: this.a.recentHistory?.() || [] });
        this.a.logDialog({ id: job.id, role: 'assistant', lane: 'fallback', by: r.by, text: r.text, ms: Date.now() - job.at, reason });
        return;
      } catch (error) { console.warn('[assistant] deepseek fallback failed', error.message); }
    }
    this.a.logDialog({ id: job.id, role: 'system', text: '助理暂时无法接收：' + reason + '。请稍后再说一次。' });
  }
  check() {
    const p = this.pending;
    if (!p) { void this.pump(); return; }
    let found = null;
    try { found = this.a.readLiveFinal(p.sessionId).records.find(x => x.clientSubmissionId === p.id); } catch {}
    if (found) {
      this.pending = null;
      this.a.logDialog({ id: p.id, role: 'assistant', lane: 'assistant', by: this.a.assistantLabel(), text: found.text, ms: Date.now() - p.at });
      void this.pump();
    } else if (Date.now() - p.sentAt > GIVE_UP_MS) { // 从送到助理会话起算：排队等上一句的时间不算在内
      this.pending = null;
      this.a.logDialog({ id: p.id, role: 'system', text: '超过 30 分钟没拿到助理的回复，可到工作台的助理会话查看。' });
      void this.pump();
    }
  }
  arm() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.pending && !this.queue.length) { clearInterval(this.timer); this.timer = null; return; }
      this.check();
    }, this.pollMs);
    this.timer.unref?.();
  }
  busy() { return { waiting: !!this.pending, queued: this.queue.length }; }
}
module.exports = { AssistantDesk };
