'use strict';
// 订阅直通的投递口（2026-11-18）：把程序事件（成员告警、远端作业失败/卡住/完成）直接送进该管的会话，不经前台。
//   2. 否则会话开着 → 空闲时用同一个提交入口（sendPrompt）发一条新消息；忙时排队，每 retryMs 再看；
//   4. 发送结果不明 → 不重发，记「待核对」并调 onUnconfirmed。
const crypto = require('node:crypto');

class DirectFeed {
  constructor(deps = {}, { retryMs = 30_000, maxAgeMs = 6 * 3600_000 } = {}) {
    // { getSession(id), isBusy(id), sendPrompt(id, text, submissionId), teamNotify(id, text)->{ok}|null, onGone(item), onUnconfirmed(item), now }
    this.deps = deps; this.retryMs = retryMs; this.maxAgeMs = maxAgeMs;
    this.queue = []; this.unconfirmed = []; this.timer = null; this.log = [];
    // 落盘（2026-11-19）：deps.store 是 FeedStore。重启后接着送上次没送出的；已送出的不存，不会重发。
    // 发送前先把这条标成「在途」并立即写盘（Codex 复审 P1）：重启时还标着在途的，送没送到不确定，按「待核对」提示、不重发。
    if (deps.store) {
      const saved = deps.store.load('direct').filter(x => x && x.id && x.sessionId && typeof x.text === 'string');
      this.queue = saved.filter(x => !x.sending);
      const unsure = saved.filter(x => x.sending).map(({ sending, ...x }) => ({ ...x, error: 'Hub 重启时这条正在发送，送没送到不确定', checkedAt: this.now() }));
      if (unsure.length) {
        this.unconfirmed.push(...unsure);
        setTimeout(() => { for (const bad of unsure) { try { this.deps.onUnconfirmed?.(bad); } catch {} } this.persist(); }, 0).unref?.();
      }
      if (this.queue.length) this.arm(Math.min(5000, retryMs));
    }
  }
  persist(now = false) { try { this.deps.store?.save('direct', this.queue, { now }); } catch (error) { console.warn('[direct-feed] 落盘失败', error.message); } }
  remove(item) { const i = this.queue.indexOf(item); if (i >= 0) this.queue.splice(i, 1); }
  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  deliver(sessionId, text, { key = null } = {}) {
    if (!sessionId || !text) return { ok: false, error: '缺少收件会话或正文' };
    let team = null;
    try { team = this.deps.teamNotify?.(sessionId, text); } catch (error) { team = { ok: false, error: error.message }; }
    if (team?.ok) { this.log.push({ at: this.now(), sessionId, key, via: 'team' }); return { ok: true, via: 'team' }; }
    if (!this.deps.getSession?.(sessionId)) return { ok: false, error: '收件会话没开着' };
    const id = 'direct-' + crypto.randomBytes(6).toString('hex');
    this.queue.push({ id, sessionId, text, key, at: this.now() });
    this.persist();
    void this.pump();
    return { ok: true, via: 'session', queued: true, id };
  }
  arm(delay = this.retryMs) {
    if (this.timer || !this.queue.length) return;
    this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, delay);
    this.timer.unref?.();
  }
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      // 不再把整个队列取出来（Codex 复审 P1：发送中新入队的消息落盘时会漏掉取出的那几条）：逐条处理，处理完才从队列里删。
      const sentNow = new Set();
      for (const item of [...this.queue]) {
        if (!this.queue.includes(item)) continue;
        if (!this.deps.getSession?.(item.sessionId) || this.now() - item.at > this.maxAgeMs) {
          this.remove(item); this.persist(true);
          this.log.push({ at: this.now(), id: item.id, action: 'gone' });
          try { this.deps.onGone?.(item); } catch {}
          continue;
        }
        // 同一会话一次只送一条、按先后：送完这一条，后面同一会话的等下一拍（它刚收到消息，正忙）。
        if (sentNow.has(item.sessionId) || this.queue.find(x => x.sessionId === item.sessionId) !== item || this.deps.isBusy?.(item.sessionId)) continue;
        item.sending = true; this.persist(true);
        let r;
        try { r = await this.deps.sendPrompt(item.sessionId, item.text, item.id); } catch (error) { r = { ok: false, error: error.message, notSent: !!error.notSent }; }
        delete item.sending;
        // 明确没送出才留在队里重发；送没送到不确定（抛异常、ok:false 但没说没送出）→ 不重发（避免同一事件把会话叫两遍），
        if (r && r.ok === false && r.notSent === true) { this.persist(true); continue; }
        sentNow.add(item.sessionId);
        this.remove(item); this.persist(true);
        if (r && r.ok === false) {
          const bad = { ...item, error: r.error || '发送结果不明', checkedAt: this.now() };
          this.unconfirmed.push(bad); if (this.unconfirmed.length > 50) this.unconfirmed.shift();
          this.log.push({ at: this.now(), id: item.id, action: 'unconfirmed', sessionId: item.sessionId, error: bad.error });
          console.warn('[direct-feed] 送没送到不确定，待核对', item.sessionId, bad.error);
          try { this.deps.onUnconfirmed?.(bad); } catch {}
          continue;
        }
        this.log.push({ at: this.now(), id: item.id, action: 'sent', sessionId: item.sessionId });
      }
    } finally { this.pumping = false; this.persist(); }
    this.arm();
  }
  pending() {
    const view = state => ({ text, ...rest }) => ({ ...rest, state, preview: String(text).slice(0, 80) });
    return this.queue.map(view('queued')).concat(this.unconfirmed.map(view('unconfirmed')));
  }
  close() { clearTimeout(this.timer); this.timer = null; }
}

module.exports = { DirectFeed };
