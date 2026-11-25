'use strict';
// 跨端「待你决定」（2026-11-21）：负责人请拍板时生成短编号；任一端回一行由程序直接路由回原负责人，不经前台模型。
// 编号只增不回收，旧编号永远不会指向新问题。规则见 contract/20261121-入口适配层接口-m1.md。
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeFileAtomic } = require('../atomic-write');

const DAY = 86400000;
const EXPIRE_MS = 7 * DAY;
const HOLD_MAX_MS = 2 * 3600000;
const RETRY_MS = 15000;
const KEEP_CLOSED = 200;
const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const NUM = '\\d{1,4}|[零一二两三四五六七八九十]{1,3}';
const CODE = new RegExp(`^(?:(D)|([低滴地第帝]))?\\s*(${NUM})(?:\\s*[号条项])?(?=$|[\\s:：]|[按照选方先不就同])\\s*[:：]?\\s*(.*)$`, 'isu');
const RECOMMEND = /^(?:就)?[按照](?:你的?)?推荐(?:的)?(?:做|来|办)?(?:吧)?$|^同意(?:你的?)?推荐(?:吧)?$/u;
const PICK = /^(?:选择?|选?方案)\s*(\d{1,2}|[A-Za-z]|[一二两三四五六七八九十]{1,3})(?:号|个)?(?:吧)?$/u;
const SKIP = /^(?:先)?不做(?:了|吧)?$|^先放放(?:吧)?$/u;
const LIST = /^(?:(?:有什么|有啥|有哪些)(?:事)?)?(?:要|需要|等)我(?:定|拍板|决定)(?:的)?(?:事)?(?:吗|么|呢)?[?？]?$|^待定(?:事项)?$|^待我定(?:的事)?$/u;

