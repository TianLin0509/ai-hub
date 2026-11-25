'use strict';
// 移植自公司版（core/company-assistant/hub-tools.js 的 press_keys / stop_session），差别：
//   1. 所有操作都要先 read_screen 拿到画面凭据（screenToken，5 分钟内有效），操作后返回新画面；
//      最近 USER_ACTIVE_MS（10 分钟）内有他亲手输入（键盘敲进终端或在 Hub 输入框发送）就拒绝。
//      取 10 分钟：他回一条消息后常要看几分钟输出再接着打字，5 分钟会在他读输出时误伤；更长则会让无人值守的卡点等太久。
// 换号接力只编排现有机制：挑号（m2 的挑号接口，未就绪时用 accountStatus 的推荐顺序）→ 停下原会话 →
// 现有 requestAccount（换登录 + 接原历史重启）→ 核对会话真在新号上 → 发一句继续。不另写换号、不改任何账号出口。
const crypto = require('node:crypto');

const KEYS = { enter: '\r', esc: '\x1b', up: '\x1b[A', down: '\x1b[B', tab: '\t', space: ' ', y: 'y', n: 'n',
  1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9' };
const PROTECTED_PURPOSES = new Set(['hub-assistant', 'hub-photo-assistant', 'company-assistant', 'company-forum']);
const USER_ACTIVE_MS = 10 * 60_000;
const TOKEN_TTL_MS = 5 * 60_000;
const RELAY_CONTINUE = '继续。你刚才因为额度不足或账号风控被换到了新账号，原对话历史都在：先确认做到了哪一步（有进展卡就先读进展卡），再接着做。';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const baseKind = k => String(k || '').replace(/-resume$/, '');

class SessionControl {
  constructor(deps = {}, options = {}) {
    this.deps = deps;
    this.opts = { userActiveMs: USER_ACTIVE_MS, tokenTtlMs: TOKEN_TTL_MS, keyGapMs: 250, settleMs: 1200, ...options };
    this.tokens = new Map(); // sessionId -> {token, at, hash}
  }
  now() { return this.deps.now ? this.deps.now() : Date.now(); }

  guard(sessionId, { allowUserActive = false } = {}) {
    const s = this.deps.getSession?.(sessionId);
    if (!s) throw new Error('会话没打开或不存在，先用 list_sessions 查编号');
    if (PROTECTED_PURPOSES.has(s.purpose) || this.deps.isAssistantSession?.(sessionId)) throw new Error('这是前台或专用会话，处置工具不能操作它');
    const last = Number(this.deps.lastUserInputAt?.(sessionId)) || 0;
    if (!allowUserActive && last && this.now() - last < this.opts.userActiveMs) {
      throw new Error(`用户 ${Math.ceil((this.now() - last) / 60000)} 分钟前亲手操作过这个会话，${Math.round(this.opts.userActiveMs / 60000)} 分钟内不自动处置；需要的话请他自己点`);
    }
    return s;
  }

  async screen(sessionId) {
    const raw = await Promise.resolve(this.deps.readTerminalScreen?.(sessionId));
    if (!raw) return null;
    let lines;
    try { lines = await require('../hub-phone/session-chat').renderScreen(raw); }
    catch { lines = String(raw.text || '').split('\n').slice(-(raw.rows || 30)); }
    return { lines: Array.isArray(lines) ? lines.map(l => typeof l === 'string' ? l : (l?.text ?? String(l))) : [] };
  }

  async readScreen({ sessionId }) {
    const s = this.guard(sessionId, { allowUserActive: true });
    const view = await this.screen(sessionId);
    const text = view ? view.lines.join('\n') : '';
    const token = crypto.randomBytes(6).toString('hex');
    this.tokens.set(sessionId, { token, at: this.now() });
    const last = Number(this.deps.lastUserInputAt?.(sessionId)) || 0;
    return { sessionId, title: s.title || '', kind: s.kind, status: s.status || null, screen: text.slice(-6000), screenToken: token,
      userActive: !!last && this.now() - last < this.opts.userActiveMs,
      note: '处置前先看清画面；press_keys / stop_session / restart_session / relay_session 都要带这个 screenToken（5 分钟内有效）。' };
  }

  requireToken(sessionId, token) {
    const t = this.tokens.get(sessionId);
    if (!t || !token || t.token !== token) throw new Error('先用 read_screen 看画面，再带上返回的 screenToken 操作');
    if (this.now() - t.at > this.opts.tokenTtlMs) throw new Error('画面凭据已超过 5 分钟，请重新 read_screen 看一眼当前画面');
    this.tokens.delete(sessionId); // 一次凭据只用一次：操作后画面已变，下一步要重新看。
  }

  async after(sessionId, extra) {
    await sleep(this.opts.settleMs);
    const view = await this.screen(sessionId).catch(() => null);
    const token = crypto.randomBytes(6).toString('hex');
    this.tokens.set(sessionId, { token, at: this.now() });
    return { ok: true, sessionId, ...extra, screenAfter: view ? view.lines.join('\n').slice(-6000) : null, screenToken: token };
  }

  async pressKeys({ sessionId, keys, screenToken }) {
    this.guard(sessionId);
    this.requireToken(sessionId, screenToken);
    const list = (Array.isArray(keys) ? keys : [keys]).map(String).filter(Boolean).slice(0, 6);
    if (!list.length || list.some(k => !Object.prototype.hasOwnProperty.call(KEYS, k))) throw new Error('按键只能是 ' + Object.keys(KEYS).join(' / '));
    if (!this.deps.sessionKeys) throw new Error('这台 Hub 不支持终端按键');
    for (const k of list) { this.deps.sessionKeys(sessionId, KEYS[k]); await sleep(this.opts.keyGapMs); }
    return this.after(sessionId, { pressed: list });
  }

  async stopSession({ sessionId, screenToken }) {
    this.guard(sessionId);
    this.requireToken(sessionId, screenToken);
    if (!this.deps.interruptSession) throw new Error('这台 Hub 不支持停止');
    const via = await this.deps.interruptSession(sessionId);
    return this.after(sessionId, { stopped: true, via: via?.via || null, note: '已发送停止（和电脑上按停止键一样）' });
  }

  async restartSession({ sessionId, screenToken }) {
    this.guard(sessionId);
    this.requireToken(sessionId, screenToken);
    if (!this.deps.restartSession) throw new Error('这台 Hub 不支持重启会话');
    await this.deps.restartSession(sessionId);
    const s = this.deps.getSession?.(sessionId);
    if (!s) throw new Error('重启后会话没有回来，请在侧栏看一眼');
    return this.after(sessionId, { restarted: true, note: '已接原历史重启；需要接着干时再用 send_session 发一句继续' });
  }

  // 换号接力。reason：quota（额度不足）或 risk（账号风控）。
  async relaySession({ sessionId, screenToken, reason = 'quota', targetAccount } = {}) {
    const s = this.guard(sessionId);
    this.requireToken(sessionId, screenToken);
    const kind = baseKind(s.kind);
    const family = /^claude/.test(kind) ? 'claude' : kind === 'codex' ? 'codex' : null;
    if (!family) throw new Error('换号接力只支持 Claude 和 Codex 会话');
    const current = family === 'claude' ? s.claudeProfile : s.codexProfile;
    const steps = [];
    // 1 保存进展：有进展卡就记下它的最新快照（路径、修改时间），恢复时让新会话先读它。
    const card = await Promise.resolve(this.deps.progressCardFor?.(s)).catch(() => null);
    steps.push({ step: 'save-progress', ok: true, card: card ? { path: card.path, mtimeMs: card.mtimeMs } : null });
    // 2 挑号：点名优先；否则走挑号接口（m2），未就绪时用账号状态的推荐顺序；排除当前号和风控号。
    const target = targetAccount || await this.pickAccount(family, s, current);
    if (!target) throw new Error('没有可接力的账号：其余号都在风控、额度不足或读数缺失');
    if (target === current) throw new Error('挑出的账号就是当前账号，未接力');
    { const why = this.deps.isRiskFlagged?.(family, target); if (why) throw new Error(`目标账号已标记${typeof why === 'string' ? why : '风控'}，未接力`); }
    steps.push({ step: 'pick', ok: true, target });
    // 3 停下原会话：正在跑的先停，避免换号排队等这一轮结束。
    if (this.deps.isTurnActive?.(sessionId)) {
      await this.deps.interruptSession?.(sessionId);
      steps.push({ step: 'stop', ok: true });
      await sleep(this.opts.settleMs);
    } else steps.push({ step: 'stop', ok: true, note: '本来就没在跑' });
    // 4 复用现有换号：换登录 + 接原历史重启（Claude 走 claudeForkOnResume，Codex 核对原线程编号）。
    if (!this.deps.requestAccount) throw new Error('这台 Hub 没有接上换号接口');
    const switched = await this.deps.requestAccount(family, sessionId, target);
    steps.push({ step: 'switch', ok: !!switched?.ok, status: switched?.status || null, message: switched?.message || null });
    if (!switched?.ok || !['switched', 'unchanged'].includes(switched.status)) {
      return { ok: false, sessionId, steps, error: switched?.message || `换号没有完成（${switched?.status || '无结果'}）` };
    }
    // 5 核对：会话记录里的账号确实是新号（只读本地记录，不向 Anthropic 发任何请求）。
    const after = this.deps.getSession?.(sessionId);
    const now = family === 'claude' ? after?.claudeProfile : after?.codexProfile;
    const verified = now === target;
    steps.push({ step: 'verify', ok: verified, account: now || null });
    if (!verified) return { ok: false, sessionId, steps, error: `换号后会话仍在 ${now || '未知账号'} 上` };
    // 6 恢复：发一句继续（现有手动换号不自动发）。
    const text = RELAY_CONTINUE + (card?.path ? `进展卡：${card.path}` : '');
    const receipt = await this.deps.sendPrompt?.(sessionId, text, `relay-${sessionId}-${this.now()}`);
    steps.push({ step: 'resume', ok: receipt?.ok !== false, sendStatus: receipt?.sendStatus || null });
    this.deps.onRelay?.({ sessionId, from: current, to: target, reason, steps });
    return { ok: receipt?.ok !== false, sessionId, from: current || null, to: target, reason, steps };
  }

  async pickAccount(family, session, current) {
    // m2 的挑号接口（统一派工）：pickAccount({kind, exclude}) -> {id}
    if (this.deps.pickAccount) {
      // m2 的挑号：无号可用返回 {id:null, reason}；全被风控/耗尽时旧版会抛错，两种都按「挑号接口没给号」处理，再退回推荐顺序。
      const r = await Promise.resolve(this.deps.pickAccount({ kind: family, exclude: [current].filter(Boolean), sessionId: session.id })).catch(error => ({ id: null, reason: error.message }));
      if (r?.id) return r.id;
      if (r?.reason) this.lastPickReason = r.reason;
    }
    const status = await Promise.resolve(this.deps.accountStatus?.(family)).catch(() => null);
    const order = status?.order || (status?.recommendedId ? [status.recommendedId] : []);
    return order.find(id => id && id !== current && !this.deps.isRiskFlagged?.(family, id)) || null;
  }
}

function isHumanInput(data) {
  const s = String(data || '');
  if (!s || s.startsWith('\x1b')) return false;
  return /[^\x00-\x1f]/.test(s) || /[\r\n]/.test(s);
}

module.exports = { SessionControl, KEYS, PROTECTED_PURPOSES, USER_ACTIVE_MS, isHumanInput, RELAY_CONTINUE };
