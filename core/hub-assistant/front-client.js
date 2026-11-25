'use strict';
// 只管三件事：任务清单（和电脑助理页左栏同一套口径）、拍板项收起 / 恢复 / 按推荐、额度与状态摘要。
//
// - 手动收起：记下收起时刻；会话之后有新活动（新答复、他再发话）就自动浮出。
// - 自动收起：停在「等你」超过 24 小时没动静的，自动算收起；点「恢复」后从恢复时刻再给 24 小时。
// - 收起不通知负责这件事的会话，只改 Hub 本机记录；电脑左栏和手机共用这一份。
const DAY = 86400000;
const AUTO_PARK_MS = DAY;
const DONE_WINDOW_MS = 2 * 3600000;
const STORE_KEY = 'parkedSessions';
const RECOMMEND_TEXT = '按你推荐的做';
const SCENE_TAG = { coding: '编程', tech: '技术', life: '生活', writing: '写作' };

const isFront = s => s?.purpose === 'hub-assistant';
const isTask = s => s?.purpose === 'hub-assistant-task';
const isRetired = s => s?.purpose === 'hub-assistant-desk' || /（已换班）\s*$/.test(String(s?.title || ''));
const titleOf = s => String(s?.title || s?.name || '未命名会话').trim();
function sceneTag(s) {
  let id = s?.scene || s?.meta?.scene || '';
  if (!id && typeof s?.purpose === 'string' && s.purpose.startsWith('scene-')) id = s.purpose.slice(6);
  id = String(id || '').replace(/^\d+-/, '');
  return id ? SCENE_TAG[id] || id : '';
}

// 一条收起记录是否生效。rec = { at（手动收起时刻）, restoredAt（最近一次恢复时刻） }。
function parkState(rec, { state, at, now = Date.now() }) {
  if (rec?.at && !(at > rec.at)) return 'manual';
  if (state === 'wait' && now - Math.max(Number(at) || 0, Number(rec?.restoredAt) || 0) > AUTO_PARK_MS) return 'auto';
  return null;
}

// 左栏 / 任务清单的分组规则（电脑助理页 groupSessions 和这里共用）：在跑、等你、异常进「在跑」；
// 有新消息或 2 小时内刚动过的进「刚完成」；其余空闲。收起的不排前、不亮红点，放进空闲。
function placeRow({ state, red, at, parked, now = Date.now() }) {
  if (parked) return 'idle';
  if (['run', 'wait', 'error'].includes(state)) return 'run';
  return red || (state !== 'dorm' && at > now - DONE_WINDOW_MS) ? 'done' : 'idle';
}

// 进入左栏 / 任务清单的会话：前台派出的，或近 24 小时有活动的；不含前台自己、退役助理、群聊。
function listed(s, at, now) {
  if (!s || !s.id || isFront(s) || isRetired(s) || s._isMeeting || s.meetingId) return false;
  return isTask(s) || at > now - DAY;
}

class FrontClient {
  // assistant：AssistantService；onChange：收起记录变了（电脑左栏、手机都要刷新）。
  constructor(assistant, { onChange = () => {}, now = () => Date.now() } = {}) {
    this.a = assistant; this.onChange = onChange; this.now = now; this.quotaView = null;
    try { this.prune(); } catch (error) { console.warn('[front-client] prune', error.message); }
  }
  parks() { return this.a.store.get(STORE_KEY) || {}; }
  savePark(map) { this.a.store.set(STORE_KEY, map); try { this.onChange(map); } catch (error) { console.warn('[front-client] onChange', error.message); } }
  // 电脑助理页右栏额度表算好后发来的精简读数：[{provider,no,profileId,remain5h,remain7d,reset5h,reset7d,front}]。
  setQuotaView(rows) { if (Array.isArray(rows)) this.quotaView = { rows: rows.slice(0, 40), at: this.now() }; }

  activity(s) { try { return require('../session-recency').latestActivityTime(s, 0) || 0; } catch { return Number(s?.lastMessageTime) || 0; } }

