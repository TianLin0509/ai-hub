'use strict';
// 主动告警：会话健康、远端监督等异常汇总成短消息，按认领表送给该管这件事的人（2026-11-18 订阅直通）。
//
// 去向由调用方注入的 route(item) 决定（health-wiring.js 按 claims.ownerOf 判）：
//   - session：直接送进某个会话（组队成员的负责人、提交远端作业的会话），走 sendToSession；送不进（会话没了）退回前台；
// 防刷屏：
//   - 合并：同一类（category）、同一去向的告警在 mergeMs（默认 2 分钟）窗口内攒成一条发；
//   - 限频：同一个 key 在 repeatMs（默认 30 分钟）内只发一次，期间重复的只计数，下次发时带上「期间又出现 N 次」；
const crypto = require('node:crypto');

const DEFAULTS = { mergeMs: 120_000, repeatMs: 30 * 60_000, maxPerHour: 6, frontRetryMs: 30_000, frontQueueMax: 40 };

function formatAlert(items) {
  const one = items.length === 1;
  const head = one ? items[0].conclusion : `${items.length} 条${items[0].categoryLabel || '异常'}：` + items.map(i => i.conclusion).join('；');
  const tried = [...new Set(items.map(i => i.tried).filter(Boolean))].join('；') || '还没有自动处理';
  const ask = items.map(i => i.ask).find(Boolean) || '';
  const repeats = items.reduce((n, i) => n + (i.suppressed || 0), 0);
  return [head + (repeats ? `（期间同类又出现 ${repeats} 次，已合并）` : ''), '已尝试：' + tried, ask ? '需要你：' + ask : '需要你：无'].join('\n');
}

const CATEGORY_LABEL = { 'session-health': '会话异常', 'remote-watch': '远端作业异常', relay: '换号接力' };

class AlertHub {
  constructor(deps = {}, options = {}) {
    // { now, route(item)->{to:'session'|'front'|'user', sid?, prefix?}, sendToSession(sid, alert)->{ok}, sendToFront(batch)->{ok}, notifyUser(notice), setTimeout, clearTimeout }
    this.deps = deps;
    this.opts = { ...DEFAULTS, ...options };
    this.lastSent = new Map();   // key -> {at, suppressed}
    this.buckets = new Map();    // category|去向 -> {items, timer, route, category}
    this.frontQueue = [];        // 等前台空闲的告警与知会
    this.frontTimer = null;
    this.userSends = [];
    this.log = [];
    // 落盘（2026-11-19）：deps.store 是 FeedStore，只存等前台空闲的告警与知会；重启后照旧等前台空闲再送。
    if (deps.store) {
      this.frontQueue = deps.store.load('alerts').filter(x => x && x.key && typeof x.text === 'string' && ['alert', 'note'].includes(x.kind));
      // 去重记录一并恢复（Codex 复审 P2）：告警按 front-alert:key，知会按 front:key。
      for (const x of this.frontQueue) this.lastSent.set((x.kind === 'alert' ? 'front-alert:' : 'front:') + x.key, { at: x.at || this.now(), suppressed: 0 });
      if (this.frontQueue.length) this.frontTimer = this.setTimer(() => this.flushFront(), 5000);
    }
  }
  // 正在送前台的那一批（frontSending）也写进去，送的同时新入队不会把它挤掉；宁可多送一次、不能丢（Codex 复审 P1）。
  persistFront(now = false) { try { this.deps.store?.save('alerts', (this.frontSending || []).concat(this.frontQueue), { now }); } catch (error) { this.log.push({ at: this.now(), action: 'persist-failed', error: error.message }); } }
  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  setTimer(fn, ms) { const t = (this.deps.setTimeout || setTimeout)(fn, ms); t?.unref?.(); return t; }
  route(item) {
    let r = null;
    try { r = this.deps.route?.(item); } catch (error) { this.log.push({ at: this.now(), key: item.key, action: 'route-failed', error: error.message }); }
    return r && ['session', 'front', 'user'].includes(r.to) ? r : { to: 'front' };
  }