function toInt(raw) {
  const s = String(raw);
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u);
  if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0);
  return s.length === 1 && s in CN ? CN[s] : null;
}
function fixedAction(rest) {
  const s = String(rest || '').trim().replace(/[。.!！~～]+$/u, '');
  if (RECOMMEND.test(s)) return { action: 'recommend' };
  const p = s.match(PICK);
  if (p) { const n = toInt(p[1]); return { action: 'pick', pick: n === null ? p[1].toUpperCase() : String(n) }; }
  return SKIP.test(s) ? { action: 'skip' } : null;
}
function parseSegment(segment) {
  const m = String(segment).trim().match(CODE);
  if (!m) return null;
  const no = toInt(m[3]);
  if (!no) return null;
  const strict = !!m[1], rest = m[4].trim(), fixed = fixedAction(rest);
  if (fixed) return { no, ...fixed, ...(!m[1] && !m[2] ? { bare: true } : {}) };
  if (!strict) return null; // 同音字和纯数字只认固定动作，防止「第3个方案再看看」被误判
  return rest ? { no, action: 'free', text: rest } : { no, action: 'detail' };
}
// 只有整条消息符合格式才返回结果，否则返回 null（照常交给前台）。
function parseLine(input) {
  // 只把全角字母数字转半角，标点保持原样：自由文字要一字不差转给负责人。
  const text = String(input || '').replace(/[Ａ-Ｚａ-ｚ０-９]/gu, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim().replace(/[。.!！]+$/u, '');
  if (!text || text.length > 500) return null;
  if (LIST.test(text)) return { type: 'list' };
  const tidy = text.replace(/(^|[,，;；、\n]\s*)(D\s*(?:\d{1,4}|[零一二两三四五六七八九十]{1,3}))\s*[:：,，、]\s*/giu, '$1$2 ');
  const parts = tidy.split(/[,，;；、\n]+/u).map(x => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const parsed = parts.map(parseSegment);
  if (!parsed[0]) return null;
  if (parts.length === 1) return { type: 'answer', items: parsed };
  // 只有第一段带编号：后面是这条决定的补充说明，整段原文转达（仅严格 D 编号）。
  if (parsed.slice(1).every(x => !x) && /^D/i.test(parts[0])) {
    const m = tidy.match(/^D\s*(?:\d{1,4}|[零一二两三四五六七八九十]{1,3})(?:\s*[号条项])?\s*[:：]?\s*(.*)$/isu);
    return { type: 'answer', items: [{ no: parsed[0].no, action: 'free', text: m[1].trim() }] };
  }
  return parsed.every(Boolean) ? { type: 'answer', items: parsed } : null;
}
function wording(item) {
  if (item.action === 'recommend') return '按你推荐的做。';
  if (item.action === 'pick') return `我选 ${item.pick}，按这个做。`;
  if (item.action === 'skip') return '这件先不做，收尾即可，不用再等我。';
  return String(item.text || '').trim();
}
const answerLabel = item => item.label ? String(item.label) : (item.action === 'recommend' ? '按推荐' : item.action === 'pick' ? `选 ${item.pick}` : item.action === 'skip' ? '先不做' : '已转达你的话');
const clock = at => new Date(at + 8 * 3600000).toISOString().slice(11, 16);
const clip = (s, n) => { const c = [...String(s || '').replace(/\s+/g, ' ').trim()]; return c.length > n ? c.slice(0, n).join('') + '…' : c.join(''); };

class Decisions {
  // deliver(rec, text, submissionId) → { state:'sent'|'busy'|'unknown'|'failed', error? }
  constructor({ dir, deliver, now = () => Date.now(), onLate = () => {}, retryMs = RETRY_MS }) {
    this.file = path.join(dir, 'decisions.json'); this.deliver = deliver; this.now = now; this.onLate = onLate; this.retryMs = retryMs;
    this.seq = 0; this.items = []; this.timer = null; this.pumping = false;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.seq = Number(raw.seq) || 0; this.items = Array.isArray(raw.items) ? raw.items : [];
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // 坏文件备份后继续；新编号从时间取起点，避开坏文件里可能用过的旧号。
        try { fs.copyFileSync(this.file, `${this.file}.bad-${this.now()}`); } catch {}
        this.seq = Math.floor(this.now() / 1000) % 100000;
        console.warn('[decisions] 读取失败，从空开始：', error.message);
      }
    }
    // 上次退出时正在提交：可能已经发出，按未确认收口，绝不重发同一决定。
    let recovered = false;
    for (const x of this.items) if (x.delivery?.sending) { const d = x.delivery; delete x.delivery; delete x.closing; x.status = 'answered'; x.closedAt = this.now(); x.answer = { label: d.label, from: d.from, endpoint: d.endpoint, at: this.now(), confirmed: false }; recovered = true; }
    if (recovered) this.save();
    if (this.items.some(x => x.delivery)) this.arm();
  }
  save() {
    const closed = this.items.filter(x => x.status !== 'open');
    if (closed.length > KEEP_CLOSED) { const drop = new Set(closed.slice(0, closed.length - KEEP_CLOSED)); this.items = this.items.filter(x => !drop.has(x)); }
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeFileAtomic(fs, this.file, JSON.stringify({ version: 1, seq: this.seq, items: this.items })); }
    catch (error) { console.warn('[decisions] 落盘失败', error.message); }
  }
  sweep() {
    const now = this.now(); let changed = false;
    for (const x of this.items) if (x.status === 'open' && !x.delivery && now - x.createdAt > EXPIRE_MS) { x.status = 'expired'; x.closedAt = now; changed = true; }
    if (changed) this.save();
  }
  view({ textKey, delivery, closing, ...x }) { return { ...x, code: 'D' + x.no, queued: !!delivery }; }
  list() { this.sweep(); return this.items.filter(x => x.status === 'open' && !x.closing).sort((a, b) => b.no - a.no).map(x => this.view(x)); }
  // 当前概览「已回复」一栏：最近 since 毫秒内答复过的（已送达或未确认）。
  recentAnswered(since = 86400000) { const now = this.now(); return this.items.filter(x => x.status === 'answered' && x.answer && now - (x.answer.at || 0) < since).map(x => this.view(x)); }
  get(no) { this.sweep(); const x = this.items.find(r => r.no === Number(no)); return x ? this.view(x) : null; }
  openFor(sessionId) { this.sweep(); const x = this.items.find(r => r.sessionId === sessionId && r.status === 'open' && !r.closing); return x ? this.view(x) : null; }
  create({ sessionId, title, text, question, recommendation, source = null, ifNoReply = '' }) {
    const textKey = createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
    const same = this.items.find(x => x.sessionId === sessionId && x.status === 'open' && x.textKey === textKey);
    if (same) return this.view(same);
    const no = ++this.seq;
    this.closeSession(sessionId, { by: no, silent: true });
    const rec = { no, sessionId, title: clip(title, 40), question: clip(question, 120), recommendation: clip(String(recommendation || '').replace(/^[\s\-*\d.、>#]*(?:我的)?推荐(?:方案|做法)?\s*(?:\*\*)?\s*[:：]\s*/u, '').replace(/\*\*/g, ''), 80), createdAt: this.now(), status: 'open', answer: null, textKey, ...(source ? { source } : {}), ...(ifNoReply ? { ifNoReply: clip(ifNoReply, 80) } : {}) };
    this.items.push(rec); this.save();
    return this.view(rec);
  }
  closeSession(sessionId, { by = null, silent = false } = {}) {
    let changed = false;
    for (const x of this.items) {
      if (x.sessionId !== sessionId || x.status !== 'open') continue;
      // 正在提交的不能抹掉：话可能已经到了负责人那里，等提交结果出来再定是已回还是过时。
      if (x.delivery?.sending) { x.closing = { by: by || x.closing?.by || null }; changed = true; continue; }
      this.supersede(x, by); changed = true;
    }
    if (changed && !silent) this.save();
    return changed;
  }
  supersede(x, by) {
    const dropped = x.delivery; delete x.delivery; delete x.closing;
    x.status = 'superseded'; x.closedAt = this.now(); if (by) x.supersededBy = by;
    if (dropped) this.onLate(x, `D${x.no} 没送出：负责人「${x.title}」已往前走了${by ? `，最新待定是 D${by}` : ''}。`);
  }
  async answer(item, { endpoint = 'desktop', endpointLabel = '电脑' } = {}) {
    this.sweep();
    const rec = this.items.find(x => x.no === item.no), code = 'D' + item.no;
    if (!rec) return { code, ok: false, state: 'missing', text: `没有 ${code} 这一条，说「待定」可以看当前的。` };
    if (rec.status === 'answered') return { code, ok: false, state: 'answered', text: `${code} 已在 ${clock(rec.answer.at)} 从${rec.answer.from}回过：${rec.answer.label}。` };
    if (rec.status === 'superseded') return { code, ok: false, state: 'superseded', text: `${code} 已过时${rec.supersededBy ? `，最新的是 D${rec.supersededBy}` : ''}。` };
    if (rec.status === 'expired') return { code, ok: false, state: 'expired', text: `${code} 已过期，请到会话「${rec.title}」里看。` };
    if (rec.delivery) return { code, ok: true, state: 'queued', text: `${code} 已在排队给「${rec.title}」，它忙完就看到。` };
    const label = answerLabel(item), body = `${wording(item)}（用户从${endpointLabel}回复 ${code}）`;
    rec.delivery = { text: body, label, endpoint, from: endpointLabel, at: this.now(), id: `decision-${rec.no}-${this.now().toString(36)}` };
    this.save();
    return this.attempt(rec);
  }
  async attempt(rec) {
    const d = rec.delivery, code = 'D' + rec.no;
    d.sending = true; this.save();
    // 抛错只有带 notSent 才算确实没发出；其余可能已写入，按未确认处理，避免重复下达。
    let r; try { r = await this.deliver(rec, d.text, d.id); } catch (error) { r = error?.notSent === true ? { state: 'failed', error: error.message } : { state: 'unknown' }; }
    delete d.sending;
    if (rec.delivery !== d) return { code, ok: false, state: 'superseded', text: `${code} 已过时。` };
    const closing = rec.closing;
    if (closing && !['sent', 'unknown'].includes(r?.state)) {
      this.supersede(rec, closing.by); this.save();
      return { code, ok: false, state: 'superseded', text: `${code} 已过时${closing.by ? `，最新的是 D${closing.by}` : ''}。` };
    }
    if (r?.state === 'busy') {
      if (this.now() - d.at <= HOLD_MAX_MS) { this.save(); this.arm(); return { code, ok: true, state: 'queued', text: `已排队给「${rec.title}」，它忙完就看到（${code}）。` }; }
      r = { state: 'failed', error: '等了 2 小时会话一直没空下来' };
    }
    if (r?.state === 'sent' || r?.state === 'unknown') {
      delete rec.delivery; delete rec.closing; rec.status = 'answered'; rec.closedAt = this.now();
      rec.answer = { label: d.label, from: d.from, endpoint: d.endpoint, at: this.now(), confirmed: r.state === 'sent' }; this.save();
      return r.state === 'sent'
        ? { code, ok: true, state: 'sent', text: `已转给「${rec.title}」：${d.label}（${code}）。` }
        : { code, ok: true, state: 'unknown', text: `已发给「${rec.title}」，但没等到送达确认，不会自动重发，可到会话看一眼（${code}）。` };
    }
    delete rec.delivery; this.save();
    return { code, ok: false, state: 'failed', text: `${code} 没送到：${r?.error || '未知原因'}。这条还开着，可以再回一次。` };
  }
  arm() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, this.retryMs);
    this.timer.unref?.();
  }
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const rec of this.items.filter(x => x.delivery && !x.delivery.sending)) {
        const r = await this.attempt(rec);
        if (['sent', 'unknown', 'failed'].includes(r.state)) this.onLate(rec, r.text);
      }
    } finally { this.pumping = false; }
    if (this.items.some(x => x.delivery)) this.arm();
  }
  close() { clearTimeout(this.timer); this.timer = null; }
}

module.exports = { Decisions, parseLine, parseSegment, wording, toInt, EXPIRE_MS, HOLD_MAX_MS };
