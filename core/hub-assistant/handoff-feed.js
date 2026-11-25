'use strict';
// 负责人交卷直送前台（2026-11-18 前台纯派活）。认领表里 owner 是 front 的负责人每答完一轮，按下面的程序规则分三种，不调模型：
//
//   3. 交卷：负责人这轮答完后已经空闲（不在跑、没有待送的提交），它名下没有在跑或排队中的组队成员，
//      也没有还可能在跑的远端作业票（remote-jobs.jsonl 里 hub_session=它、48 小时内、还没查到完成/失败/取消），
//   4. 其他（负责人还在跑、成员还在干活或排队、远端作业没回来、结论说在等结果）→ 中途进展：不进前台，只记进 latest() 给看板用。
//
// 「还在等」规则（2026-11-18 独立审查后加）：负责人提交了作业 / 派了活后空闲下来，第一行常写「已提交，等结果」。
// 「已提交 PR」「已提交合入」这类做完的不算。漏判（真交卷被当中途）的代价是这条只进看板，等作业完成直通叫醒它后的下一轮再交卷。
//
//   - 第一行：负责人这轮的第一行结论（负责人规则要求第一行就是加粗结论，程序取它，不调模型）；
//   - 第二行：请拍板 =「推荐：…」+ 回「Dn 按推荐」的回法；交卷 = 正文里下一句有内容的话；
//   - 电脑：窗口顶部的简述条（哪个页面都看得到），点「打开会话」跳过去；手机/微信：按最近活跃的端推同样两行，回「Dn 详情」看全文。
//
// 旧的前台转述：正文截到约 1500 字，附会话名和会话号；2 分钟内的多条合成一批（第一条立即送，之后 2 分钟内到的攒到窗口结束一起送）；
const { isNoUpdateReply } = require('../team-silent-reply');
const { conclusion } = require('./progress-feed');

const DECIDE = /等你|要你定|请你定|你来定|需要你|拍板|请用户/;
const STILL_WAITING = /[等待] ?(远端|作业|结果|回执|跑完|CI|ci|成员)|已提交.{0,6}(作业|远端)|(作业|成员)(还|仍)?在跑|排队中/;
const PREFIX = { handoff: '【负责人交卷，不是用户原话】', decide: '【负责人请用户拍板，不是用户原话】' };
const DEFAULTS = { checkDelays: [5000, 20000], batchMs: 120_000, retryMs: 30_000, maxChars: 1500 };

function classify({ text, viewState, idle, membersBusy, remoteOpen = 0 }) {
  const body = String(text || '').trim();
  if (!body || isNoUpdateReply(body)) return 'silent';
  const head = conclusion(body);
  if (viewState === 'wait' || DECIDE.test(head)) return 'decide';
  if (idle && !membersBusy && !(remoteOpen > 0) && !STILL_WAITING.test(head)) return 'handoff';
  return 'progress';
}

function formatItem(item, maxChars = DEFAULTS.maxChars) {
  const body = String(item.text || '').trim();
  const cut = body.length > maxChars ? body.slice(0, maxChars) + `…（已截断，全文 ${body.length} 字，点开会话看原文）` : body;
  const code = item.kind === 'decide' && item.code ? `（待定编号 ${item.code}，转告时带上这个编号；用户回「${item.code} 按推荐 / 选N / 先不做」由程序直接转回负责人）` : '';
  return `${PREFIX[item.kind]}负责人「${item.title}」（会话 ${item.sessionId}）${code}\n${cut}`;
}