  // 接收一条原始告警：{key, category, conclusion, tried, ask, sessionId?, deliverTo?, ...}
  raise(item) {
    if (!item?.key || !item.conclusion) throw new Error('告警缺少 key 或结论');
    const now = this.now();
    const last = this.lastSent.get(item.key);
    if (last && now - last.at < this.opts.repeatMs) { last.suppressed += 1; this.log.push({ at: now, key: item.key, action: 'suppressed' }); return { queued: false, suppressed: true }; }
    const category = item.category || 'general';
    const route = this.route(item);
    const bucketKey = category + '|' + route.to + (route.sid ? ':' + route.sid : '');
    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      bucket = { items: [], timer: null, route, category };
      this.buckets.set(bucketKey, bucket);
      bucket.timer = this.setTimer(() => this.flush(bucketKey), this.opts.mergeMs);
    }
    if (bucket.items.some(i => i.key === item.key)) return { queued: true, merged: true, to: route.to };
    const conclusion = route.prefix ? route.prefix + item.conclusion : item.conclusion;
    bucket.items.push({ ...item, conclusion, categoryLabel: CATEGORY_LABEL[category], suppressed: last?.suppressed || 0 });
    this.lastSent.set(item.key, { at: now, suppressed: 0 });
    return { queued: true, to: route.to };
  }

  async flush(bucketKey) {
    const bucket = this.buckets.get(bucketKey);
    if (!bucket) return null;
    this.buckets.delete(bucketKey);
    (this.deps.clearTimeout || clearTimeout)(bucket.timer);
    if (!bucket.items.length) return null;
    const { route, category } = bucket;
    const alert = { id: 'alert-' + crypto.randomBytes(5).toString('hex'), category, createdAt: this.now(), items: bucket.items, to: route.to,
      text: formatAlert(bucket.items), sessionIds: bucket.items.map(i => i.sessionId).filter(Boolean) };
    if (route.to === 'session') {
      let r = null;
      try { r = await this.deps.sendToSession?.(route.sid, alert); } catch (error) { r = { ok: false, error: error.message }; }
      if (r?.ok) { this.log.push({ at: this.now(), id: alert.id, action: 'to-session', sid: route.sid }); return alert; }
      this.log.push({ at: this.now(), id: alert.id, action: 'session-failed', sid: route.sid, error: r?.error || null });
      alert.text += `\n（原本要送给会话 ${String(route.sid).slice(0, 8)}，没送进去：${r?.error || '原因不明'}）`;
    }
    if (route.to === 'user') { await this.toUser(alert); return alert; }
    this.enqueueFront({ kind: 'alert', key: alert.id, text: alert.text, at: this.now(), alertId: alert.id, sessionIds: alert.sessionIds }, false);
    // 没有在等的重试就当场试送；有重试在等就跟着那一拍走。
    if (!this.frontTimer) await this.flushFront();
    return alert;
  }
  async flushAll() { for (const k of [...this.buckets.keys()]) await this.flush(k); if (this.frontQueue.length) await this.flushFront(); }

  // 2026-11-18 起前台不再处置告警、也没有 ack_alert 工具：送达即闭环。保留这个入口只为旧调用不报错。
  async ack({ id } = {}) { this.log.push({ at: this.now(), id, action: 'ack-ignored' }); return { ok: true, state: 'closed', note: '告警送达前台即闭环，不需要 ack' }; }

  async toUser(alert) {
    const now = this.now();
    this.userSends = this.userSends.filter(at => now - at < 3600_000);
    if (this.userSends.length >= this.opts.maxPerHour) {
      // 总闸：本小时推满了，攒进下一条（同一去向重新入队，repeatMs 后再发）。
      const key = alert.category + '|user';
      const bucket = this.buckets.get(key) || { items: [], route: { to: 'user' }, category: alert.category, timer: this.setTimer(() => this.flush(key), this.opts.repeatMs) };
      bucket.items.push(...alert.items); this.buckets.set(key, bucket);
      this.log.push({ at: now, id: alert.id, action: 'deferred-hourly-cap' });
      return { ok: true, state: 'deferred' };
    }
    this.userSends.push(now);
    const notice = { id: alert.id, title: alert.items[0].categoryLabel || '异常提醒', text: alert.text, kind: 'hub-alert', label: 'Hub 告警', sessionIds: alert.sessionIds };
    try { await this.deps.notifyUser?.(notice); } catch (error) { this.log.push({ at: now, id: alert.id, action: 'notify-failed', error: error.message }); return { ok: false, error: error.message }; }
    this.log.push({ at: now, id: alert.id, action: 'to-user' });
    return { ok: true, state: 'user' };
  }

  enqueueFront(entry, arm = true) {
    this.frontQueue.push(entry);
    // 队列上限：只丢最老的知会；告警不丢。
    while (this.frontQueue.length > this.opts.frontQueueMax) {
      const i = this.frontQueue.findIndex(x => x.kind === 'note');
      if (i < 0) break;
      this.frontQueue.splice(i, 1);
    }
    this.persistFront();
    if (arm && !this.frontTimer) this.frontTimer = this.setTimer(() => this.flushFront(), 0);
  }

  notifyFront({ key, text } = {}) {
    if (!key || !text) throw new Error('知会缺少 key 或正文');
    const now = this.now();
    const last = this.lastSent.get('front:' + key);
    if (last && now - last.at < this.opts.repeatMs) { last.suppressed += 1; return { queued: false, suppressed: true }; }
    this.lastSent.set('front:' + key, { at: now, suppressed: 0 });
    this.enqueueFront({ kind: 'note', key, text: String(text).slice(0, 600), at: now });
    return { queued: true };
  }
  // 同 key 只进一次队列（不按 30 分钟限频，事件本身就只发生一次）。
  raiseFront({ key, text, sessionIds = [] } = {}) {
    if (!key || !text) throw new Error('告警缺少 key 或正文');
    if (this.lastSent.has('front-alert:' + key)) return { queued: false, duplicate: true };
    this.lastSent.set('front-alert:' + key, { at: this.now(), suppressed: 0 });
    this.enqueueFront({ kind: 'alert', key, text: String(text).slice(0, 1200), at: this.now(), alertId: key, sessionIds });
    this.log.push({ at: this.now(), key, action: 'raise-front' });
    return { queued: true };
  }
  announce({ key, text, title = '前台已代办' } = {}) {
    if (!key || !text) throw new Error('知会缺少 key 或正文');
    let user = false;
    try { user = !!this.deps.notifyUser?.({ id: 'announce:' + key, title, text: String(text).slice(0, 600), kind: 'hub-announce', label: title }); }
    catch (error) { this.log.push({ at: this.now(), key, action: 'announce-user-failed', error: error.message }); }
    return { user, front: this.notifyFront({ key, text }) };
  }

  async flushFront() {
    this.frontTimer = null;
    // 同一时间只送一批（Codex 复审 P1）；在送的那批结束后再送新到的。
    if (this.frontSending) return null;
    const now = this.now();
    const items = this.frontQueue.filter(i => i.kind === 'alert' || now - i.at < this.opts.repeatMs);
    this.frontQueue = [];
    if (!items.length) { this.persistFront(); return null; }
    this.frontSending = items;
    const alerts = items.filter(i => i.kind === 'alert'), notes = items.filter(i => i.kind === 'note');
    const batch = { id: (alerts.length ? 'alert-batch-' : 'note-') + crypto.randomBytes(5).toString('hex'), category: alerts.length ? 'front-alert' : 'front-note', createdAt: now,
      noAck: true, items: items.map(i => ({ key: i.key, conclusion: i.text, kind: i.kind })),
      alertsText: alerts.map(i => i.text).join('\n\n'), notesText: notes.map(i => '· ' + i.text).join('\n'),
      text: items.map(i => i.kind === 'note' ? '· ' + i.text : i.text).join('\n'), sessionIds: [...new Set(alerts.flatMap(i => i.sessionIds || []))] };
    let r = null;
    try { r = await this.deps.sendToFront?.(batch); } catch (error) { r = { ok: false, error: error.message }; }
    this.frontSending = null;
    if (r?.ok) { this.log.push({ at: now, id: batch.id, action: alerts.length ? 'to-front' : 'note-to-front', count: items.length }); this.persistFront(true); if (this.frontQueue.length && !this.frontTimer) this.frontTimer = this.setTimer(() => this.flushFront(), 0); return batch; }
    this.log.push({ at: now, id: batch.id, action: 'front-wait', error: r?.error || null });
    this.frontQueue = items.concat(this.frontQueue);
    this.persistFront();
    if (!this.frontTimer) this.frontTimer = this.setTimer(() => this.flushFront(), this.opts.frontRetryMs);
    return null;
  }

  pending() { return this.frontQueue.map(e => ({ id: e.alertId || e.key, kind: e.kind, state: 'waiting-front', text: e.text, createdAt: e.at })); }
}

module.exports = { AlertHub, formatAlert, DEFAULTS };
