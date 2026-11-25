'use strict';
// 把会话健康、卡点处置、远端监督、主动告警接到前台服务上（service.js 只调用这里的 attach / track / invoke / close）。
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { SessionHealth } = require('./session-health');
const { SessionControl } = require('./session-control');
const { AlertHub } = require('./alerts');
const { RemoteWatch, readLedger, activeFromLedger } = require('./remote-watch');
const { DirectFeed } = require('./direct-feed');
const marks = require('./user-input-marks');

const TOOLS = new Set(['session_health', 'read_screen', 'press_keys', 'stop_session', 'restart_session', 'relay_session', 'ack_alert', 'remote_watch_status']);
const PROGRESS_PROBE_MS = 5 * 60_000;
// 提交编号只能是字母数字、下划线和连字符（hub-memory-service 校验，2026-11-15 E2E 里带冒号的补发编号被拒「提交编号无效」）。
const submissionId = (...parts) => parts.filter(Boolean).join('-').replace(/[^\w-]/g, '-').slice(0, 160);
const ALERT_PROMPT = '【Hub 告警，不是用户原话】下面的异常程序已经自动处置过（补发、重建、改派），仍然救不回，或者没有负责人可交。用一两句话转告用户，说清是哪件事、需要他做什么；不用处理，不用调用任何工具。';
// 直通给负责人或提交作业的会话：它对这件活全权负责，自己处理。
const DIRECT_PROMPT = '【Hub 直通，不是用户原话】下面是你负责的活里程序发现的情况（你的组队成员或你提交的远端作业）。请你自己处理：查原因、补救或重派；处理不了、需要用户定的，在交卷或汇报里写明。处理完没有新结论，就只回 [[hub:no-update]]。';

function gitHeadTime(cwd) {
  return new Promise(resolve => {
    if (!cwd) return resolve(0);
    execFile('git', ['-C', cwd, 'log', '-1', '--format=%ct'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      resolve(error ? 0 : (Number(String(stdout).trim()) || 0) * 1000);
    });
  });
}
function findProgressCard(cwd) {
  if (!cwd) return null;
  let best = null;
  try {
    for (const name of fs.readdirSync(cwd)) {
      if (!/进展卡.*\.md$/i.test(name)) continue;
      const file = path.join(cwd, name), m = fs.statSync(file).mtimeMs;
      if (!best || m > best.mtimeMs) best = { path: file, mtimeMs: m };
    }
  } catch {}
  return best;
}

// 隔离验收可以缩短超时（只认 E2E 实例）：HUB_M3_HEALTH_OPTS='{"deliverMs":20000,"startMs":0}'
function healthOptions() {
  if (process.env.CLAUDE_HUB_E2E !== '1' || !process.env.HUB_M3_HEALTH_OPTS) return {};
  try { return JSON.parse(process.env.HUB_M3_HEALTH_OPTS); } catch { return {}; }
}

const bodyOf = text => String(text).split('\n').slice(1).join(' ').slice(0, 300);

