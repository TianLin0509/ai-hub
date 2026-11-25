'use strict';
// 把前台才有的会话能力开放给任意 Hub 会话：列会话、建会话（点名模型/账号）、跨会话发话（忙时排队）、读进展、等回复。
// 执行全部复用前台的 AssistantService：建会话走开工排队 dispatchQueue → execute()，发话走 execute()，两者同写派工账本。
// 本模块只加三样前台没有的东西：调用方身份与发送方标记、防繁殖护栏、忙时排队与回调方的「等回复」。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULTS = Object.freeze({ maxDepth: 2, createsPerHour: 8 });
const HOUR = 3600 * 1000;
const QUEUE_TTL_MS = 24 * HOUR;
const WATCH_TTL_MS = 24 * HOUR;
const TICK_MS = 5000;
const ADOPT_MAX_TRIES = 60; // 约 5 分钟：Hub 重启后会话恢复需要时间，过后仍查不到就不再挂（下次启动再试）
const REPLY_HEAD = 800;
// 前台之外的 Hub 内部会话：拍图助理、造梦、旧领域助理等。前台本身经它的告警队列送达。
const INTERNAL_PURPOSE = /^(hub-(?!assistant-task$)|memory-dream|daily-)/;
const FRONT_ALIASES = new Set(['front', '前台', 'assistant', '助理']);

const short = id => String(id || '').slice(0, 8);
const oneLine = (t, n = 60) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
const hash = text => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 24);

function senderTag(caller) {
  return `【来自会话 ${oneLine(caller?.title || caller?.name || '未命名会话', 40)}（${short(caller?.id)}）】`;
}
function tagMessage(caller, message) {
  return `${senderTag(caller)}这条消息由另一个 Hub 会话经 hub 命令发来，不是用户本人。回复对方用 hub session send --to ${short(caller?.id)} --message "…"。\n\n${message}`;
}