  tasks({ withLines = true } = {}) {
    const now = this.now(), parks = this.parks(), rows = [];
    let cards = [];
    try { cards = this.a.deps.getProgressCards?.() || []; } catch {}
    const cardOf = new Map(cards.filter(c => c && c.sessionId).map(c => [c.sessionId, c]));
    for (const s of this.a.sessions()) {
      const at = this.activity(s);
      if (!listed(s, at, now)) continue;
      const view = s.sidebarView?.hubState || null;
      const state = view?.state || (s.isOpen ? 'idle' : 'dorm');
      const park = parkState(parks[s.id], { state, at, now });
      const red = !park && !!view?.hasUnread;
      let decision = null;
      try { decision = require('./lead-board').cardView(cardOf.get(s.id), now)?.decision || null; } catch {}
      rows.push({ id: s.id, title: titleOf(s), scene: sceneTag(s), byFront: isTask(s), state, red, at,
        parked: park, group: placeRow({ state, red, at, parked: !!park, now }),
        decision: decision ? { question: decision.question, recommendation: decision.recommendation || '' } : null,
        decisionNo: this.a.frontDoor?.decisions?.openFor(s.id)?.no || null });
    }
    if (withLines && rows.length) {
      // latest：最新一条答复（lineAt 用它，「已读」判断靠它）；said：最新一条有内容的答复（一句话进展用它）。
      const latest = new Map(), said = new Map();
      let entries = [];
      try { entries = this.a.ledger.since(now - 3 * DAY, { maxEntries: 400, maxChars: 400000 }).entries || []; } catch {}
      const marker = /^\s*(\[\[hub:[\w-]+\]\]\s*)+$/;
      const keep = (m, e) => { if (!m.has(e.sessionId) || m.get(e.sessionId).at < e.at) m.set(e.sessionId, e); };
      for (const e of entries) if (e?.sessionId) { keep(latest, e); if (!marker.test(String(e.text || ''))) keep(said, e); }
      const { conclusion } = require('./progress-feed');
      for (const r of rows) { const e = latest.get(r.id), t = said.get(r.id); if (t) r.line = conclusion(t.text, 90); if (e) r.lineAt = e.at; }
    }
    const RANK = { run: 0, done: 1, idle: 2 };
    // 「等你」排在在跑里最前面，其次按最近活动。
    rows.sort((x, y) => RANK[x.group] - RANK[y.group] || (y.state === 'wait' && !y.parked) - (x.state === 'wait' && !x.parked) || y.at - x.at);
    return { ok: true, at: now, tasks: rows, waiting: rows.filter(r => r.state === 'wait' && !r.parked).length,
      running: rows.filter(r => r.state === 'run').length, parked: rows.filter(r => r.parked).length };
  }
  signature() {
    const t = this.tasks({ withLines: false });
    return JSON.stringify(t.tasks.map(r => [r.id, r.title, r.state, r.red, r.parked, r.group, r.decision?.question || '', r.decisionNo || 0, Math.floor(r.at / 60000)]));
  }

  // action：park（就这样，收起）/ restore（恢复）/ recommend（按推荐：对那个会话说一句「按你推荐的做」）。
  act({ sessionId, action } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('缺少会话');
    if (!this.a.deps.getSession?.(sessionId) && !this.a.sessions().some(s => s.id === sessionId)) throw new Error('这个会话已经不在 Hub 里了');
    const map = { ...this.parks() };
    if (action === 'park') { map[sessionId] = { ...map[sessionId], at: this.now() }; this.savePark(map); return { ok: true, action }; }
    if (action === 'restore') { map[sessionId] = { restoredAt: this.now() }; this.savePark(map); return { ok: true, action }; }
    if (action === 'recommend') { if (map[sessionId]) { delete map[sessionId]; this.savePark(map); } return { ok: true, action, send: RECOMMEND_TEXT }; }
    throw new Error('不支持的操作');
  }
  // 清掉 7 天前的记录（会话早就不在清单里了）。
  prune() {
    const map = this.parks(), cut = this.now() - 7 * DAY;
    const keep = Object.fromEntries(Object.entries(map).filter(([, v]) => Math.max(Number(v?.at) || 0, Number(v?.restoredAt) || 0) > cut));
    if (Object.keys(keep).length !== Object.keys(map).length) this.a.store.set(STORE_KEY, keep);
  }

  // 状态一眼看：电脑在线（调用方定）、前台模型、前台在用的号的额度，以及全部号的精简读数。
  // 前台会话在用的号：Claude 看 claudeProfile（缺省 default），Codex 看 codexProfile。
  frontAccount() {
    const id = this.a.store.get('sessionId'), s = id ? this.a.deps.getSession?.(id) || this.a.sessionMetadata?.(id) : null;
    const kind = String(s?.kind || '').replace(/-resume$/, '');
    return kind === 'claude' ? { provider: 'claude', profileId: s.claudeProfile || 'default' }
      : kind === 'codex' ? { provider: 'codex', profileId: s.codexProfile || '' }
      : kind === 'gemini' ? { provider: 'antigravity', profileId: s.antigravityProfile || 'default' } : null;
  }
  status() {
    const fa = this.frontAccount();
    const rows = (this.quotaView?.rows || []).map(r => ({ ...r, front: !!fa && r.provider === fa.provider && (r.profileId || '') === fa.profileId }));
    const front = rows.find(r => r.front) || null;
    return { quota: rows.map(r => ({ provider: r.provider, no: r.no, remain5h: r.remain5h ?? null, remain7d: r.remain7d ?? null,
      reset5h: r.reset5h || null, reset7d: r.reset7d || null, front: !!r.front })), quotaAt: this.quotaView?.at || null,
    frontQuota: front ? { provider: front.provider, no: front.no, remain5h: front.remain5h ?? null, remain7d: front.remain7d ?? null } : null };
  }
}

module.exports = { FrontClient, parkState, placeRow, listed, RECOMMEND_TEXT, AUTO_PARK_MS, STORE_KEY };