function attach(a) {
  const deps = a.deps;
  const sendPrompt = (...args) => deps.sendPrompt(...args);
  const progressCache = new Map();
  const frontId = () => a.store.get('sessionId');
  const claims = a.claims || null;
  const isBusy = id => { const s = deps.getSession(id); if (!s) return false;
    return !!deps.isAgentTurnActive?.(id) || require('../session-runtime-truth').sessionRuntimeIsActive(s) || ['running', 'waiting'].includes(s.status) || !!deps.hasPendingPrompt?.(id); };

  const direct = new DirectFeed({
    store: a.feedStore || null,
    getSession: id => deps.getSession(id),
    isBusy,
    sendPrompt: (id, text, sub) => sendPrompt(id, text, submissionId(sub)),
    teamNotify: (id, text) => deps.notifyTeamLead?.(id, text) || null,
    onGone: item => alerts.raiseFront({ key: 'direct-gone:' + item.id, sessionIds: [item.sessionId],
      text: `本该直接送给会话 ${item.sessionId.slice(0, 8)}「${deps.getSession(item.sessionId)?.title || ''}」的消息没送到（${deps.getSession(item.sessionId) ? '它一直忙，排队超过 6 小时' : '会话已关'}）：${bodyOf(item.text)}` }),
    onUnconfirmed: item => a.watches?.addNotice?.({ id: 'direct-unconfirmed:' + item.id, title: 'Hub 直通', kind: 'hub-alert', label: '消息可能没送到',
      text: `发给会话 ${item.sessionId.slice(0, 8)}「${deps.getSession(item.sessionId)?.title || ''}」的程序消息送没送到不确定（${item.error}），为免重复没有重发，请点开会话核对：${bodyOf(item.text)}`, sessionIds: [item.sessionId] }),
  });

  // 告警去向（总纲「订阅直通」）：
  //   远端作业带发起会话 → 送那个会话；它关了 → 送它的组队负责人；都没有 → 前台。
  //   前台的负责人自己出事 → 会话健康的告警发出时，补发、重建、改派已经按预算用过；ask 非空说明程序没救回 → 前台（「负责人卡住，程序救不回」）；
  //   没有会话的全局异常（本机资源空着等）和没有发起会话的旧作业账记录 → 照旧前台。
  // 会话健康只跟踪前台派出的会话：升级前派出、还没登记认领的，也按前台的负责人算。
  const ownerOf = id => { const o = claims?.ownerOf(id) ?? null; return o || (health.status(id) ? 'front' : null); };
  function route(item) {
    if (item.deliverTo) {
      if (deps.getSession(item.deliverTo) || deps.isTeamLead?.(item.deliverTo)) return { to: 'session', sid: item.deliverTo };
      const owner = ownerOf(item.deliverTo);
      return owner && owner !== 'front' ? { to: 'session', sid: owner } : { to: 'front' };
    }
    if (!item.sessionId) return { to: 'front' };
    const owner = ownerOf(item.sessionId);
    if (owner && owner !== 'front') return { to: 'session', sid: owner };
    if (owner === 'front' && item.category === 'session-health' && item.ask) return { to: 'front', prefix: '负责人卡住，程序救不回：' };
    return { to: 'user' };
  }

  const alerts = new AlertHub({
    store: a.feedStore || null,
    route,
    sendToSession: async (sid, alert) => direct.deliver(sid, `${DIRECT_PROMPT}\n${alert.text}`, { key: alert.id }),
    sendToFront: async batch => {
      const parts = [];
      if (batch.alertsText) parts.push(`${ALERT_PROMPT}\n\n${batch.alertsText}`);
      if (batch.notesText) parts.push(`【Hub 知会，不是用户原话】以下事项 Hub 已办完、已通知用户，你知道即可，不用回复：\n${batch.notesText}`);
      const r = await a.systemSend({ text: parts.join('\n\n'), requestId: batch.id, relay: !!batch.alertsText });
      return { ok: r?.ok !== false, error: r?.error || null };
    },
    notifyUser: notice => a.watches.addNotice(notice),
  });

  const control = new SessionControl({
    getSession: id => deps.getSession(id),
    isAssistantSession: id => a.isAssistantSession(id) || id === frontId(),
    lastUserInputAt: id => marks.lastAt(id),
    readTerminalScreen: id => deps.readTerminalScreen?.(id),
    sessionKeys: (id, data) => deps.sessionKeys(id, data),
    interruptSession: id => deps.interruptSession(id),
    restartSession: id => deps.restartSession(id),
    isTurnActive: id => !!deps.isAgentTurnActive?.(id),
    isRiskFlagged: (family, id) => deps.isRiskFlagged?.(family, id) || false,
    // m2 统一派工的挑号（service.pickAccount 或 deps.pickAccount），都没有时用账号状态推荐顺序。
    pickAccount: typeof a.pickAccount === 'function' ? options => a.pickAccount(options) : deps.pickAccount,
    accountStatus: family => family === 'claude' ? deps.claudeAccountStatus?.() : null,
    requestAccount: deps.requestAccount,
    sendPrompt,
    progressCardFor: s => findProgressCard(s.cwd),
    onRelay: r => alerts.raise({ key: `relay:${r.sessionId}:${r.to}`, category: 'relay', sessionId: r.sessionId,
      conclusion: `「${deps.getSession(r.sessionId)?.title || r.sessionId.slice(0, 8)}」已从 ${r.from || '原号'} 接力到 ${r.to}`, tried: '已保存进展、停下原会话、换号并发了继续', ask: '' }),
  });
  // Codex 接力挑号：账号列表里可用、不是当前号、没被风控的第一个（额度由现有换号接口在换之前再核一次）。
  const basePick = control.pickAccount.bind(control);
  control.pickAccount = async (family, session, current) => {
    if (family === 'codex' && !deps.pickAccount && typeof a.pickAccount !== 'function' && deps.codexAccountOptions) {
      const opts = deps.codexAccountOptions(session.id);
      const hit = (opts?.accounts || []).find(x => x.available && !x.current && x.id !== current && !deps.isRiskFlagged?.('codex', x.id));
      return hit?.id || null;
    }
    return basePick(family, session, current);
  };

  // 重建 / 改派：关掉原会话，按原路由（改派时按挑号规则换号）新开，再用同一个 operationKey 交代任务。
  async function rebuild(entry, { pick }) {
    const route = entry.dispatch?.route;
    if (entry.dispatch?.type !== 'create' || !route) return { ok: false, error: '追加给原会话的任务不改派，原会话保留' };
    // 都不关不换，返回 blocked，由会话健康只告警。
    const blockedReason = () => {
      try { control.guard(entry.sessionId); } catch (error) { return error.message; }
      if (deps.isAgentTurnActive?.(entry.sessionId)) return '会话正有回合在跑，可能已经开工，没有关掉它';
      return null;
    };
    const early = blockedReason();
    if (early) return { ok: false, blocked: true, error: early };
    const opts = { ...route.opts };
    let account = null;
    if (pick) {
      const family = /^claude/.test(route.kind) ? 'claude' : route.kind === 'codex' ? 'codex' : /^gemini/.test(route.kind) ? 'gemini' : null;
      const curSession = deps.getSession(entry.sessionId);
      const current = family === 'claude' ? curSession?.claudeProfile : family === 'codex' ? curSession?.codexProfile : family === 'gemini' ? (curSession?.antigravityProfile || 'default') : null;
      if (family) account = await control.pickAccount(family, { id: entry.sessionId }, current).catch(() => null);
      if (account) opts[family === 'claude' ? 'claudeProfile' : family === 'codex' ? 'codexProfile' : 'antigravityProfile'] = account;
    }
    const late = blockedReason();
    if (late) return { ok: false, blocked: true, error: late };
    try { await deps.closeSession?.(entry.sessionId); } catch (error) { console.warn('[session-health] close', error.message); }
    const id = require('node:crypto').randomUUID();
    const session = await deps.createSession(route.kind, { ...opts, id, title: entry.title, purpose: 'hub-assistant-task', openInBackground: true, noInheritCursor: true });
    const wire = require('./delegated-prompt').encodeDelegatedPrompt(entry.text, session.kind);
    const receipt = await sendPrompt(session.id, wire, submissionId(entry.operationKey || entry.sessionId, pick ? 'redispatch' : 'rebuild'));
    a.followTask?.({ sessionId: session.id });
    // 认领跟着任务走：新会话接任负责人，旧会话已关，撤掉旧登记。
    try { if (claims?.isFrontLead(entry.sessionId)) { claims.claim(session.id, { title: entry.title, by: 'dispatch' }); claims.release(entry.sessionId); } } catch (error) { console.warn('[claims] rebuild', error.message); }
    return { ok: true, sessionId: session.id, kind: session.kind, account, receipt: receipt?.sendStatus || null };
  }

  const health = new SessionHealth({
    stateFile: path.join(deps.dataDir, 'assistant', 'session-health.json'),
    getSession: id => deps.getSession(id),
    isReady: id => !!deps.isCliReady?.(id),
    // 补发走同一个提交入口；同一 operationKey，提交编号加后缀，避免被当成重复提交吞掉。
    resubmit: async entry => {
      const s = deps.getSession(entry.sessionId);
      const wire = require('./delegated-prompt').encodeDelegatedPrompt(entry.text, s?.kind);
      return sendPrompt(entry.sessionId, wire, submissionId(entry.operationKey || entry.sessionId, 'resend1'));
    },
    recreate: entry => rebuild(entry, { pick: false }),
    redispatch: entry => rebuild(entry, { pick: true }),
    probeProgress: async (entry, meta) => {
      const cached = progressCache.get(entry.sessionId);
      if (cached && Date.now() - cached.at < PROGRESS_PROBE_MS) return cached.value;
      const cwd = meta?.cwd || entry.cwd;
      const value = Math.max(await gitHeadTime(cwd), findProgressCard(cwd)?.mtimeMs || 0);
      progressCache.set(entry.sessionId, { at: Date.now(), value });
      return value;
    },
    readScreen: async id => { const raw = deps.readTerminalScreen?.(id); return raw ? { text: String(raw.text || '').slice(-4000) } : null; },
    isTurnActive: id => !!deps.isAgentTurnActive?.(id),
    alert: item => alerts.raise(item),
    onChange: snap => deps.onSessionHealth?.(snap),
  }, healthOptions());

  // 已报过「完成」的作业，落盘防 Hub 重启后重复报。
  // 已查到失败或取消的作业同样落盘（remote-closed.json），重启后交卷判断仍不把它们算「还在跑」。
  const seenFile = name => {
    const file = path.join(deps.dataDir, 'assistant', name);
    let set = null;
    const load = () => { if (!set) { try { set = new Set(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { set = new Set(); } } return set; };
    return { has: k => load().has(k), add: k => { const s = load(); if (s.has(k)) return; s.add(k);
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); require('../atomic-write').writeFileAtomic(fs, file, JSON.stringify([...s].slice(-500))); } catch (error) { console.warn('[remote-watch]', name, error.message); } } };
  };
  const doneSeen = seenFile('remote-done.json'), closedSeen = seenFile('remote-closed.json');
  const remote = new RemoteWatch({
    readLedger: deps.remoteLedger, machineSlots: deps.machineSlots, query: deps.remoteQuery || {},
    alert: item => alerts.raise(item),
    onJobDone: item => {
      const key = `remote-done:${item.backend}:${item.ticket}`, text = `${DIRECT_PROMPT}\n${item.text}`;
      let r = direct.deliver(item.sessionId, text, { key });
      if (r.ok) return r;
      const to = route({ deliverTo: item.sessionId });
      if (to.to === 'session' && to.sid !== item.sessionId) {
        r = direct.deliver(to.sid, `${text}\n（提交它的会话 ${item.sessionId.slice(0, 8)} 已关，转给你）`, { key });
        if (r.ok) return r;
      }
      const front = alerts.raiseFront({ key, sessionIds: [item.sessionId], text: `${item.text}（提交它的会话 ${item.sessionId.slice(0, 8)} 已关，没人接着干）` });
      return { ok: true, via: 'front', front };
    },
    doneSeen, closedSeen,
  });

  // 交卷判断用（handoff-feed）：这个会话提交、还可能在跑的远端作业票数（口径见 RemoteWatch.ticketOpen）。
  // 作业账读不到按 0 算（不挡交卷）。
  function remoteOpenFor(sessionId) {
    if (!sessionId) return 0;
    let rows = [];
        try { rows = deps.remoteLedger ? deps.remoteLedger() : readLedger(remote.opts.ledgerFile || require('path').join(require('os').homedir(), '.ai-hub-remote-jobs.jsonl')); } catch { rows = []; }
    if (!Array.isArray(rows)) return 0; // 异步的作业账读取器不在这里等
    let n = 0;
    for (const [backend, tickets] of activeFromLedger(rows, Date.now(), remote.opts.activeWindowMs)) {
      for (const t of tickets) {
        if (t.hubSession === sessionId && remote.ticketOpen(backend, t, k => doneSeen.has(k))) n += 1;
      }
    }
    return n;
  }

  if (!deps.noHealthTimer) {
    health.start();
    if (deps.remoteQuery || deps.machineSlots) remote.start();
  }

  async function invoke(name, args, ctx) {
    if (!ctx.isFront) throw new Error('只有前台会话能用会话处置工具');
    if (name === 'session_health') return args.sessionId ? (health.status(args.sessionId) || { error: '这个会话不在健康跟踪里（只跟踪前台派出的会话）' }) : { sessions: health.list().slice(-30), pendingAlerts: alerts.pending() };
    if (name === 'read_screen') return control.readScreen(args);
    if (name === 'press_keys') return control.pressKeys(args);
    if (name === 'stop_session') return control.stopSession(args);
    if (name === 'restart_session') return control.restartSession(args);
    if (name === 'relay_session') return control.relaySession(args);
    if (name === 'ack_alert') return alerts.ack(args);
    if (name === 'remote_watch_status') return { last: remote.history.slice(-1)[0] || null };
    throw new Error('未知工具');
  }

  // 前台派工后登记。action 是 service.execute 的动作；result 是派工结果。
  function track(action, result, route) {
    if (!result?.sessionId || typeof action.text !== 'string') return null;
    const s = deps.getSession(result.sessionId);
    // 前台派出（新开或追加）即登记为负责人（总纲接口合同：create_session / send_session 自动 claim）。
    try { claims?.claim(result.sessionId, { title: s?.title || action.title || '', by: 'dispatch' }); } catch (error) { console.warn('[claims] track', error.message); }
    try {
      return health.track({ sessionId: result.sessionId, kind: s?.kind || route?.kind, title: s?.title || action.title || '', text: action.text,
        operationKey: action.requestId, cwd: s?.cwd || null, produceMs: action.produceMs, startedAt: action.dispatchStartedAt,
        dispatch: { type: action.type, route: route ? { kind: route.kind, opts: route.opts } : null } });
    } catch (error) { console.warn('[session-health] track', error.message); return null; }
  }

  function close() { health.stop(); remote.stop(); direct.close(); }
  return { health, control, alerts, remote, direct, route, invoke, track, close, remoteOpenFor, TOOLS };
}

module.exports = { attach, TOOLS, findProgressCard, ALERT_PROMPT, DIRECT_PROMPT, submissionId };