function createHubCliService({ assistant, team = null, dataDir, getConfig = () => ({}), now = Date.now, tickMs = TICK_MS, logger = console, isAgentTurnActive = null,
  setTimer = (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; }, clearTimer = t => clearInterval(t) } = {}) {
  if (!assistant) throw Error('hub 命令依赖前台服务');
  const file = path.join(dataDir, 'hub-cli', 'state.json');
  let state = null, timer = null, ticking = false;
  // 只在内存里的运行时标记，绝不落盘（审查 P2-4：sending 落盘后重启，队列永久卡住）。
  const sending = new Set(), inflight = new Set();
  // 同一预留正被几个请求处理（复审 m7 新 P1）：只有最后一个处理者、且确定没执行时才退名额删谱系。
  const holders = new Map();
  const hold = rid => holders.set(rid, (holders.get(rid) || 0) + 1);
  const unhold = rid => { const n = (holders.get(rid) || 1) - 1; if (n > 0) holders.set(rid, n); else holders.delete(rid); return n; };

  function load() {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = {}; }
    state.lineage ||= {}; state.creates ||= {}; state.outbox ||= []; state.watches ||= [];
    // 旧版本落过盘的 sending 标记：清掉，按发送账本对账（deliver 用同一 requestId，账本有记录就回原结果、不重发）。
    for (const x of state.outbox) delete x.sending;
    return state;
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, (k, v) => k === 'sending' ? undefined : v, 1), 'utf8');
    fs.renameSync(tmp, file);
  }
  function limits() {
    const c = getConfig()?.hubCli || {};
    const n = (v, d) => Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.floor(Number(v)) : d;
    return { maxDepth: n(c.maxDepth, DEFAULTS.maxDepth), createsPerHour: n(c.createsPerHour, DEFAULTS.createsPerHour) };
  }

  // ---- 会话查找 ----
  const meta = id => assistant.sessionMetadata(id);
  const isFront = id => assistant.assistantIds().includes(id) || meta(id)?.purpose === 'hub-assistant';
  function caller(sid) {
    const m = meta(sid);
    if (!m) throw Error('调用方会话不在 Hub 记录里');
    return { ...m, id: sid };
  }
  function resolveTarget(ref) {
    const key = String(ref || '').trim();
    if (!key) throw Error('请用 --to 写目标会话编号或唯一标题');
    if (FRONT_ALIASES.has(key.toLowerCase())) return { front: true, id: 'front', title: '前台' };
    const all = assistant.sessions();
    const exact = all.find(s => s.id === key);
    if (exact) return exact;
    const byPrefix = key.length >= 6 ? all.filter(s => s.id.startsWith(key)) : [];
    if (byPrefix.length === 1) return byPrefix[0];
    const byTitle = all.filter(s => String(s.title || s.name || '').trim() === key);
    if (byTitle.length === 1) return byTitle[0];
    const fuzzy = byTitle.length ? byTitle : all.filter(s => String(s.title || s.name || '').includes(key));
    if (fuzzy.length === 1 && !byPrefix.length) return fuzzy[0];
    const hits = byPrefix.length ? byPrefix : fuzzy;
    if (!hits.length) {
      if (isFront(key)) return { front: true, id: 'front', title: '前台' };
      throw Error(`找不到会话「${key}」；先用 hub sessions --query 关键词 找编号`);
    }
    throw Error(`「${key}」命中 ${hits.length} 个会话，请写编号：` + hits.slice(0, 8).map(s => `${short(s.id)} ${oneLine(s.title || s.name, 24)}`).join('；'));
  }

  // ---- 防繁殖 ----
  // 层数以落盘谱系为准（建会话、招成员时同步登记，离队休眠不消失）；没登记的老成员按组队关系推导，含已离队的（审查 P1-3）。
  function teamLeadOf(sid) {
    const live = team?.teamOfMember?.(sid)?.team?.leadSid;
    if (live) return live;
    try { for (const t of team?.listTeams?.() || []) if ((t.members || []).some(m => m.sid === sid)) return t.leadSid; } catch {}
    return null;
  }
  function depthOf(sid, seen = new Set()) {
    if (!sid || seen.has(sid)) return 0;
    seen.add(sid);
    const rec = load().lineage[sid];
    if (rec) return rec.depth;
    const lead = teamLeadOf(sid);
    return lead && lead !== sid ? depthOf(lead, seen) + 1 : 0;
  }
  const stamp = x => typeof x === 'number' ? x : Number(x?.at) || 0;
  function recentCreates(sid) { const t = now(); return (load().creates[sid] || []).filter(x => t - stamp(x) < HOUR); }
  function checkDepth(sid) {
    const { maxDepth } = limits();
    const depth = depthOf(sid);
    if (depth >= maxDepth) throw Error(`防繁殖：你这个会话已是第 ${depth} 层（由会话 ${short(load().lineage[sid]?.parent || teamLeadOf(sid))} 派生），最多到第 ${maxDepth} 层，不能再建会话或招人。需要更多人手请向派你的会话或用户说明「Hub 缺 X」，由上层来建`);
    return depth;
  }
  function checkQuota(sid) {
    const { createsPerHour } = limits(), recent = recentCreates(sid);
    if (recent.length >= createsPerHour) {
      const wait = Math.max(1, Math.ceil((Math.min(...recent.map(stamp)) + HOUR - now()) / 60000));
      throw Error(`防繁殖：本会话一小时内已建 ${recent.length} 个会话（上限 ${createsPerHour}，config hubCli.createsPerHour 可调；按调用方各自计数，整棵树靠层数封顶），还要等约 ${wait} 分钟才能再建`);
    }
  }
  // 同步预留（审查 P1-1/P1-2）：校验层数和名额、定下子会话编号、扣名额、登记谱系、落盘，全部在第一个 await 之前完成。
  // 并发请求依次看到已扣的名额；子会话还没启动、首条任务还没发，谱系就已在盘上。确定没执行再 release 退还。
  function reserveChild(parentSid, { requestId = null, via = 'hub', quota = true, payload = null } = {}) {
    const depth = checkDepth(parentSid);
    if (quota) checkQuota(parentSid);
    const s = load(), childId = crypto.randomUUID(), at = now();
    if (quota) s.creates[parentSid] = [...recentCreates(parentSid), { at, requestId, childId }];
    s.lineage[childId] = { parent: parentSid, depth: depth + 1, at, via, ...(requestId ? { requestId, pending: true } : {}), ...(payload ? { payload } : {}) };
    save();
    return { id: childId, depth: depth + 1, release: () => releaseChild(parentSid, childId) };
  }
  function releaseChild(parentSid, childId) {
    const s = load();
    delete s.lineage[childId];
    if (s.creates[parentSid]) s.creates[parentSid] = s.creates[parentSid].filter(x => x?.childId !== childId);
    s.watches = s.watches.filter(w => w.target !== childId);
    save();
  }
  // 组队招人走同一护栏（审查 P1-3）：所有负责人都受层数限制；hub 派生的负责人（第 1 层起）每招一人也扣它的小时名额。
  const teamGuard = {
    checkDepth: leadSid => checkDepth(leadSid),
    reserveMember: leadSid => reserveChild(leadSid, { via: 'team', quota: depthOf(leadSid) >= 1 }),
  };
  try { team?.setLineageGuard?.(teamGuard); } catch (error) { logger.warn?.('[hub-cli] team guard', error.message); }

  // ---- 列会话 ----
  function sessions({ query = '', status = '', all = false } = {}) {
    const teams = (() => { try { return team?.listTeams?.() || []; } catch { return []; } })();
    const leads = new Set(teams.map(t => t.leadSid)), members = new Map();
    for (const t of teams) for (const m of t.members || []) if (m.sid) members.set(m.sid, m.memberId);
    const word = s => require('../hub-assistant/slim').stateWord(s);
    const statusKey = { running: '在办', busy: '在办', waiting: '等你', idle: '空闲', closed: '已关', dormant: '已关', error: '出错' };
    let rows = assistant.sessions().filter(s => !INTERNAL_PURPOSE.test(String(s.purpose || '')));
    if (query) { const k = String(query).toLowerCase(); rows = rows.filter(s => [s.id, s.title, s.name, s.kind, s.cwd, s.model].some(v => String(v || '').toLowerCase().includes(k))); }
    if (status) { const want = statusKey[String(status).toLowerCase()] || String(status); rows = rows.filter(s => word(s).startsWith(want)); }
    const last = s => Number(s.lastMessageTime || s.lastCompletedAt || s.updatedAt || s.createdAt || 0);
    if (!all && !query && !status) rows = rows.filter(s => s.isOpen || now() - last(s) < 48 * HOUR);
    rows.sort((a, b) => last(b) - last(a));
    const total = rows.length;
    rows = rows.slice(0, all ? 200 : 60);
    const lineage = load().lineage;
    return { total, shown: rows.length, note: total > rows.length ? '只列了最近的，用 --query 或 --all 看更多' : undefined,
      front: '给前台发话：hub session send --to front',
      sessions: rows.map(s => ({ id: s.id, title: oneLine(s.title || s.name, 40), kind: s.kind, model: require('../session-capabilities').sessionModelId(s) || s.model || null,
        status: word(s), cwd: s.cwd || null, role: leads.has(s.id) ? '负责人' : members.has(s.id) ? '成员 ' + members.get(s.id) : undefined,
        ...(lineage[s.id] ? { createdBy: short(lineage[s.id].parent), depth: lineage[s.id].depth } : {}) })) };
  }

  // ---- 建会话 ----
  const findReservation = (sid, requestId) => Object.entries(load().lineage).find(([, r]) => r.requestId === requestId && r.parent === sid) || null;
  const queued = rid => { const q = assistant.dispatchQueue; return !!(q?.running?.has?.(rid) || q?.jobs?.some?.(j => j.id === rid)); };
  async function sessionNew(sid, args) {
    const me = caller(sid);
    const task = String(args.task || '').trim();
    if (!task) throw Error('请用 --task 或 --task-file 写清任务');
    // 不写 --cwd 时继承调用方会话的工作目录（m5 实测：原先落到 Hub 默认目录）；调用方目录已不存在才用 Hub 默认。
    if ((args.cwd === undefined || args.cwd === '') && me.cwd && path.isAbsolute(String(me.cwd)) && fs.existsSync(String(me.cwd))) args = { ...args, cwd: String(me.cwd) };
    if (task.length > 50000) throw Error('任务书超过 5 万字');
    // antigravity / agy 是 gemini 的口头叫法（2026-11-23），入口处归一。
    const kinds = require('../ai-kinds'), kind = kinds.resolveKindAlias(args.kind);
    const homeKinds = kinds.ALL_AI_KINDS.filter(k => k !== 'codeagent');
    if (!kind) throw Error('请用 --kind 指定后端（claude / codex / gemini(antigravity) …；hub models 看可选）');
    if (kind === 'codeagent') throw Error(`这个版本不提供 codeagent；可选：${homeKinds.join(' / ')}`);
    if (!kinds.ALL_AI_KINDS.includes(kind)) throw Error(`没有后端「${kind}」；可选：${homeKinds.join(' / ')}（antigravity / agy 等同 gemini）`);
    const opKey = String(args.operationKey || crypto.randomUUID());
    const requestId = 'hub-new-' + hash(sid + '\n' + opKey);
    const action = { type: 'create', requestId, kind, title: String(args.title || oneLine(task, 30) || 'hub 新建会话').slice(0, 100), text: task,
      ...Object.fromEntries(['model', 'effort', 'account', 'cwd', 'scene'].filter(k => args[k] !== undefined && args[k] !== '').map(k => [k, String(args[k])])) };
    // 幂等先于名额（审查 P2-1）：同 key 重试先找原预留，命中就回原结果，不再扣名额、不被上限拦。
    // 预留绑定任务内容（复审 m7 新 P1）：同一个 key 换了内容当场拒绝，不让一份错误参数的请求「代表」另一份去退额删谱系。
    const payload = hash(JSON.stringify({ ...action, requestId: undefined }));
    const existing = findReservation(sid, requestId);
    if (existing && existing[1].payload && existing[1].payload !== payload) throw Error('这个 operationKey 已用于另一份任务；换一个 key，或按原任务原样重试');
    let childId, depth;
    if (existing) { childId = existing[0]; depth = existing[1].depth; }
    else ({ id: childId, depth } = reserveChild(sid, { requestId, payload }));
    // 退还只在「没有别的请求在处理这份预留、也没进账本和开工排队」时做。
    const releaseIfSole = () => { if (!holders.get(requestId) && !assistant.store.has(requestId) && !queued(requestId)) releaseChild(sid, childId); };
    // 关注在首条任务发出前建好（审查 P2-2）：新会话没有历史，游标从头读，快速回复不会被当成旧回复吞掉。
    // 重试时也从头读：子会话的历史全是这次任务的，已交卷就把最新一条送回，不当旧回复跳过。
    if (args.watch) { addWatch(sid, childId, { fresh: true }); save(); }
    // desiredSessionId：用预留的编号建会话；frontOwned=false：不登记为前台负责人、不进前台健康处置（审查 P2-5）。
    const options = { issuerSessionId: sid, plainTask: true, taskPurpose: null, desiredSessionId: childId, frontOwned: false };
    inflight.add(requestId); hold(requestId);
    let result;
    let preflightError = null;
    try {
      if (!existing) {
        // 与前台 create_session 同样的预检：型号、深度、场景、账号、目录写错当场报错，并退还刚预留的名额。
        try {
          const profiles = require('../hub-assistant/profiles'), dispatch = require('../hub-assistant/dispatch');
          const route = profiles.resolveTask(action, await assistant.deps.getDefaults?.(kind) || {});
          assistant.validateTaskScene(action.scene, kind, route.opts);
          dispatch.launchOptions(kind, action, assistant.dispatchAccounts());
        } catch (error) { preflightError = error; }
      }
      if (preflightError) throw preflightError;
      // 新任务走前台同一条开工排队（同时启动数有上限）；已入账的重试回账本结果；排队、开工中的重试回原排队回执。
      result = assistant.store.has(requestId) ? await assistant.execute(action, options) : await assistant.dispatchQueue.submit({ id: requestId, action, options });
    } catch (error) {
      if (unhold(requestId) === 0) { inflight.delete(requestId); if (preflightError) releaseIfSole(); }
      throw error;
    }
    if (unhold(requestId) === 0) inflight.delete(requestId);
    // 没进账本、也不在开工排队的失败 = 确定没执行（execute 落账前就拒绝了）：退还名额、撤销谱系。
    if (result?.ok === false && !assistant.store.has(requestId) && !queued(requestId)) {
      releaseIfSole();
      return { ok: false, state: 'rejected', error: result.error || '没建成', operationKey: opKey, note: '没建成，名额已退还' };
    }
    settleReservations();
    save(); arm();
    const newId = assistant.store.get?.('reserved:' + requestId) || result?.sessionId || null;
    // 兜底：实际建出的编号与预留不一致（不应发生），谱系改记到实际编号，层数护栏不失效。
    if (newId && newId !== childId && load().lineage[childId]) {
      const s = load(); s.lineage[newId] = s.lineage[childId]; delete s.lineage[childId];
      for (const w of s.watches) if (w.target === childId) w.target = newId;
      for (const c of s.creates[sid] || []) if (c?.childId === childId) c.childId = newId;
      logger.warn?.('[hub-cli] 预留编号未生效，已改记到实际会话', short(childId), '→', short(newId)); save();
    }
    if (adoptChildren()) save();
    const rt = result?.runtime || {};
    // 会话已建成、首条任务送达暂未确认（Antigravity 等没有即时提交回执的后端常见，确认随后由 hook 补记）：
    // 报建成并说明，不让调用方以为没建成而重试（m5 实测 P2：agy 原生记录里任务和回复都在，回执却是 ok:false）。
    const createdUnconfirmed = result?.state === 'unknown' && !!newId && !!assistant.deps.getSession(newId) && !result?.error;
    if (createdUnconfirmed) return { ok: true, state: 'created-unconfirmed', sessionId: newId, operationKey: opKey, ...(existing ? { duplicate: true } : {}),
      actual: { kind: rt.kind || kind, model: rt.model || null, effort: rt.effort || null, account: rt.account || null, cwd: rt.cwd || null },
      accountReason: result?.dispatch?.reason, depth,
      note: `会话已建成、在侧栏可见；首条任务已发出，送达确认还没回来。别重试，用 hub session read --id ${newId} 看它是否开工${args.watch ? '；它回复后摘要会送回你这个会话' : ''}。` };
    return { ok: result?.ok !== false, state: result?.state || null, sessionId: newId || childId, operationKey: opKey, ...(existing ? { duplicate: true } : {}),
      actual: newId ? { kind: rt.kind || kind, model: rt.model || null, effort: rt.effort || null, account: rt.account || null, cwd: rt.cwd || null } : undefined,
      accountReason: result?.dispatch?.reason, summary: result?.summary, error: result?.error, depth,
      note: (result?.state === 'queued' ? '开工排队中，轮到会自动启动（编号已定）；' : '') + `新会话在侧栏可见。${args.watch ? '它回复后摘要会送回你这个会话。' : '要等它回复可用 hub session send --to <编号> --watch 或 hub session read'}。结果不明时用同一个 --key ${opKey} 重试，不会重复建` };
  }
  // 建成后立即挂；排队开工的、Hub 重启后的老谱系（补挂已散落的）由后台推进补上。会话暂时查不到时最多重试 ADOPT_MAX_TRIES 次。
  const adoptTries = new Map();
  const adoptable = (id, rec) => rec?.via === 'hub' && !rec.pending && !rec.adopted && !id.startsWith('pending:') && (adoptTries.get(id) || 0) < ADOPT_MAX_TRIES;
  function adoptChildren() {
    if (typeof team?.adoptHubChild !== 'function') return false;
    let changed = false;
    const lineage = load().lineage;
    // 由浅到深：父会话先挂好，孙会话才能跟着挂到同一负责人。父会话还在等首条回执（pending）或还没挂上时先不挂孙会话，
    // 否则孙会话会把父会话变成临时负责人，父会话之后永久挂不回原项目（Codex 审查 P2）。
    for (const [id, rec] of Object.entries(lineage).sort((a, b) => (a[1]?.depth || 0) - (b[1]?.depth || 0))) {
      if (!adoptable(id, rec)) continue;
      const up = lineage[rec.parent];
      if (up?.via === 'hub' && !up.adopted && (up.pending || adoptable(rec.parent, up))) continue;
      let r;
      try { r = team.adoptHubChild({ parentSid: rec.parent, sessionId: id }); }
      catch (error) { r = { ok: false, reason: error.message }; }
      if (r?.final) { rec.adopted = r.ok ? (r.leadSid || true) : 'skip:' + (r.reason || '?'); adoptTries.delete(id); changed = true; }
      else adoptTries.set(id, (adoptTries.get(id) || 0) + 1);
    }
    return changed;
  }
  // 预留对账：进了账本的转正；不在账本、不在开工排队、本进程也没在处理的，说明确定没执行（排队开工前被拒、重启前没提交），退还。
  // 旧版本留下的 pending:<requestId> 谱系按账本里的预留编号迁移（审查 P2-6）。
  function settleReservations() {
    const s = load();
    let changed = false;
    for (const [key, rec] of Object.entries(s.lineage)) {
      if (key.startsWith('pending:')) {
        const id = assistant.store.get?.('reserved:' + rec.requestId);
        if (id) {
          const { pending, ...kept } = rec; s.lineage[id] = kept; delete s.lineage[key]; changed = true;
          for (const w of (s.pendingWatch || []).filter(w => w.requestId === rec.requestId)) addWatch(w.caller, id, { fresh: true });
          s.pendingWatch = (s.pendingWatch || []).filter(w => w.requestId !== rec.requestId);
        } else if (now() - rec.at > QUEUE_TTL_MS) { delete s.lineage[key]; changed = true; }
        continue;
      }
      if (!rec.pending || inflight.has(rec.requestId)) continue;
      if (assistant.store.has(rec.requestId)) { delete rec.pending; changed = true; }
      else if (!queued(rec.requestId)) { releaseChild(rec.parent, key); changed = true; }
    }
    return changed;
  }

  // ---- 发话 ----
  function busy(target) {
    const live = assistant.deps.getSession(target.id);
    if (!live) return false;
    // PTY 会话在工具执行中 status 仍可能是 idle：以 hook 记的回合进行中为准（m5 实测：90 秒命令跑着，消息 13 秒就打了进去）。
    try { if (typeof isAgentTurnActive === 'function' && isAgentTurnActive(target.id)) return true; } catch {}
    return require('../session-runtime-truth').sessionRuntimeIsActive(live) || ['running', 'waiting'].includes(live.status);
  }
  async function sessionSend(sid, args) {
    const me = caller(sid);
    const message = String(args.message || '');
    if (!message.trim()) throw Error('请用 --message 或 --message-file 写消息');
    if (message.length > 50000) throw Error('消息超过 5 万字');
    const target = resolveTarget(args.to);
    if (!target.front && target.id === sid) throw Error('不能给自己发消息');
    if (target.front && isFront(sid)) throw Error('不能给自己发消息');
    if (!target.front) {
      if (INTERNAL_PURPOSE.test(String(target.purpose || ''))) throw Error('这是 Hub 内部会话，不接受 hub 消息');
      if (!require('../ai-kinds').ALL_AI_KINDS.includes(String(target.kind || '').replace(/-resume$/, ''))) throw Error('目标不是 AI 会话（终端等不收消息）');
    }
    const opKey = String(args.operationKey || crypto.randomUUID());
    const id = 'hub-send-' + hash(sid + '\n' + opKey);
    const text = tagMessage(me, message);
    const s = load();
    const old = s.outbox.find(x => x.id === id);
    if (old) return view(old);
    if (target.front) {
      const alerts = assistant.care?.alerts;
      if (!alerts?.raiseFront) throw Error('前台消息队列不可用（会话健康模块没启动）');
      alerts.raiseFront({ key: id, text, sessionIds: [sid] });
      const item = { id, from: sid, to: 'front', toTitle: '前台', at: now(), state: 'queued-front', deliveredAt: null };
      s.outbox.push(item); trim(); save();
      return { ...view(item), note: '已进前台消息队列，前台空闲时送达（不打断用户）' };
    }
    const item = { id, from: sid, to: target.id, toTitle: oneLine(target.title || target.name, 40), text, at: now(), state: 'queued', watch: !!args.watch };
    s.outbox.push(item); save();
    if (args.watch) addWatch(sid, target.id);
    await deliver(item);
    trim(); save(); arm();
    return { ...view(item), note: item.state === 'queued' ? '目标正忙，已排队；它空闲后自动送达，不打断它' + (args.watch ? '；它回复后摘要会送回你' : '') : undefined };
  }
  function view(item) {
    return { ok: !['failed', 'expired'].includes(item.state), messageId: item.id, to: item.to, toTitle: item.toTitle, state: item.state,
      ...(item.deliveredAt ? { deliveredAt: new Date(item.deliveredAt).toISOString() } : {}), ...(item.error ? { error: item.error } : {}) };
  }
  const targetBusy = e => e?.code === 'target-busy' || /(正在|仍在)运行或等待输入/.test(String(e?.message || e || ''));
  async function deliver(item) {
    if (item.state !== 'queued' || sending.has(item.id)) return;
    if (now() - item.at > QUEUE_TTL_MS) { item.state = 'expired'; item.error = '目标 24 小时内一直忙，消息未送出'; notifyFailure(item); return; }
    const target = meta(item.to);
    if (!target) { item.state = 'failed'; item.error = '目标会话已不存在'; notifyFailure(item); return; }
    if (busy({ id: item.to })) return;
    sending.add(item.id);
    try {
      const r = await assistant.execute({ type: 'send', requestId: item.id, targetSessionId: item.to, text: item.text }, { issuerSessionId: item.from, plainTask: true, frontOwned: false });
      if (r?.ok) { item.state = 'delivered'; item.deliveredAt = now(); delete item.text; }
      else {
        // 已落账但没确认送达：标「结果不明」并提示核对，不盲目重发。
        item.state = r?.duplicate && r.state === 'acknowledged' ? 'delivered' : r?.duplicate || r?.state === 'unknown' ? 'unknown' : 'failed';
        item.error = r?.error || (item.state === 'unknown' ? '送达未确认，请用 hub session read 核对对方是否收到' : null);
        if (item.state !== 'delivered') notifyFailure(item);
      }
    } catch (error) {
      // 忙（含休眠目标恢复后仍忙，审查 P2-3）：execute 在落账前就拒绝，确定没发，留在队里等空闲再送。
      if (targetBusy(error)) { /* 留在队里 */ }
      else { item.state = 'failed'; item.error = error.message; notifyFailure(item); }
    } finally { sending.delete(item.id); }
  }
  // 系统通知只回给发送方一次；通知本身失败不再通知（防循环）。
  function notifyFailure(item) {
    if (item.system) return;
    const s = load();
    s.outbox.push({ id: 'hub-note-' + hash(item.id + ':fail'), from: 'hub', to: item.from, toTitle: '', system: true, at: now(), state: 'queued',
      text: `【Hub 通知】你发给「${item.toTitle}」（${short(item.to)}）的消息没送出：${item.error || item.state}。` });
  }

  // ---- 等回复（复用前台关注用的原生最终回复读取器 liveHistory） ----
  // fresh：目标是刚预留、还没开工的新会话，没有历史要跳过，游标从头读。
  function addWatch(callerSid, targetId, { fresh = false } = {}) {
    const s = load(), m = meta(targetId);
    if (s.watches.some(w => w.caller === callerSid && w.target === targetId)) return;
    let cursor = null, seen = [];
    if (!fresh) try { const r = assistant.liveHistory.read(m || { id: targetId }); cursor = r.cursor; seen = (r.records || []).map(x => x.notificationKey || x.id); } catch {}
    s.watches.push({ caller: callerSid, target: targetId, title: oneLine(m?.title || m?.name, 40), at: now(), cursor, seen });
  }
  function pollWatches() {
    const s = load();
    let changed = false;
    for (const w of [...s.watches]) {
      if (now() - w.at > WATCH_TTL_MS) { s.watches.splice(s.watches.indexOf(w), 1); changed = true; continue; }
      const m = assistant.deps.getSession(w.target) ? meta(w.target) : null;
      if (!m) continue;
      let r; try { r = assistant.liveHistory.read(m, { cursor: w.cursor }); } catch { continue; }
      if (!r?.available) continue;
      const seen = new Set(w.seen || []);
      const fresh = (r.records || []).filter(x => !seen.has(x.notificationKey || x.id) && !require('../team-silent-reply').isNoUpdateReply(x.text));
      // 等「这条消息之后」的回复：送达前的旧回复不算。
      const pending = s.outbox.some(o => o.to === w.target && o.from === w.caller && o.state === 'queued');
      if (!fresh.length || pending) { if (r.cursor !== w.cursor) { w.cursor = r.cursor; changed = true; } for (const x of r.records || []) seen.add(x.notificationKey || x.id); w.seen = [...seen].slice(-200); continue; }
      const reply = fresh.at(-1), body = String(reply.text || '');
      s.outbox.push({ id: 'hub-reply-' + hash(w.caller + w.target + (reply.notificationKey || reply.id)), from: 'hub', to: w.caller, toTitle: '', system: true, at: now(), state: 'queued',
        text: `【Hub 回复提醒】你关注的会话「${w.title}」（${short(w.target)}）回复了：\n${body.slice(0, REPLY_HEAD)}${body.length > REPLY_HEAD ? `\n…（共 ${body.length} 字，全文：hub session read --id ${short(w.target)}）` : ''}` });
      s.watches.splice(s.watches.indexOf(w), 1); changed = true;
    }
    return changed;
  }

  // ---- 读进展 ----
  function sessionRead(args) {
    const target = resolveTarget(args.id);
    if (target.front) throw Error('前台的进展不开放读取');
    const s = { ...target, id: target.id };
    const slim = require('../hub-assistant/slim');
    const progress = slim.readProgress(s, { cardPathFor: assistant.deps.progressCardPath, lastReply: sid => assistant.lastReplyOf(sid) });
    const tail = Math.max(1, Math.min(5, Number(args.tail) || 1));
    let replies = [];
    try { const r = assistant.liveHistory.read(meta(target.id) || s); replies = (r.records || []).slice(-tail).map(x => ({ at: x.timestamp ? new Date(x.timestamp).toISOString() : null, text: slim.clip(String(x.text || ''), Math.floor(6000 / tail)) })); } catch {}
    return { ...progress, status: progress.status, state: slim.stateWord(assistant.sessions().find(x => x.id === target.id) || s), lastReplies: replies };
  }

  // ---- 模型、账号 ----
  function models({ kind = '' } = {}) {
    const { modelOptionsFor } = require('../model-options'), profiles = require('../hub-assistant/profiles'), kinds = require('../ai-kinds');
    const list = (kind ? [kinds.resolveKindAlias(kind)] : kinds.ALL_AI_KINDS).filter(k => kinds.ALL_AI_KINDS.includes(k));
    if (!list.length) throw Error(`没有后端「${kind}」；可选：${kinds.ALL_AI_KINDS.join(' / ')}`);
    return { note: 'model 写 id；effort 只能从该模型的 efforts 里选，空表示该模型不收深度参数。不写 model/effort 用 Hub 默认。Antigravity（gemini）清单随 Hub 读到的动态列表变化。',
      kinds: list.map(k => ({ kind: k, label: kinds.getKindLabel(k), models: modelOptionsFor(k).map(o => ({ id: o.id, label: o.label, efforts: profiles.effortsFor(k, o.id) })) })) };
  }
  function accounts() {
    if (team?.accounts) return team.accounts();
    return assistant.accountStatus();
  }

  // ---- 后台推进：排队消息、补记谱系、等回复 ----
  function trim() {
    const s = load(), t = now();
    s.outbox = s.outbox.filter(x => x.state === 'queued' || x.state === 'queued-front' || t - x.at < QUEUE_TTL_MS).slice(-500);
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const s = load();
      let changed = settleReservations();
      if (adoptChildren()) changed = true;
      if (pollWatches()) changed = true;
      for (const item of s.outbox.filter(x => x.state === 'queued')) {
        if (item.system) {
          // 系统通知（失败、回复提醒）送回调用方；调用方忙就等，24 小时后丢弃。
          if (now() - item.at > QUEUE_TTL_MS) { item.state = 'expired'; changed = true; continue; }
          if (isFront(item.to)) { assistant.care?.alerts?.raiseFront?.({ key: item.id, text: item.text }); item.state = 'delivered'; item.deliveredAt = now(); delete item.text; changed = true; continue; }
          if (!meta(item.to) || busy({ id: item.to })) continue;
          try { const r = await assistant.execute({ type: 'send', requestId: item.id, targetSessionId: item.to, text: item.text }, { plainTask: true, frontOwned: false });
            if (r?.ok || r?.duplicate) { item.state = 'delivered'; item.deliveredAt = now(); delete item.text; changed = true; } }
          catch (error) { if (!targetBusy(error)) { item.state = 'failed'; item.error = error.message; changed = true; } }
          continue;
        }
        const before = item.state;
        await deliver(item);
        if (item.state !== before) changed = true;
      }
      if (changed) { trim(); save(); }
      if (!active()) disarm();
    } catch (error) { logger.warn?.('[hub-cli] tick', error.message); }
    finally { ticking = false; }
  }
  function arm() { if (!timer && tickMs > 0) timer = setTimer(() => { void tick(); }, tickMs); }
  function disarm() { if (timer) { clearTimer(timer); timer = null; } }

  async function invoke(sid, action, args = {}) {
    switch (action) {
      case 'sessions': return sessions(args);
      case 'session-new': return sessionNew(sid, args);
      case 'session-send': return sessionSend(sid, args);
      case 'session-read': return sessionRead(args);
      case 'models': return models(args);
      case 'accounts': return accounts();
      default: throw Error('未知动作；可用：sessions / session-new / session-send / session-read / models / accounts');
    }
  }
  // start 与 tick 用同一个「还有活」判据（审查 P2-6）：排队消息、关注、未转正的预留、旧版 pending 谱系都要轮询。
  function active() { const s = load(); return s.outbox.some(x => x.state === 'queued') || s.watches.length > 0 || Object.entries(s.lineage).some(([k, r]) => k.startsWith('pending:') || r.pending || (typeof team?.adoptHubChild === 'function' && adoptable(k, r))); }
  function start() { let changed = settleReservations(); if (adoptChildren()) changed = true; if (changed) save(); if (active()) arm(); }
  // 经 hub 建出的会话在后台启动/恢复，不等界面终端回应光标查询（同前台派出的会话）。
  function isChild(id) { return !!load().lineage[id]; }

  return { invoke, start, stop: disarm, tick, isChild, depthOf, limits, teamGuard, _state: () => load() };
}

module.exports = { createHubCliService, senderTag, tagMessage, DEFAULTS, INTERNAL_PURPOSE };
