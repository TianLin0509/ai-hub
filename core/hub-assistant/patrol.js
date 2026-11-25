'use strict';
// 静默巡检与早晚简报（2026-11-21）：全程不调模型。无事不出声；负责人出错只报一次；
// 简报最多 5 条、结尾写「就这些」，没内容就不发，连续没人看自动降频。
const KEY = 'frontPatrol';
const DEFAULTS = Object.freeze({ patrol: true, briefs: false, morning: '08:30', evening: '21:00' });
const TICK_MS = 5 * 60000;
const SLOT_GRACE_MS = 2 * 3600000;
const DONE_WINDOW_MS = 12 * 3600000;
const MAX_ITEMS = 5;
const TZ = 8 * 3600000;

const dayOf = at => new Date(at + TZ).toISOString().slice(0, 10);
const slotAt = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+08:00`);
const clip = (s, n) => { const c = [...String(s || '').replace(/\s+/g, ' ').trim()]; return c.length > n ? c.slice(0, n).join('') + '…' : c.join(''); };

function allowedSlots(ignored) { return ignored >= 6 ? [] : ignored >= 3 ? ['morning'] : ['morning', 'evening']; }

function briefItems({ decisions = [], tasks = [], now }) {
  const items = decisions.map(d => `${d.code} 待你定：${clip(d.question, 40)}`);
  for (const t of tasks) if (t.state === 'error') items.push(`「${clip(t.title, 20)}」出错停下了`);
  for (const t of tasks) if (t.group === 'done' && now - t.at < DONE_WINDOW_MS) items.push(`「${clip(t.title, 20)}」有新结果${t.line ? `：${clip(t.line, 36)}` : ''}`);
  const running = tasks.filter(t => t.state === 'run').length;
  const kept = items.slice(0, running ? MAX_ITEMS - 1 : MAX_ITEMS);
  if (kept.length && running) kept.push(`另有 ${running} 个任务在跑`);
  return kept;
}

class FrontPatrol {
  constructor(assistant, { now = () => Date.now(), tickMs = TICK_MS } = {}) { this.a = assistant; this.now = now; this.tickMs = tickMs; this.timer = null; }
  config() { return { ...DEFAULTS, ...this.a.store.get(KEY + '.config') }; }
  configure(change) { const c = { ...this.config(), ...change }; this.a.store.set(KEY + '.config', c); return c; }
  state() { return { errors: {}, sent: {}, cards: [], ...this.a.store.get(KEY + '.state') }; }
  saveState(s) { this.a.store.set(KEY + '.state', s); }
  start() { if (this.timer) return; this.timer = setInterval(() => { try { this.tick(); } catch (error) { console.warn('[patrol]', error.message); } }, this.tickMs); this.timer.unref?.(); }
  leads() {
    const rows = this.a.frontClient?.tasks({ withLines: true })?.tasks || [];
    return rows.filter(r => this.a.claims?.isFrontLead?.(r.id));
  }
  ignoredCount(s) {
    const activity = Object.values(this.a.frontDoor?.activity() || {}).map(Number).filter(Boolean);
    const last = activity.length ? Math.max(...activity) : 0;
    let read = new Map();
    try { read = new Map(this.a.watches.notifications({ limit: 200 }).notifications.map(n => [n.id, n.readAt])); } catch {}
    let n = 0;
    for (const card of [...s.cards].reverse()) { if (read.get(card.id) || last > card.at) break; n++; }
    return n;
  }
  tick() {
    const c = this.config();
    if (!c.patrol || this.a.ownsTimers?.() === false) return { spoke: 0 };
    const now = this.now(), s = this.state(), tasks = this.leads(), errors = {};
    let spoke = 0;
    for (const t of tasks) {
      if (t.state !== 'error') continue;
      const was = s.errors[t.id] || { seen: 0, told: false }, cur = { seen: was.seen + 1, told: was.told };
      // 连续两次巡检都是出错才报，避开一闪而过的状态。
      if (cur.seen >= 2 && !cur.told) { cur.told = true; spoke++; void this.a.frontDoor?.push({ id: `patrol-error:${t.id}:${now}`, title: '巡检', kind: 'patrol', label: '巡检', text: `「${clip(t.title, 30)}」出错停下了，需要看一下。` }); }
      errors[t.id] = cur;
    }
    s.errors = errors;
    if (c.briefs) spoke += this.briefTick(c, s, tasks, now);
    this.saveState(s);
    return { spoke };
  }
  briefTick(c, s, tasks, now) {
    const day = dayOf(now), allowed = allowedSlots(this.ignoredCount(s));
    for (const slot of ['morning', 'evening']) {
      const at = slotAt(day, c[slot]), key = `${day}:${slot}`;
      if (now < at || now - at > SLOT_GRACE_MS || s.sent[key]) continue;
      s.sent[key] = now;
      for (const k of Object.keys(s.sent).sort().slice(0, -8)) delete s.sent[k];
      if (!allowed.includes(slot)) continue;
      const items = briefItems({ decisions: this.a.frontDoor?.decisions.list() || [], tasks, now });
      if (!items.length) continue;
      const id = `patrol-brief:${key}`, title = slot === 'morning' ? '早报' : '晚报';
      const text = `${title}\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n就这些。`;
      void this.a.frontDoor?.push({ id, title, kind: 'patrol-brief', label: title, text });
      s.cards = [...s.cards, { id, at: now }].slice(-12);
      return 1;
    }
    return 0;
  }
  close() { clearInterval(this.timer); this.timer = null; }
}

module.exports = { FrontPatrol, briefItems, allowedSlots, DEFAULTS, MAX_ITEMS };