const clip = (text, n) => { const chars = [...String(text || '').replace(/\s+/g, ' ').trim()]; return chars.length > n ? chars.slice(0, n).join('') + '…' : chars.join(''); };
const plainLine = line => String(line || '').replace(/^#+\s*/, '').replace(/^📌\s*/, '').replace(/\*\*/g, '').replace(/`?\[\[hub:[^\]\n]{0,80}\]\]`?/g, '').replace(/^[-*>\s]+/, '').trim();

// 两行简述：每行约 60 字。拍板项第二行给推荐和回法；交卷第二行取正文里结论之后第一句有内容的话。
function brief({ kind, text, code = null, recommendation = '' }) {
  const lines = String(text || '').split(/\r?\n/).map(plainLine).filter(x => x && !/^[-=|:\s]+$/.test(x));
  const first = clip(lines[0] || '', 60);
  let second = '';
  if (kind === 'decide') {
    const r = plainLine(recommendation), m = r.match(/推荐[:：]?\s*(.+)$/), rec = clip(m ? m[1] : r, 36);
    second = (rec ? `推荐：${rec}　` : '') + (code ? `回「${code} 按推荐 / 选N / 先不做」` : '到会话里回复');
  } else second = clip(lines.slice(1).find(x => !/^(原因|依据|详情|细节|下一步|做到哪一步|怎么验证)[:：]?$/.test(x)) || '', 60);
  return { lines: second ? [first, second] : [first] };
}

class HandoffFeed {
  constructor(assistant, options = {}) {
    this.a = assistant; this.opts = { ...DEFAULTS, ...options };
    this.pending = new Map(); this.batch = []; this.timer = null; this.lastFlushAt = 0; this.progress = new Map(); this.log = [];
    // 落盘（2026-11-19）：options.store 是 FeedStore。等前台的交卷批次、刚答完还在复核的那一轮都存；重启后复核照做、批次照送。
    this.store = options.store || null;
    if (this.store) {
      const saved = this.store.load('handoff');
      this.batch = saved.filter(x => x.state === 'batch' && x.sessionId && x.kind && typeof x.text === 'string').map(({ state, ...x }) => x);
      for (const x of saved.filter(x => x.state === 'check' && x.sessionId && typeof x.text === 'string'))
        this.wait(x.sessionId, { entry: { text: x.text }, title: x.title, attempt: 0 });
      if (this.batch.length) this.arm(5000);
    }
  }
  // 正在送前台的那一批（this.sending）也写进去（Codex 复审 P1：送的同时有新交卷入队，落盘不能漏掉在送的）。
  // 交卷宁可多转告一次、不能丢：重启时还在送的按没送出处理，重新送。
  persist(now = false) {
    if (!this.store) return;
    const checks = [...this.pending].map(([sessionId, p]) => ({ state: 'check', sessionId, title: p.title, text: String(p.entry?.text || '') }));
    const batch = (this.sending || []).filter(i => !this.batch.some(x => x.sessionId === i.sessionId)).concat(this.batch);
    try { this.store.save('handoff', batch.map(x => ({ state: 'batch', ...x })).concat(checks), { now }); } catch (error) { console.warn('[handoff] 落盘失败', error.message); }
  }
  now() { return this.opts.now ? this.opts.now() : Date.now(); }
  isBusy(id) {
    const deps = this.a.deps, s = deps.getSession(id);
    if (!s) return false;
    return !!deps.isAgentTurnActive?.(id) || require('../session-runtime-truth').sessionRuntimeIsActive(s) || s.status === 'running' || !!deps.hasPendingPrompt?.(id);
  }
  membersBusy(leadSid) {
    let teams = []; try { teams = this.a.deps.getTeams?.() || []; } catch {}
    const team = teams.find(t => t.leadSid === leadSid);
    // 排队中（已批准、还没开工、还没有会话号）的成员也算「还有活在做」（2026-11-18 Codex 复审）。
    return !!team && (team.members || []).some(m => !m.delivered && (m.status === 'queued'
      || (m.sid && !['dismissed', 'failed', 'interrupted'].includes(m.status) && this.isBusy(m.sid))));
  }
  remoteOpen(leadSid) { try { return Number(this.a.care?.remoteOpenFor?.(leadSid)) || 0; } catch { return 0; } }
  // 返回 true 表示这个会话归交卷直送管（调用方不要再按普通会话推进展）。
  onTurn(sessionId, meta, entries = []) {
    if (!this.a.claims?.isFrontLead(sessionId)) return false;
    const entry = entries.at(-1);
    if (!entry || classify({ text: entry.text, idle: true }) === 'silent') return true;
    this.wait(sessionId, { entry, title: meta?.title || meta?.name || sessionId.slice(0, 8), attempt: 0 });
    return true;
  }
  wait(sessionId, item) {
    clearTimeout(this.pending.get(sessionId)?.timer);
    const timer = setTimeout(() => { try { this.check(sessionId); } catch (error) { console.warn('[assistant] handoff', error.message); } }, this.opts.checkDelays[item.attempt]);
    timer.unref?.();
    this.pending.set(sessionId, { ...item, timer });
    this.persist();
  }
  check(sessionId) {
    const item = this.pending.get(sessionId);
    if (!item) return null;
    this.pending.delete(sessionId);
    try { return this.classifyPending(sessionId, item); } finally { this.persist(); }
  }
  classifyPending(sessionId, item) {
    const idle = !this.isBusy(sessionId);
    // 刚答完时运行标记可能还没落下：再等一拍，仍在跑就按中途进展算。
    if (!idle && item.attempt + 1 < this.opts.checkDelays.length) { this.wait(sessionId, { ...item, attempt: item.attempt + 1 }); return null; }
    const viewState = this.a.sessionViews?.get(sessionId)?.hubState?.state || null;
    const kind = classify({ text: item.entry.text, viewState, idle, membersBusy: this.membersBusy(sessionId), remoteOpen: this.remoteOpen(sessionId) });
    this.log.push({ at: this.now(), sessionId, kind });
    if (kind === 'silent') return kind;
    if (kind === 'progress') { this.progress.set(sessionId, { line: conclusion(item.entry.text), at: this.now() }); return kind; }
    this.progress.delete(sessionId);
    const code = this.trackDecision(sessionId, kind, item);
    if (this.cardMode()) { void this.card({ sessionId, kind, title: item.title, text: item.entry.text, code }); return kind; }
    this.batch = this.batch.filter(x => x.sessionId !== sessionId).concat({ sessionId, kind, title: item.title, text: item.entry.text, at: this.now(), ...(code ? { code } : {}) });
    this.persist();
    this.arm();
    return kind;
  }
  // 请拍板生成跨端短编号；负责人已交卷时，它之前没回的那条待定就过时了。编号出问题不能挡住交卷本身。
  trackDecision(sessionId, kind, item) {
    const door = this.a.frontDoor;
    if (!door) return null;
    try {
      if (kind !== 'decide') { door.decisions.closeSession(sessionId); return null; }
      const text = String(item.entry.text || '');
      let card = null;
      try { const c = (this.a.deps.getProgressCards?.() || []).find(x => x?.sessionId === sessionId); card = c ? require('./lead-board').cardView(c, this.now())?.decision : null; } catch {}
      const line = text.split(/\r?\n/).map(x => x.trim()).find(x => /推荐/.test(x)) || '';
      return door.decisions.create({ sessionId, title: item.title, text, question: card?.question || conclusion(text), recommendation: card?.recommendation || line.replace(/^[-*\d.、\s]+/, ''), source: card ? 'card' : 'keyword', ifNoReply: card?.ifNoReply || '' }).code;
    } catch (error) { console.warn('[handoff] 待定编号生成失败', error.message); return null; }
  }
  cardMode() { return !!this.a.frontDoor && this.a.store?.get?.('handoffMode') !== 'relay'; }
  // 程序直接出简述卡（不经前台模型）：电脑顶部简述条 + 按最近活跃的端推送。推送失败只记日志，不退回前台转述（避免同一件事报两遍）。
  async card({ sessionId, kind, title, text, code }) {
    let rec = '';
    try { rec = code ? this.a.frontDoor.decisions.get(String(code).replace(/^D/i, ''))?.recommendation || '' : ''; } catch {}
    const { lines } = brief({ kind, text, code, recommendation: rec });
    const label = kind === 'decide' ? '请拍板' : '交卷';
    const head = kind === 'decide' && code ? `${code}「${title}」请拍板` : `「${title}」${label}`;
    const at = this.now();
    try {
      await this.a.frontDoor.push({ id: `lead-${kind}:${sessionId}:${at}`, title, kind: 'lead-' + kind, label, text: `${head}：${lines.join('\n')}`,
        extra: { jump: sessionId, brief: lines, ...(code ? { code } : {}) } });
      this.log.push({ at, sessionId, action: 'card', kind });
    } catch (error) {
      // 简述卡没写成（通知库出错）：退回旧的前台转述，交卷不能丢（2026-11-22 独立审查）。
      console.warn('[handoff] 简述卡推送失败，改由前台转述', error.message);
      this.log.push({ at, sessionId, action: 'card-failed', error: error.message });
      this.batch = this.batch.filter(x => x.sessionId !== sessionId).concat({ sessionId, kind, title, text, at, ...(code ? { code } : {}) });
      this.persist(); this.arm();
    }
  }
  arm(delay) {
    if (this.timer) return;
    const wait = delay ?? Math.max(0, this.lastFlushAt + this.opts.batchMs - this.now());
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, wait);
    this.timer.unref?.();
  }
  async flush() {
    // 同一时间只送一批（Codex 复审 P1：两批并发时后一批失败会清掉前一批的在途记录）；在送的那批结束后再送新到的。
    if (this.sending) return null;
    if (!this.batch.length) return null;
    const items = this.batch.splice(0);
    this.sending = items;
    const text = items.map(i => formatItem(i, this.opts.maxChars)).join('\n\n---\n\n');
    let r = null;
    try { r = await this.a.systemSend({ text, requestId: 'deliver-' + this.now().toString(36) + '-' + items.length, routed: true, decisionCodes: items.map(i => i.code).filter(Boolean) }); } catch (error) { r = { ok: false, error: error.message }; }
    this.sending = null;
    if (r?.ok) { this.lastFlushAt = this.now(); this.log.push({ at: this.now(), action: 'to-front', count: items.length }); this.persist(true); if (this.batch.length) this.arm(); return { ok: true, count: items.length, text }; }
    this.batch = items.filter(i => !this.batch.some(x => x.sessionId === i.sessionId)).concat(this.batch);
    this.persist();
    this.log.push({ at: this.now(), action: 'front-wait', error: r?.error || null });
    this.arm(this.opts.retryMs);
    return { ok: false, error: r?.error || null };
  }
  // 看板用：各负责人最近一条中途进展（第一行结论）。
  latest() { return Object.fromEntries(this.progress); }
  queued() { return this.batch.map(({ text, ...rest }) => rest); }
  close() { for (const p of this.pending.values()) clearTimeout(p.timer); this.pending.clear(); clearTimeout(this.timer); this.timer = null; }
}

module.exports = { HandoffFeed, classify, formatItem, brief, PREFIX, DECIDE, STILL_WAITING };
