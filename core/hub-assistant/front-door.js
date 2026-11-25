'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Decisions, parseLine } = require('./decisions');
const endpoints = require('./endpoints');

const ACTIVITY_KEY = 'endpointActivity';
const USAGE_KEY = 'endpointUsage';
const USAGE_DAYS = 60;
const HEALTH_POLL_MS = 30000;
const STUCK_MS = 3 * 60000;
const BARE_NUMBER_WINDOW_MS = 10 * 60000;
const STUCK_POLL_MS = 30000;
const STUCK_FORGET_MS = 60 * 60000;
let current = null;
let waiters = [];

function publish(door) { current = door; const list = waiters; waiters = []; for (const w of list) { clearTimeout(w.timer); w.resolve(door); } }
function unpublish(door) { if (current === door) current = null; }
function whenReady(timeoutMs = 60000) {
  if (current) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const w = { resolve, timer: setTimeout(() => { waiters = waiters.filter(x => x !== w); reject(new Error('前台服务没有就绪')); }, timeoutMs) };
    w.timer.unref?.(); waiters.push(w);
  });
}
const dayOf = at => new Date(at + 8 * 3600000).toISOString().slice(0, 10);

class FrontDoor {
  constructor(assistant, { now = () => Date.now(), healthPollMs = HEALTH_POLL_MS, stuckPollMs = STUCK_POLL_MS } = {}) {
    this.assistant = assistant; this.now = now; this.pushers = new Map(); this.health = new Map(); this.waiting = new Map(); this.listedAt = new Map(); this.stuckPollMs = stuckPollMs; this.stuckTimer = null;
    this.dir = path.join(assistant.deps.dataDir, 'assistant');
    this.decisions = new Decisions({ dir: this.dir, now, deliver: (rec, text, id) => this.deliver(rec, text, id), onLate: (rec, text) => this.late(rec, text) });
    if (healthPollMs > 0) { this.healthTimer = setInterval(() => this.pollHealth(), healthPollMs); this.healthTimer.unref?.(); }
  }
  format(endpoint, text) { return endpoints.format(endpoint, text); }
  registerPusher(endpoint, fn) { this.pushers.set(endpoints.normalizeEndpoint(endpoint), fn); }
  activity() { return this.assistant.store.get(ACTIVITY_KEY) || {}; }
  usage() { return this.assistant.store.get(USAGE_KEY) || {}; }
  touch(endpoint) {
    const at = this.now(), day = dayOf(at), usage = { ...this.usage() };
    this.assistant.store.set(ACTIVITY_KEY, { ...this.activity(), [endpoint]: at });
    usage[day] = { ...usage[day], [endpoint]: (usage[day]?.[endpoint] || 0) + 1 };
    for (const d of Object.keys(usage).sort().slice(0, -USAGE_DAYS)) delete usage[d];
    this.assistant.store.set(USAGE_KEY, usage);
  }
  listText(endpoint) {
    const rows = this.decisions.list();
    if (!rows.length) return '现在没有要你定的事。';
    const max = endpoints.profileOf(endpoint).maxChars, tight = !!max && max <= 120, each = tight ? 24 : 60;
    const lines = rows.map(x => `${x.code} ${[...x.question].slice(0, each).join('')}${x.recommendation && !tight ? `（推荐：${x.recommendation}）` : ''}`);
    const tail = '回「D编号 按推荐/选N/先不做」';
    // 短屏放不下全部时保住编号和回复方法，其余条数说清楚。
    if (max) {
      const room = max - [...tail].length - 12, kept = [];
      let used = 0;
      for (const line of lines) { const n = [...line].length + 1; if (used + n > room) break; kept.push(line); used += n; }
      if (!kept.length) kept.push([...lines[0]].slice(0, Math.max(8, room)).join(''));
      const more = rows.length - kept.length;
      return `${rows.length} 件待定：\n${kept.join('\n')}${more ? `\n另有 ${more} 件` : ''}\n${tail}`;
    }
    return `${rows.length} 件待定：\n${lines.join('\n')}\n${tail}`;
  }
  detailText(rec) {
    return `${rec.code}「${rec.title}」：${rec.question}${rec.recommendation ? `\n推荐：${rec.recommendation}` : ''}${rec.status === 'open' ? `\n回「${rec.code} 按推荐/选N/先不做」` : ''}`;
  }
  async intake({ endpoint, text, rawText, requestId } = {}) {
    const name = endpoints.normalizeEndpoint(endpoint), profile = endpoints.profileOf(name);
    const said = String(rawText ?? text ?? '');
    try { this.touch(name); } catch (error) { console.warn('[front-door] 用量记录失败', error.message); }
    const parsed = parseLine(said);
    const done = (kind, reply, extra = {}) => {
      const cut = endpoints.format(name, reply);
      try { this.assistant.logDialog({ id: requestId, at: this.now(), role: 'assistant', lane: 'decision', by: '前台程序', text: cut }); } catch (error) { console.warn('[front-door] 回执记录失败', error.message); }
      return { handled: true, kind, reply: cut, ...extra };
    };
    if (parsed?.type === 'list') { this.listedAt.set(name, this.now()); return done('list', this.listText(name)); }
    const briefSwitch = said.trim().replace(/[。.!！]+$/u, '');
    if (this.assistant.patrol && /^(?:打开|开启)早晚简报$/u.test(briefSwitch)) { const c = this.assistant.patrol.configure({ briefs: true }); return done('setting', `早晚简报已打开：${c.morning} 和 ${c.evening}，没内容就不发。`); }
    if (this.assistant.patrol && /^(?:关闭|关掉|停掉)早晚简报$/u.test(briefSwitch)) { this.assistant.patrol.configure({ briefs: false }); return done('setting', '早晚简报已关闭。'); }
    if (parsed?.type === 'answer') {
      const known = parsed.items.map(x => this.decisions.get(x.no));
      // 自由文字或单独一个编号、但这个编号不存在：多半不是在拍板（比如问 D3.js），交给前台。
      // 纯数字开头（如「2 选 3」）只有这个端刚列过待定才算拍板，否则多半是在说别的事。
      const bareOk = this.now() - (this.listedAt.get(name) ?? -Infinity) < BARE_NUMBER_WINDOW_MS;
      const passThrough = parsed.items.some((x, i) => (x.bare && !bareOk) || (!known[i] && ['free', 'detail'].includes(x.action)));
      if (!passThrough) {
        if (parsed.items.length === 1 && parsed.items[0].action === 'detail') return done('detail', this.detailText(known[0]));
        const results = [];
        for (let i = 0; i < parsed.items.length; i++) {
          const item = parsed.items[i];
          if (item.action === 'detail') { results.push({ code: known[i].code, ok: true, state: 'detail', text: this.detailText(known[i]) }); continue; }
          results.push(await this.decisions.answer(item, { endpoint: name, endpointLabel: profile.label }));
        }
        return done('decision', results.map(x => x.text).join('\n'), { results });
      }
    }
    if (requestId) { this.waiting.set(requestId, { endpoint: name, said, at: this.now(), told: false, rescued: false }); this.armStuck(); }
    const base = String(text ?? said);
    const ownHint = name.startsWith('glasses') && rawText !== undefined && base !== said;
    return { handled: false, sendText: profile.hint && !ownHint ? `${base}\n\n${profile.hint}` : base };
  }
  armStuck() {
    if (this.stuckTimer || !(this.stuckPollMs > 0)) return;
    this.stuckTimer = setInterval(() => { void this.checkStuck().catch(error => console.warn('[front-door] 卡住检查失败', error.message)); }, this.stuckPollMs);
    this.stuckTimer.unref?.();
  }
  // 这句话有没有拿到答复：对话记录里有同编号的答复，或前台会话里有对应的最终回复。
  answered(id) {
    const a = this.assistant;
    try { if (a.dialog?.recent({ limit: 300 }).some(x => x.id === id && ['assistant', 'system'].includes(x.role))) return true; } catch {}
    try { const sid = a.store.get('sessionId'); if (sid && a.readLiveFinal?.(sid).records.some(x => x.clientSubmissionId === id)) return true; } catch {}
    return false;
  }
  async checkStuck() {
    const a = this.assistant, now = this.now();
    for (const [id, job] of [...this.waiting]) {
      if (this.answered(id) || now - job.at > STUCK_FORGET_MS) { this.waiting.delete(id); continue; }
      if (now - job.at < STUCK_MS || job.told) continue;
      job.told = true;
      const sid = a.store.get('sessionId'), open = !!(sid && a.deps.getSession(sid)), busy = open && !!a.sessionBusy?.(sid);
      const quote = [...job.said.replace(/\s+/g, ' ').trim()].slice(0, 16).join('');
      const from = endpoints.profileOf(job.endpoint).label;
      if (busy) { await this.push({ id: `front-stuck:${id}`, title: '前台', kind: 'front-stuck', label: '前台状态', text: `你从${from}说的「${quote}」等了 3 分钟，前台还在忙上一件，轮到就答。` }); continue; }
      const fallback = a.deps.fallback;
      if (job.endpoint !== 'desktop' && fallback?.available?.()) {
        job.rescued = true;
        try {
          const r = await fallback.answer(job.said, { history: a.recentHistory?.() || [] }), reply = endpoints.format(job.endpoint, r.text);
          a.logDialog({ id, at: this.now(), role: 'assistant', lane: 'fallback', by: r.by, text: reply, reason: '前台 3 分钟没接' });
          this.waiting.delete(id);
          await this.push({ id: `front-stuck:${id}`, title: '前台', kind: 'front-stuck', label: '备用模型代答', text: `前台没接上，备用模型先答「${quote}」：${reply}` });
          continue;
        } catch (error) { console.warn('[front-door] 兜底失败', error.message); }
      }
      await this.push({ id: `front-stuck:${id}`, title: '前台', kind: 'front-stuck', label: '前台状态', text: `你从${from}说的「${quote}」等了 3 分钟没接上：${open ? '前台没有开始处理' : '前台会话没开着'}。到电脑看一下，或再说一次。` });
    }
    if (!this.waiting.size) { clearInterval(this.stuckTimer); this.stuckTimer = null; }
  }
  async deliver(rec, text, submissionId) {
    const a = this.assistant, deps = a.deps, { nativeId } = require('./live-history');
    if (!deps.getSession(rec.sessionId)) {
      const meta = deps.getSessionMetadata?.(rec.sessionId);
      if (!meta || !nativeId(meta) || !deps.resumeSession) return { state: 'failed', error: '会话未打开且无法恢复' };
      try { await deps.resumeSession(rec.sessionId); } catch (error) { return { state: 'failed', error: '会话恢复失败：' + error.message }; }
      const opened = deps.getSession(rec.sessionId);
      if (!opened || nativeId(opened) !== nativeId(meta)) return { state: 'failed', error: '会话恢复后身份未确认' };
    }
    if (a.handoff?.isBusy(rec.sessionId)) return { state: 'busy' };
    const wire = require('./delegated-prompt').encodeDelegatedPrompt(text, deps.getSession(rec.sessionId)?.kind);
    let r;
    try { r = await deps.sendPrompt(rec.sessionId, wire, submissionId); }
    catch (error) { return error?.notSent === true ? { state: 'failed', error: error.message } : { state: 'unknown' }; }
    if (r?.notSent) return { state: 'failed', error: r?.message || r?.error || '会话没有接收' };
    return { state: r?.ok === true && r?.receipt?.status === 'confirmed' && !r.contentMismatch ? 'sent' : 'unknown' };
  }
  late(rec, text) { void this.push({ id: `decision-late:${rec.no}:${this.now()}`, title: '待你决定', text, kind: 'decision-receipt', label: '拍板回执' }); }
  // 按路由推送一条。微信失败改推手机；电脑的通知记录始终有。
  // extra：附在通知上的结构字段（如简述卡的 jump=要跳去的会话号、brief=两行简述），电脑顶部简述条用。
  async push({ id, title = '前台', text, kind = 'front-relay', label = '前台转告', route: routeKind = 'handoff', extra = {} }) {
    let targets = endpoints.route(this.activity(), { now: this.now(), kind: routeKind });
    const phoneText = endpoints.format('phone', text);
    this.assistant.watches.addNotice({ ...extra, id, title, kind, label, text, pushTo: targets, ...(phoneText !== text ? { phoneText } : {}) });
    return targets;
  }
  reportHealth({ endpoint, ok, reason = '' }) {
    const name = endpoints.normalizeEndpoint(endpoint), was = this.health.get(name);
    if (was && was.ok === !!ok) return false;
    this.health.set(name, { ok: !!ok, reason, at: this.now() });
    if (!was && ok) return false; // 第一次看到就是正常：不报
    const label = endpoints.profileOf(name).label;
    void this.push({ id: `endpoint-health:${name}:${this.now()}`, title: '入口状态', kind: 'endpoint-health', label: '入口状态', route: 'health',
      text: ok ? `${label}链路恢复了。` : `${label}链路断了：${reason || '原因未知'}` });
    return true;
  }
  pollHealth() {
    const dir = path.join(this.dir, 'endpoint-health');
    let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return; }
    for (const f of files) {
      try { const x = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (x && typeof x.ok === 'boolean') this.reportHealth({ endpoint: x.endpoint || f.slice(0, -5), ok: x.ok, reason: String(x.reason || '').slice(0, 120) }); }
      catch (error) { console.warn('[front-door] 健康文件读取失败', f, error.message); }
    }
  }
  close() { clearInterval(this.healthTimer); clearInterval(this.stuckTimer); this.stuckTimer = null; this.decisions.close(); unpublish(this); }
}

module.exports = { FrontDoor, publish, unpublish, whenReady, parseLine };
