'use strict';
// 调用入口：hookServer 的 POST /api/team（共享 token + 与 sessionId 绑定的 CLAUDE_HUB_TEAM_TOKEN），
// 命令行 scripts/hub-team.js 包了一层。投递复用普通会话的提交闭环（submitPrompt），插话复用群聊的 injector。
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { creationDefaults } = require('../../core/session-creation-defaults');
const { delegationGuidance, guardGuidance, RECEIPT_FORMAT } = require('./member-guidance');
const { NO_UPDATE_MARK } = require('../../core/team-silent-reply');
const TeamRace = require('./race');
const MemberWorktree = require('./member-worktree');
const { formatAbsoluteTime } = require('../../core/beijing-time');

// 原来有三道闸：全机同时干活 16、每队同时干活 10、每位负责人名下 10 名（已交付未离队的也算）。现在三道都提到 100，
// 只当失控时的安全阀，正常用不到；config team.maxWorkingTotal / maxWorkingMembers / maxMembers 可改。
// 资源保护改成软提醒（不拦人）：起成员时内存吃紧或所用账号额度告急，Hub 给负责人留言，见 resourceNotice。
const SAFETY_CAP = 100;
const MAX_MEMBERS = SAFETY_CAP;
const MAX_WORKING_MEMBERS = SAFETY_CAP;
const MAX_WORKING_TOTAL = SAFETY_CAP;
// 软提醒门限：可用内存低于 6 GB 或低于总量 10%；账号 5 小时余量低于 15% 或 7 天余量低于 10%。同类提醒 15 分钟内只发一次。
const LOW_MEM_FREE_BYTES = 6 * 1024 ** 3;
const LOW_MEM_FREE_RATIO = 0.1;
const LOW_QUOTA_5H = 15, LOW_QUOTA_7D = 10;
const RESOURCE_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
// 成员用 --deliver 交付后：交付消息送进负责人会话、负责人这一轮处理完（不再运行）且至少过了这么久，
// 又没再给它派活，就让它离队并休眠，不再空占 5 小时（2026-11-09 复盘：一队 5 人干完 5～8.7 小时后才被挂起）。
const RELEASE_AFTER_ACK_MS = 60 * 1000;
const NOTICE_LIMIT = 1800;
const TICK_MS = 3000;
// 消息永远送不到、负责人也不知道。巡检只读 Hub 已有的终端输出时间，不花模型 token；只提醒，不自动重启。
const WATCH_MS = 60 * 1000;
const STALL_MS = 10 * 60 * 1000;          // 运行中却连续这么久没有任何终端输出 → 疑似卡住
const MISSING_ALERT_MS = 3 * 60 * 1000;   // 会话已不在运行、消息排队这么久 → 告诉负责人
// 原生会话以引擎自报状态为准；终端会话除了回合标记，还要近 5 分钟有终端输出（CLI 干活时计时器每秒刷新）。
// 证据不足就按空闲投递：往真在忙的 CLI 里送，最坏是它做完这一轮再看，不丢也不打断。
const QUIET_MS = 5 * 60 * 1000;
// 明确没发出去（notSent，如冷启动超过 60 秒「助理启动尚未完成」）才自动重发，避免重复投递。
const RETRY_BACKOFF_MS = [60 * 1000, 3 * 60 * 1000, 10 * 60 * 1000];
const RESTART_COOLDOWN_MS = 30 * 60 * 1000;
// 前两次间隔 1 分钟，之后最多每 10 分钟一次；拉起都失败才合并提醒负责人。
const WAKE_RETRY_MS = 60 * 1000;
const REVIVE_COOLDOWN_MS = 10 * 60 * 1000;
const REVIVE_ALERT_AFTER = 2;
// Hub 重启后错峰拉起，避免一次起一屏 CLI 冲击内存。
const STARTUP_REVIVE_DELAY_MS = 8000;
const STARTUP_STAGGER_MS = 5000;
// 全队空转：负责人与在队成员都空闲这么久、没有排队消息，提醒负责人一次（同一段空转只提醒一次）。
const IDLE_TEAM_MS = 20 * 60 * 1000;
// 发给负责人的一批正文超过这么多字：整批原文落盘，对话里只放清单与读法（config.json team.leadInboxChars 可改）。
// 2026-11-15 从 1500 提到 6000：原来超限就让负责人派子 Agent 读，子 Agent 冷启动约 3 万 token，去摘要 73 个平均 6.6 KB 的批次，账算反了。
const LEAD_INBOX_CHARS = 6000;
// 不叫醒的留言也不能无限攒：最老一条超过 20 分钟或攒满 8 条，负责人空闲时一并送达（2026-11-15 默认不叫醒后由 30 分钟缩到 20 分钟）。
const NOWAKE_MAX_AGE_MS = 20 * 60 * 1000;
const NOWAKE_MAX_COUNT = 8;
// 叫醒负责人前等 2 分钟，把陆续到的汇报并成一批（2026-11-09 用 6 个负责人的历史消息回放：
// 叫醒少约 15%，每条平均只多等约 50 秒；config.json team.leadSettleSeconds 可改）。
const LEAD_SETTLE_MS = 2 * 60 * 1000;
// 隐藏窗口的隔离测试实例（CLAUDE_HUB_E2E=1）额外允许 PowerShell 成员：不登录任何 AI 也能验证批准与侧栏挂载；它不收开工任务。
// 可点名订阅账号的只有 Claude / Codex / Antigravity；其余后端沿用前台新建会话的默认配置（creationDefaults）。
const AI_KINDS = require('../../core/ai-kinds');
const KINDS = AI_KINDS.ALL_AI_KINDS.filter(k => k !== 'codeagent').concat(process.env.CLAUDE_HUB_E2E === '1' ? ['powershell'] : []);
const ACCOUNT_KINDS = ['claude', 'codex', 'gemini'];
// 同一提交人 10 分钟内交同样的成员（kind / model / account / task / title 全同）：直接回原计划结果，不重复招人。
// 起因 2026-11-23：自动批准失败后负责人脚本重试，方案 E 被招了 4 位 Codex。
const DEDUPE_MS = 10 * 60 * 1000;
const LEAD = 'lead';
const URGENT_RE = /卡住|阻塞|受阻|失败|报错|崩溃|拍板|请示|求助|紧急|blocked/i;
// 「0 失败」「无报错」「不是被外部卡住」这类说没出事的话不算告急（2026-11-21：11-15 后 29 批关键字叫醒里至少 5 批是这种误判）。
const NEGATED_URGENT_RE = /(?:\b0|零|无|没有|没|未)\s*(?:个|次|项|条|处)?\s*(?:卡住|阻塞|受阻|失败|报错|崩溃)|(?:不是|并非)[^，。；,;\n]{0,6}?(?:卡住|阻塞|受阻|失败|报错|崩溃)|(?:失败|报错|崩溃)\s*[:：=]?\s*0(?!\d)/gi;
const isUrgent = text => URGENT_RE.test(String(text || '').replace(NEGATED_URGENT_RE, ''));

const newId = prefix => `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

function createTeamService(deps) {
  const company=deps.company ?? require('../../core/distribution').target==='company';
  const allowedKinds=company ? ['codeagent'] : KINDS;
  const approver=company ? '用户' : '用户';
  const {
    getHubDataDir, sessionManager, sendToRenderer = () => {}, logger = console, now = () => Date.now(),
    createSession, submitPrompt, injectPrompt = null, restartSession = null,
    listAccounts = () => ({ rows: [] }), getConfig = () => ({}), commandPath = () => '', wakeSession = null, persistedSession = null,
    schedule = (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
    skillFile = [process.resourcesPath && path.join(process.resourcesPath, 'skills', 'hub-driver', 'SKILL.md'), path.join(__dirname, '..', '..', 'skills', 'hub-driver', 'SKILL.md')].find(f => f && require('node:fs').existsSync(f)) || '',
    memInfo = () => { const os = require('node:os'); return { free: os.freemem(), total: os.totalmem() }; },
  } = deps;
  // 防繁殖护栏（core/hub-cli 注入，2026-11-22 审查 P1-3）：招人前查负责人层数，建成员前同步预留编号并登记谱系。
  let lineageGuard = deps.lineageGuard || null;
  const prepareWorktree = deps.prepareWorktree || MemberWorktree.prepareMemberWorktree;
  let memberGuard = null; // 成员工具权限守卫（main/team/member-guard.js），main.js 经 setMemberGuard 接上
  const resourceAlerted = new Map(); // 提醒类别 → 上次提醒时间（内存按负责人，额度按账号）
  const teams = new Map();
  const sending = new Set();
  const decisions = new Map(); // 同一负责人审批串行，不阻塞其他团队。
  const alerted = new Map();     // sid → 已就哪一段静默/离线提醒过负责人（同一段只提醒一次）
  const autoRestarted = new Map(); // sid → 上次因投递反复失败自动重启的时间
  const revival = new Map();     // sid → { at, failures, error }：自动拉起的冷却与失败次数
  const reviving = new Set();
  let lastWatch = 0;
  let timer = null, loaded = false, frozen = false;
  const scoring = new Set(); // 正在出成绩单的赛马计划

  const dir = () => path.join(getHubDataDir(), 'teams');
  const fileOf = leadSid => path.join(dir(), leadSid + '.json');
  const safeSid = sid => typeof sid === 'string' && /^[\w-]{4,80}$/.test(sid);

  function load() {
    if (loaded) return;
    loaded = true;
    let names = [];
    try { names = fs.readdirSync(dir()).filter(n => n.endsWith('.json')); } catch { return; }
    for (const name of names) {
      try {
        const team = JSON.parse(fs.readFileSync(path.join(dir(), name), 'utf8'));
        if (!team || !safeSid(team.leadSid)) continue;
        // Hub 重启时正在送的消息结果不明：保留内容，交给负责人决定是否重发，不自动重发。
        let changed = false;
        for (const m of team.messages || []) if (m.state === 'sending') { m.state = 'unconfirmed'; m.error = 'Hub 重启前可能已送达，请先核对对方会话再决定是否重发'; changed = true; }
        teams.set(team.leadSid, team);
        for (const m of team.members || []) if (!m.everDelivered && (team.messages || []).some(x => x.to === m.memberId && x.state === 'sent' && x.via !== 'not-ai')) { m.everDelivered = true; changed = true; }
        for (const plan of team.plans || []) {
          if (plan.status === 'pending' && plan.autoDeciding) { delete plan.autoDeciding; plan.status = 'failed'; plan.decidedAt = now(); plan.note = '自动批准途中 Hub 重启，未建任何成员；需要的话重新提交'; changed = true; }
          const interrupted = (plan.members || []).filter(m => m.status === 'creating');
          if (!interrupted.length) continue;
          for (const spec of interrupted) {
            spec.status = 'interrupted';
            const member = team.members?.find(m => m.memberId === spec.memberId);
            if (member?.status === 'creating') member.status = 'interrupted';
          }
          enqueue(team, 'hub', LEAD, `计划 ${plan.id} 有 ${interrupted.length} 人没建完（Hub 中途重启），请重新提交这几人的计划：${interrupted.map(m => m.title).join('、')}`, { wake: true });
          changed = true;
        }
        if (changed) save(team);
      } catch (error) { logger.warn?.('[team] 读取失败', name, error.message); }
    }
  }
  function save(team) {
    team.updatedAt = now();
    fs.mkdirSync(dir(), { recursive: true });
    const file = fileOf(team.leadSid), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(team, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    sendToRenderer('team:changed', { leadSid: team.leadSid, team: publicView(team) });
    // 名册一落盘就补成员标记（入队、建成、hub 子会话挂上都会走到这里，早于首条任务发送），不等定时同步。
    try { memberGuard?.syncFlags?.({ teams: [team], addOnly: true }); } catch (error) { logger.warn?.('[team] 成员标记同步失败', error.message); }
  }

  function teamOfLead(sid) { load(); return teams.get(sid) || null; }
  function teamOfMember(sid) {
    load();
    for (const team of teams.values()) {
      const member = (team.members || []).find(m => m.sid === sid && m.status !== 'dismissed');
      if (member) return { team, member };
    }
    return null;
  }
  function memberBySid(team, sid) {
    if (sid === team.leadSid) return { memberId: LEAD, sid, role: '负责人' };
    return (team.members || []).find(m => m.sid === sid) || null;
  }
  function memberById(team, id) {
    if (id === LEAD) return { memberId: LEAD, sid: team.leadSid, role: '负责人' };
    return (team.members || []).find(m => m.memberId === id && m.sid && m.status === 'active') || null;
  }
  // 离队休眠的成员：suspendSession 会把会话移出运行表，getSession 查不到；侧栏登记（可叫回）的从持久记录取。
  // 2026-11-22 实测：交付后休眠的成员一律报「会话已被关闭」，叫回原作者从没成功过。
  function recallableSession(sid) {
    const live = sessionManager.getSession(sid);
    if (live) return live;
    try { return (typeof persistedSession === 'function' && persistedSession(sid)) || null; } catch { return null; }
  }
  function sessionState(sid) {
    const s = sessionManager.getSession(sid);
    if (!s) return 'missing';
    if (s.status === 'dormant') return 'dormant';
    return isBusy(sid, s) ? 'running' : 'idle';
  }
  // 只给 status 展示用：出错的成员如实报「error」，投递等逻辑仍用 sessionState
  //（2026-11-23：Antigravity 被判地区不支持时 status 一直显示 idle，负责人以为它在正常干活）。
  function runtimeIssue(sid) {
    const s = sessionManager.getSession(sid);
    try { return s ? require('../../core/session-runtime-issue').sessionRuntimeIssue(s) : null; } catch { return null; }
  }
  function displayState(sid) {
    const base = sessionState(sid);
    return base === 'idle' && runtimeIssue(sid) ? 'error' : base;
  }
  function isBusy(sid, s) {
    if (s.runtimeBackend) return s.status === 'running';
    if (!sessionManager.isAgentTurnActive(sid)) return false;
    // 从没收到过终端输出时，以本轮开工时刻起算；两样都没有就是证据不足，按空闲投递
    // （2026-11-05 修：此前 !last 直接判忙，开工标记残留时会一直压着消息）。
    const last = lastOutputAt(sid);
    if (typeof sessionManager.getAgentTurnStartedAt !== 'function') return !last || now() - last < QUIET_MS;
    const evidenceAt = Math.max(last, Number(sessionManager.getAgentTurnStartedAt(sid)) || 0);
    return evidenceAt > 0 && now() - evidenceAt < QUIET_MS;
  }

  // ---- 同时干活的名额 ----
  function maxWorking() {
    const configured = Number(getConfig()?.team?.maxWorkingMembers);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : MAX_WORKING_MEMBERS;
  }
  // 占名额：正在建，或在队、会话醒着、还没交付。交付了就让出名额（负责人收到后再离队休眠）；休眠的不占。
  function occupies(m) {
    if (m.manual) return false;
    if (m.status === 'creating') return true;
    if (m.status !== 'active' || !m.sid || m.deliveredAt) return false;
    const state = sessionState(m.sid);
    return state === 'running' || state === 'idle';
  }
  function maxWorkingTotal() {
    const configured = Number(getConfig()?.team?.maxWorkingTotal);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : Math.max(MAX_WORKING_TOTAL, maxWorking());
  }
  function maxMembers() {
    const configured = Number(getConfig()?.team?.maxMembers);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : MAX_MEMBERS;
  }
  // 资源软提醒：只告诉负责人，不拦、不排队。内存按全机，额度按这位成员用的账号。
  function resourceStatus(kind, account, model = '') {
    const out = {};
    try {
      const { free, total } = memInfo() || {};
      if (free > 0 && total > 0) {
        out.memory = { freeGB: Math.round(free / 1024 ** 3 * 10) / 10, totalGB: Math.round(total / 1024 ** 3),
          low: free < LOW_MEM_FREE_BYTES || free / total < LOW_MEM_FREE_RATIO };
      }
    } catch {}
    try {
      if (account && ACCOUNT_KINDS.includes(kind)) {
        const inv = listAccounts() || {};
        const row = (inv[kind]?.rows || (kind === 'claude' ? inv.rows : []) || []).find(r => r.id === account);
        const isThirdParty = kind === 'gemini' && /^(?:claude|gpt)/i.test(String(model || '').trim());
        const s5 = isThirdParty && row?.thirdPartySpare5h !== undefined ? row.thirdPartySpare5h : row?.spare5h;
        const s7 = isThirdParty && row?.thirdPartySpare7d !== undefined ? row.thirdPartySpare7d : row?.spare7d;
        if (row) out.quota = { account, label: row.label || account, spare5h: s5 ?? null, spare7d: s7 ?? null,
          low: !row.stale && ((s5 != null && s5 < LOW_QUOTA_5H) || (s7 != null && s7 < LOW_QUOTA_7D)) }; // 读数过期（可能已重置）不报，免误报
      }
    } catch {}
    return out;
  }
  function resourceNotice(team, member) {
    const st = resourceStatus(member.kind, member.account, member.model), t = now(), parts = [];
    const due = key => { const last = resourceAlerted.get(key); if (last != null && t - last < RESOURCE_ALERT_COOLDOWN_MS) return false; resourceAlerted.set(key, t); return true; };
    if (st.memory?.low && due('mem:' + team.leadSid)) parts.push(`内存告急：本机只剩 ${st.memory.freeGB} GB 可用（共 ${st.memory.totalGB} GB），全机有 ${workingTotal()} 个成员在干活（每个 CLI 成员约占 0.3–0.5 GB）`);
    if (st.quota?.low && due('quota:' + member.kind + ':' + st.quota.account)) {
      const pct = v => v == null ? '未知' : Math.round(v) + '%';
      parts.push(`额度告急：${member.memberId} 用的账号 ${st.quota.label} 5 小时余量 ${pct(st.quota.spare5h)}、7 天余量 ${pct(st.quota.spare7d)}`);
    }
    if (parts.length) enqueue(team, 'hub', LEAD, `【资源提醒，不拦人】${parts.join('；')}。建议让已交付或闲着的成员 dismiss，新成员换余量多的账号（accounts 查看）。`, { wake: false });
  }
  const workingIn = team => (team.members || []).filter(occupies);
  function workingTotal() { let n = 0; for (const t of teams.values()) n += workingIn(t).length; return n; }
  function canStart(team) { return workingIn(team).length < maxWorking() && workingTotal() < maxWorkingTotal(); }
  // 别的负责人名下占着名额的成员：名额被占满时要能看出是谁占着（没交付也没活的成员，负责人应 dismiss）。
  function workingElsewhere(team) {
    return [...teams.values()].filter(t => t !== team).map(t => ({
      lead: String(sessionManager.getSession(t.leadSid)?.title || t.leadSid.slice(0, 8)).slice(0, 16),
      members: workingIn(t).map(m => m.memberId),
    })).filter(x => x.members.length);
  }
  function capText(team) {
    const cap = maxWorking(), mine = workingIn(team).map(m => m.memberId), total = workingTotal();
    const others = workingElsewhere(team).map(x => `「${x.lead}」队 ${memberList(x.members)}`);
    return `同时干活的成员每队最多 ${cap} 个、全机最多 ${maxWorkingTotal()} 个（安全阀，正常用不到；本队在干活 ${mine.length} 个${mine.length ? '：' + memberList(mine) : ''}；全机 ${total} 个${others.length ? '，另有 ' + others.join('、') : ''}）`;
  }

  function publicView(team) {
    return {
      leadSid: team.leadSid, createdAt: team.createdAt, updatedAt: team.updatedAt,
      members: (team.members || []).map(m => ({ memberId: m.memberId, sid: m.sid, role: m.role, kind: m.kind, account: m.account || '', title: m.title, status: m.status,
        ...(m.manual ? { manual: true } : {}),
        ...(m.model ? {model:m.model} : {}), ...(m.access === 'read' ? { access: 'read' } : {}), ...(m.dismissReason ? { dismissReason: m.dismissReason } : {}), ...(m.deliveredAt ? { delivered: true } : {}) })),
      plans: (team.plans || []).map(p => ({ id: p.id, status: p.status === 'pending' && p.autoDeciding ? 'deciding' : p.status, goal: p.goal, members: p.members, submittedAt: p.submittedAt, decidedAt: p.decidedAt || 0, note: p.note || '' })),
      grants: (team.grants || []).slice(),
      ...(team.registered ? { registered: true } : {}), ...(team.project ? { project: team.project } : {}), ...(team.goal ? { goal: team.goal } : {}),
    };
  }
  function listTeams() { load(); return [...teams.values()].map(publicView); }

  // ---- 计划 ----
  function rejectTuning(raw) {
    const fields = (company ? ['effort', 'codexSpeedTier', 'fastMode', 'speed'] : ['codexSpeedTier', 'fastMode', 'speed'])
      .filter(key => Object.hasOwn(raw || {}, key));
    if (company && fields.length) throw Error(`公司组队计划只支持选择账号和模型，不能指定 ${fields.join(' / ')}`);
    if (fields.length) throw Error(`成员速度档与快速模式统一使用 Hub 默认配置，计划不能指定 ${fields.join(' / ')}；模型和思考深度可以写 model / effort`);
  }
  const accountRows = (kind, accounts) => accounts?.[kind]?.rows || (kind === 'claude' ? accounts?.rows : []) || [];
  // 账号可写 id、看板标签或「账号2」这样的口头叫法；唯一命中才用。
  function resolveAccount(kind, account, index, accounts) {
    if (account && !ACCOUNT_KINDS.includes(kind)) throw Error(`第 ${index + 1} 人的 ${AI_KINDS.getKindLabel(kind)}（${kind}）不能点名订阅账号：组队里只有 claude / codex / gemini 可以写 account，这个后端沿用 Hub 新建会话的默认配置；把 account 删掉再提交`);
    if (!account) return account;
    const rows = accountRows(kind, accounts);
    if (!rows.length) return account;
    try { return require('../../core/hub-assistant/dispatch').findAccount(rows, account).id; }
    catch (error) { throw Error(`第 ${index + 1} 人的 ${kind} 账号：${error.message}`); }
  }
  function validateAccount(kind, account, index, accounts) {
    const rows = accountRows(kind, accounts);
    if (account && ACCOUNT_KINDS.includes(kind) && !rows.some(row => row.id === account))
      throw Error(`第 ${index + 1} 人的 ${kind} 账号 ${account} 不在 Hub 账号列表里，先用 accounts 查看`);
  }
  // 点名模型：Claude / Codex 按 Hub 模型表校验（与前台 create_session 同一套）；Antigravity 模型清单由 CLI 动态给出，只校验名称格式。
  function namedModel(kind, raw, index) {
    const model = String(raw?.model || '').trim(), effort = String(raw?.effort || '').trim();
    if (!model && !effort) return {};
    if (kind === 'gemini') {
      if (model && !/^[A-Za-z0-9][\w.-]{0,79}$/.test(model)) throw Error(`第 ${index + 1} 人的 Antigravity 模型名称无效`);
      const efforts = ['low', 'medium', 'high', 'xhigh', 'max']; // 与 core/antigravity-config.js launchArgs 同一张表
      if (effort && !efforts.includes(effort)) throw Error(`第 ${index + 1} 人的 Antigravity 思考深度只能是 ${efforts.join(' / ')}`);
      return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    }
    // 千问、智谱、Kimi、DeepSeek 等按 Hub 模型表校验（与 hub models、前台新建同一套），不静默丢掉点名。
    if (kind === 'powershell') return {};
    const defaults = creationDefaults(kind, getConfig());
    try {
      const picked = require('../../core/hub-assistant/profiles').pick(kind, { model: model || undefined, effort: effort || undefined }, defaults);
      // 只点名模型时也带上 pick 归一后的深度：Hub 默认深度未必被新模型支持（Codex 审查 P2）。
      return { ...(model ? { model: picked.model } : {}), ...((effort || model) && picked.effort ? { effort: picked.effort } : {}) };
    } catch (error) { throw Error(`第 ${index + 1} 人：${error.message}`); }
  }
  function normalizePlan(args, team) {
    rejectTuning(args);
    const goal = String(args.goal || '').trim();
    const list = Array.isArray(args.members) ? args.members : [];
    if (!goal) throw Error('计划要写 goal：这批人一起要完成什么');
    if (!list.length) throw Error('计划至少招 1 人：members 是数组，每项写 role、task，可选 kind、account、cwd、title');
    // 赛马计划：race:true + 计划级 task，所有参赛者做同一道题；成员只需写 kind（可选 account、cwd、title）。
    const race = args.race === true, raceTask = String(args.task || '').trim();
    if (race && !raceTask) throw Error('赛马计划要写 task：所有参赛者做的同一道题（长的写任务书路径）');
    if (race && list.length < 2) throw Error('赛马至少 2 位参赛者');
    const active = occupiedSlots(team);
    if (active + list.length > maxMembers()) throw Error(`每位负责人最多 ${maxMembers()} 名成员（安全阀；现有 ${active} 名，已交付不再用的先 dismiss）`);
    const accountList=listAccounts();
    return { goal, ...(race ? { race: true, task: raceTask } : {}), members: list.map((raw, i) => {
      rejectTuning(raw);
      const kind = AI_KINDS.resolveKindAlias(raw?.kind || (company ? 'codeagent' : 'claude'));
      const role = String(raw?.role || (race ? `赛马参赛（${kind}）` : '')).trim(), task = String(raw?.task || (race ? raceTask : '')).trim();
      if (!role || !task) throw Error(`第 ${i + 1} 人要写 role（分工）和 task（开工任务，可写任务书路径）`);
      if (!company && kind === 'codeagent') throw Error(`第 ${i + 1} 人的 kind=codeagent 这个版本不提供；请从 ${allowedKinds.join(' / ')} 里选，antigravity / agy 等同 gemini`);
      if (!allowedKinds.includes(kind) || (!company && kind !== 'powershell' && !require('../../core/distribution').kindAllowed(kind)))
        throw Error(`第 ${i + 1} 人的 kind「${kind}」不可用；可选：${allowedKinds.join(' / ')}${company ? '' : '（antigravity / agy 等同 gemini）'}`);
      let account = String(raw?.account || (company ? accountList.recommendedId : '') || '').trim();
      if (!company) { account = resolveAccount(kind, account, i, accountList); validateAccount(kind, account, i, accountList); }
      const named = company ? {} : namedModel(kind, raw, i);
      let model='';
      if(company) {
        const row=(accountList.rows || []).find(a=>a.id===account);
        if(!row || !row.usable)throw Error(`第 ${i+1} 人的号池账号不可用，请用 accounts 查看并选择可用账号`);
        model=String(raw?.model || '').trim();
        if(model&&!require('../../core/codeagent-models').isSafeModelId(model))throw Error(`第 ${i+1} 人的模型名称无效`);
        if(model&&row.modelsAuthoritative&&!row.models.some(m=>m.toLowerCase()===model.toLowerCase()))throw Error(`第 ${i+1} 人的账号没有 ${model} 权限，请从该账号的 models 清单选择`);
        if(model)model=row.models.find(m=>m.toLowerCase()===model.toLowerCase()) || model;
      }
      const cwd = String(raw?.cwd || '').trim();
      if (cwd && !fs.existsSync(cwd)) throw Error(`第 ${i + 1} 人的工作目录不存在：${cwd}`);
      // 成员工具权限轻量版（2026-11-23）：审查类任务可声明 access:"read"（只读）；默认 write 即现状。
      const access = raw?.access == null || raw.access === '' ? 'write' : String(raw.access).trim().toLowerCase();
      if (access !== 'read' && access !== 'write') throw Error(`第 ${i + 1} 人的 access 只能写 read 或 write`);
      return { role, task, kind, account, cwd, title: String(raw?.title || role).trim().slice(0, 40), ...(company ? {model} : named), ...(raw?.fresh === true ? { fresh: true } : {}), ...(access === 'read' ? { access } : {}), ...(raw?.worktree === false ? { worktree: false } : {}) };
    }) };
  }
  async function propose(callerSid, args) {
    if(company&&!/^codeagent(?:-resume)?$/.test(sessionManager.getSession(callerSid)?.kind || ''))throw Error('公司组队请从 CodeAgent 会话提交计划');
    let parent=teamOfMember(callerSid);
    const frontGrant=!company&&deps.taskGroups?.authorityFor(callerSid);
    // hub 命令建的会话挂成成员只为侧栏归属，不改变它原有的招人能力（Codex 审查 P2）：它招人时从原项目摘下、自成项目。
    const hubSeat = parent?.member?.via === 'hub' ? parent : null;
    if (hubSeat) parent = null;
    if (parent&&!frontGrant) throw Error('成员不能招人；需要人手请向负责人提');
    const leadSid=parent?parent.team.leadSid:callerSid;
    // 层数到顶的会话（如经 hub 建到第 2 层）不能当负责人招人；第一个 await 之前就拒绝，不建计划。
    lineageGuard?.checkDepth(leadSid);
    let team = parent?.team || teamOfLead(callerSid);
    const plan = normalizePlan(args, team);
    // 去重先于叫回，按成员逐个判（Codex 复审 11-23）：同一提交人 10 分钟内交过内容完全相同的成员，
    // 那位还在队（排队、创建中、在干活）就不重复招；已交付离队的走下面原有的叫回判定；建失败或中断的照常重招。
    const dedupe = matchDuplicates(team, plan, callerSid, leadSid);
    if (dedupe.whole) return duplicateOutcome(team, dedupe.whole);
    const duplicates = dedupe.hits.map(h => ({ title: h.spec.title, memberId: h.spec.memberId, planId: h.plan.id }));
    if (duplicates.length && duplicates.length === plan.members.length)
      return { ok: true, status: 'duplicate', duplicate: true, duplicates, note: `10 分钟内你已提交过这些成员，他们都还在队，这次没有重复招人：${duplicates.map(d => `${d.memberId}（${d.title}）`).join('、')}。要再加人就改 title 或 task 后重交；用 status 看全队。` };
    if (duplicates.length) plan.members = plan.members.filter((_, i) => !dedupe.hits.some(h => h.index === i));
    if (hubSeat) releaseHubSeat(callerSid);
    // 招人前先找熟人（2026-11-19，main/team/recall-match.js）：返工叫回原作者、审查一律新人、岗位很像的提示负责人可叫回。
    const recalled = [], hints = [];
    // 赛马参赛者必须是绑定本计划的新成员：叫回老成员会把它挪出赛马，汇总永远凑不齐（Codex 审查 P1）。
    if (!company && !parent && team && !plan.race) {
      const { planRecalls, recallText } = require('./recall-match');
      const leadCwd = sessionManager.getSession(leadSid)?.cwd;
      const sessionInfo = sid => { const s = recallableSession(sid); return s ? { exists: true, cwd: s.cwd, contextPct: s.contextPct, inOtherTeam: !!(teamOfLead(sid) || teamOfMember(sid)) } : null; };
      const keep = [];
      for (const d of planRecalls(plan.members, team, { now: now(), leadCwd, sessionInfo })) {
        const spec = plan.members[d.index];
        if (d.action === 'recall') {
          const rec = team.members.find(m => m.memberId === d.memberId);
          try { send(leadSid, { to: d.memberId, message: recallText(spec, rec) }); recalled.push({ memberId: d.memberId, insteadOf: spec.title, reason: d.reason }); continue; }
          catch (error) { hints.push({ memberId: d.memberId, for: spec.title, reason: `想叫回但没成（${error.message}），已照常新招` }); }
        } else if (d.action === 'hint') hints.push({ memberId: d.memberId, for: spec.title, reason: d.reason });
        keep.push(spec);
      }
      plan.members = keep;
      // 复用账（2026-11-19）：记下每次叫回和提示，scripts/team-reuse-report.js 据此统计「自动叫回几次、提示后照做几次」。
      if (recalled.length || hints.length) {
        team.reuseLog = (team.reuseLog || []).concat({ at: now(), recalled: recalled.map(r => r.memberId), hints: hints.map(h => h.memberId) }).slice(-200);
        save(team);
      }
    }
    const reuse = r => ({ ...r, ...(duplicates.length ? { duplicates, duplicateNote: `这些成员 10 分钟内已招过、还在队，没有重复招：${duplicates.map(d => d.memberId).join('、')}` } : {}), ...(recalled.length ? { recalled } : {}), ...(hints.length ? { hints, hintNote: '这些老成员做过很像的活、上下文还在：要用它就 send --to 编号 叫回（不占新编号）；确实要新人，计划里给那一项加 "fresh": true' } : {}) });
    if (!plan.members.length) {
      // 全部叫回、没有新计划：同样撤回这位提交人此前的待批单，免得旧单之后被批准、重复招人（Codex 复审 2026-11-19）。
      let withdrew = false;
      for (const p of team.plans) if (p.status === 'pending' && (p.submittedBy || leadSid) === callerSid) { p.status = 'withdrawn'; p.decidedAt = now(); p.note = '提交人改为叫回老成员'; withdrew = true; }
      if (withdrew) save(team);
    }
    if (!plan.members.length) return reuse({ ok: true, status: 'recalled', note: `没有新招人：${recalled.map(r => `${r.memberId} 已叫回接「${r.insteadOf}」`).join('；')}。它们的会话和上下文都还在，新任务已发过去。` });
    if (!team) {
      team = { leadSid, createdAt: now(), updatedAt: now(), plans: [], members: [], grants: [], messages: [] };
      teams.set(leadSid, team);
    }
    // 只撤回同一提交人此前的待批单；可信成员补人不顶掉负责人自己尚未批准的计划，两张并存。
    for (const p of team.plans) if (p.status === 'pending' && (p.submittedBy || leadSid) === callerSid) { p.status = 'withdrawn'; p.decidedAt = now(); p.note = '提交人提交了新版计划'; }
    const byRule = !frontGrant && !company && !parent && (getConfig()?.team?.autoApproveLeads ?? deps.autoApproveLeadsDefault) === true;
    const item = { id: newId('plan'), status: 'pending', ...plan, memberKeys: plan.members.map(m => memberKey(plan, m)), submittedAt: now(), submittedBy:callerSid, ...(frontGrant || byRule ? { autoDeciding: true } : {}) };
    team.plans.push(item);
    save(team);
    // 前台代批 / 按规则自动批准（身份来自 Hub 内部登记簿，不读取计划中自称的授权字段）。
    if (frontGrant || byRule) {
      const run = decide({ leadSid, planId: item.id, approve: true, note: frontGrant ? '前台已代批' : '已按用户规则自动批准', autoApproved: true, ...(byRule ? { byRule: true } : {}) });
      autoInflight.set(item.id, run);
      let result;
      try { result = await run; }
      catch (error) { throw autoApproveFailed(team, item, error); }
      finally { autoInflight.delete(item.id); }
      return reuse({ ...result, planId: item.id, note: (frontGrant ? '前台已代批' : '已按用户规则自动批准') + '；账号已按挑号规则校验，超出并发上限的成员排队' });
    }
    return reuse({ planId: item.id, status: 'pending', note: `计划已提交，等${approver}在 Hub 侧栏（你这个会话那一行的「待批准」）批准。批准前不会建任何会话；批准或驳回的结果会作为一条消息发给你。` });
  }

  const autoInflight = new Map(); // planId → 进行中的自动批准（重交同一份计划时等它的结果）
  // 成员去重键：kind / model / effort / account / task / title / cwd / fresh 全同才算同一位（赛马连同题目）。
  function memberKey(plan, m) {
    return JSON.stringify([plan.race ? plan.task || '' : '', m.kind, m.model || '', m.effort || '', m.account || '', m.task, m.title, m.cwd || '', m.fresh === true]);
  }
  // 返回 { whole: 原计划 }（整单与一张近期计划完全相同、且那张还待批或人都在队——回原计划结果，含等它的自动批准），
  // 或 { hits: [{ index, plan, spec }] }（逐个命中、仍在队的成员）。待批单只参与整单匹配：部分去重后提交新版会撤掉旧待批单，人就丢了。
  function matchDuplicates(team, plan, callerSid, leadSid) {
    const recent = (team?.plans || []).filter(p => Array.isArray(p.memberKeys) && (p.submittedBy || leadSid) === callerSid
      && now() - (p.submittedAt || 0) < DEDUPE_MS && ['pending', 'approved'].includes(p.status)).reverse();
    const keys = plan.members.map(m => memberKey(plan, m));
    const inTeam = spec => !['failed', 'interrupted', 'dismissed'].includes(team.members.find(m => m.memberId === spec.memberId)?.status || spec.status);
    const same = p => p.memberKeys.length === keys.length && p.memberKeys.every((k, i) => k === keys[i]);
    const whole = recent.find(p => same(p) && (p.status === 'pending' || p.members.every(inTeam)));
    if (whole) return { whole, hits: [] };
    if (plan.race) return { hits: [] }; // 赛马参赛者要整组绑定同一计划，不拆
    const used = new Set(), hits = [];
    keys.forEach((key, index) => {
      for (const p of recent) {
        if (p.status !== 'approved') continue;
        const j = p.memberKeys.findIndex((k, jj) => k === key && !used.has(p.id + ':' + jj) && p.members[jj] && inTeam(p.members[jj]));
        if (j >= 0) { used.add(p.id + ':' + j); hits.push({ index, plan: p, spec: p.members[j] }); return; }
      }
    });
    return { hits };
  }
  // 重交同一份计划：回原计划的现状，不新建计划、不招人。
  async function duplicateOutcome(team, plan) {
    const head = `10 分钟内你已提交过成员完全相同的计划 ${plan.id}，这次没有重复招人`;
    if (plan.status === 'pending' && autoInflight.has(plan.id)) { try { await autoInflight.get(plan.id); } catch {} }
    if (plan.status === 'failed') throw Error(`${head}；原计划没有批准成功（${plan.note || '原因未知'}），已作废、没建成员。按原因改计划后再交。`);
    if (plan.status === 'pending') return { planId: plan.id, status: 'pending', duplicate: true, note: `${head}；原计划还在等${approver}在侧栏批准，批准结果会作为消息发给你。` };
    const mine = (plan.members || []).map(spec => team.members.find(m => m.memberId === spec.memberId)).filter(Boolean);
    const pick = s => mine.filter(m => m.status === s).map(m => m.memberId);
    return { ok: true, status: plan.status, duplicate: true, planId: plan.id, created: mine.filter(m => !['queued', 'failed'].includes(m.status)).map(m => m.memberId),
      queued: pick('queued'), failed: mine.filter(m => m.status === 'failed').map(m => `${m.title}：${m.error || '原因未知'}`),
      note: `${head}；原计划已批准，成员 ${mine.map(m => `${m.memberId}（${m.status}）`).join('、') || '无'}。要再加人就改计划内容（如 title 或 task）后重交；用 status 看全队。` };
  }
  // 自动批准没成：计划作废（侧栏不出现待批单），错误改写成「原因 + 下一步」交给负责人。
  function autoApproveFailed(team, plan, error) {
    const reason = String(error?.message || error || '原因未知');
    if (plan.status === 'pending') {
      delete plan.autoDeciding; plan.status = 'failed'; plan.decidedAt = now(); plan.note = '自动批准没成：' + reason;
      save(team);
    }
    const next = /账号|风控|额度|号池/.test(reason) ? '用 accounts 查看可用账号，换号（或把 account 留空让 Hub 自动挑号）后重新 propose'
      : /关闭/.test(reason) ? 'Hub 重新开起来后再 propose' : '按原因改计划后重新 propose';
    return Error(`招人计划 ${plan.id} 没有批准成功，已作废，侧栏不会留待批单，也没有建任何成员。原因：${reason}。下一步：${next}。`);
  }
  // 被风控、明确耗尽（余量 ≤0）、点名不存在的照旧拦。返回改过的账号表和要提醒负责人的账号。
  function softenQuotaErrors(accounts) {
    const soft = [], out = { ...(accounts || {}) };
    for (const kind of ACCOUNT_KINDS) {
      const rows = accountRows(kind, accounts);
      if (!rows.length) continue;
      const fixed = rows.map(r => {
        if (kind === 'claude') {
          if (typeof r.excluded === 'string' && r.excluded.startsWith('账号异常')) { soft.push({ kind, id: r.id, label: r.label || r.id, why: r.excluded.replace(/^账号异常：?/, '额度读取失败：') }); return { ...r, excluded: null, usable: true }; }
          if (r.stale && !r.excluded && r.readAt) soft.push({ kind, id: r.id, label: r.label || r.id, why: '额度读数已过期' });
          return r;
        }
        if (r.error && !r.flagged && !r.excluded) { soft.push({ kind, id: r.id, label: r.label || r.id, why: '额度读取失败：' + String(r.error).slice(0, 80) }); return { ...r, error: '' }; }
        return r;
      });
      out[kind] = { ...(accounts?.[kind] || {}), rows: fixed };
      if (kind === 'claude' && accounts?.rows) out.rows = fixed;
    }
    return { accounts: out, soft };
  }

  // 自动挑号一律落到具体账号（Codex 审查 11-23 P1）：前台挑号在「额度全未知」时返回空、由启动回落到 Hub 默认号，
  // 而默认号可能正被风控或已耗尽。这里从排除了风控 / 异常 / 耗尽后的候选里补一个具体账号（默认号可用就用它）；全被排除照旧报错。
  function chooseConcreteAccount(kind, account, accounts, model) {
    const picked = require('../../core/hub-assistant/dispatch').chooseAccount(kind, account, accounts, model);
    // 只有 Claude 会在有候选时返回空（Codex 有候选必选一个；Antigravity 只在全部可用时沿用当前号）。
    if (picked.account || kind !== 'claude' || accounts?.backends?.[kind] === 'api') return picked;
    const rows = accountRows(kind, accounts);
    if (!rows.length) return picked;
    const pool = rows.filter(r => !(r.excluded || r.flagged || r.error || [r.spare5h, r.spare7d].some(v => v != null && v <= 0)));
    if (!pool.length) throw Error(`没有可用的 ${kind} 账号（都被风控、异常或额度用完）`);
    const config = getConfig() || {};
    const defaultId = config.claudeSubscriptionProfile;
    const row = pool.find(r => r.id === defaultId) || pool.slice().sort((a, b) => (a.activeSessions || 0) - (b.activeSessions || 0) || String(a.id).localeCompare(String(b.id)))[0];
    return { account: row.id, reason: `${row.label || row.id}：额度未知，从排除风控/耗尽后的账号里选` };
  }

  function occupiedSlots(team) { return (team?.members || []).filter(m => !m.manual && !['dismissed', 'failed', 'interrupted'].includes(m.status)).length; }
  function decide(request) {
    if (frozen) return Promise.reject(Error('Hub 正在关闭'));
    const previous = decisions.get(request.leadSid);
    const result = previous ? previous.catch(() => {}).then(() => decideNow(request)) : decideNow(request);
    decisions.set(request.leadSid, result);
    const clear = () => { if (decisions.get(request.leadSid) === result) decisions.delete(request.leadSid); };
    result.then(clear, clear);
    return result;
  }
  async function decideNow({ leadSid, planId, approve, note = '', edits = null, autoApproved = false, byRule = false }) {
    if (frozen) throw Error('Hub 正在关闭');
    const team = teamOfLead(leadSid);
    const plan = team?.plans.find(p => p.id === planId);
    if (!plan || plan.status !== 'pending') throw Error('这份计划已经处理过或不存在');
    note = String(note || '').trim();
    if (!approve) {
      plan.status = 'rejected'; plan.decidedAt = now(); plan.note = note;
      save(team);
      enqueue(team, 'hub', LEAD, `${approver}驳回了招人计划 ${plan.id}${note ? '：' + note : ''}。按意见修改后可重新提交。`, { wake: true, immediate: true });
      return { ok: true, status: 'rejected' };
    }
    // 代批凭据按实际提交人查（可信成员补人时负责人本身可能未获授权）。
    const grantSid=plan.submittedBy||leadSid;
    let quotaSoftNote = '';
    if(autoApproved&&(company||(!byRule&&!deps.taskGroups?.authorityFor(grantSid))))throw Error('前台代批授权不存在');
    const occupied = occupiedSlots(team);
    if (occupied + plan.members.length > maxMembers()) throw Error(`每位负责人最多 ${maxMembers()} 名成员（安全阀；已有及创建中 ${occupied} 名，本计划 ${plan.members.length} 名），无法批准`);
    // 批准时核对当前账号状态；公司版还允许修改模型，分工和任务保持计划内容。
    if(company) {
      // Revalidate the edited account/model and current pool state before any
      // member is created. A stale approval must not fall back to another kind.
      const members=plan.members.map((m,i)=>({...m,...(typeof edits?.[i]?.account==='string'?{account:edits[i].account}:{}),
        ...(typeof edits?.[i]?.model==='string'?{model:edits[i].model}:{})}));
      plan.members=normalizePlan({...plan,members},team).members;
    } else {
      // 自动批准时额度读取失败/过期只软提醒：照常挑号批准，提醒随结果回给负责人（2026-11-23）。
      const softened = autoApproved ? softenQuotaErrors(listAccounts()) : null;
      const accounts = softened ? softened.accounts : listAccounts();
      const chosenAccounts = plan.members.map((m, i) => {
        const account = resolveAccount(m.kind, Array.isArray(edits) && typeof edits[i]?.account === 'string' ? edits[i].account.trim() : m.account, i, accounts);
        validateAccount(m.kind, account, i, accounts);
        if(autoApproved){
          const effectiveModel=m.model||creationDefaults(m.kind,getConfig()).model||'';
          const picked=chooseConcreteAccount(m.kind,account,accounts,effectiveModel);
          const row=(accounts[m.kind]?.rows||accounts.rows||[]).find(r=>r.id===picked.account);
          if(row)row.activeSessions=(row.activeSessions||0)+1;
          return picked.account||'';
        }
        return account;
      });
      plan.members.forEach((m, i) => { m.account = chosenAccounts[i]; });
      // 只提醒这次真用到的账号：点名/挑中的那个，或该后端沿用默认号时同后端读不到额度的号。
      const used = (softened?.soft || []).filter(s => plan.members.some(m => m.kind === s.kind && (m.account ? m.account === s.id : true)));
      if (used.length) quotaSoftNote = `【资源提醒，不拦人】${[...new Map(used.map(s => [s.kind + ':' + s.id, s])).values()].map(s => `${s.kind} 账号 ${s.label}${s.why}`).join('；')}。已照常批准，余量未知；成员若撞额度会自动换号，也可 accounts 查看后换号。`;
    }
    delete plan.autoDeciding;
    plan.status = 'approved'; plan.decidedAt = now(); plan.note = note;
    if(autoApproved){plan.autoApproved=true;plan.dispatchAuthority=deps.taskGroups?.authorityFor(grantSid)||null;if(byRule)plan.approvedByRule=true;}
    // 首个 await 前预留本计划全部编号，先全部排队落盘；有名额的随即开工，其余等前面的人交付或休眠后自动补上。
    let nextId = Math.max(0, ...team.members.map(m => Number(m.memberId.slice(1)) || 0));
    for (const spec of plan.members) {
      spec.memberId = 'm' + (++nextId); spec.status = 'queued';
      team.members.push({ memberId: spec.memberId, sid: null, role: spec.role, kind: spec.kind,
        account: spec.account, title: spec.title, planId: plan.id, status: 'queued', queuedAt: now(), ...(company || spec.model ? { model: spec.model } : {}), ...(spec.effort ? { effort: spec.effort } : {}), ...(spec.access === 'read' ? { access: 'read' } : {}) });
    }
    save(team);
    await fillSlots({ announce: false });
    const mine = plan.members.map(spec => team.members.find(m => m.memberId === spec.memberId)).filter(Boolean);
    const created = mine.filter(m => m.status === 'active'), queued = mine.filter(m => m.status === 'queued');
    const failed = mine.filter(m => m.status === 'failed').map(m => `${m.title}：${m.error || '原因未知'}`);
    const roster = created.map(m => `${m.memberId} ${m.title}`).join('、');

    enqueue(team, 'hub', LEAD, `${autoApproved?(plan.approvedByRule?'已按用户规则自动批准':'前台已代批'):approver+'批准了'}招人计划 ${plan.id}${note && !/自动批准|前台已代批/.test(note) ? '（备注：' + note + '）' : ''}。已建成员：${roster || '无'}。` +
      (queued.length ? `排队：${memberList(queued.map(m => m.memberId))}（${capText(team)}；前面有人交付或休眠后 Hub 自动开工，开工任务照常送达）。` : '') +
      (failed.length ? `未建成：${failed.join('；')}。` : '') + '已创建成员的开工任务已排队；用 status 查看全队状态。' + (quotaSoftNote ? quotaSoftNote : ''),
      // 自动批准/前台代批：负责人提交计划时命令已当场返回结果，这条只作记录，随下次叫醒送达；有成员没建成才叫醒。
      // 2026-11-21 统计：11-15 后 226 批「零工具调用 + 无更新」白叫醒里 116 批是这条通知。
      autoApproved && !failed.length ? { wake: false, passive: true } : { wake: true, immediate: true });
    if(autoApproved&&plan.dispatchAuthority)deps.onAutoApproved?.({leadSid,planId:plan.id,goal:plan.goal,groupId:plan.dispatchAuthority.groupId,created:created.length,queued:queued.length,failed:failed.length});
    return { ok: true, status: 'approved', created: created.map(m => m.memberId), queued: queued.map(m => m.memberId), failed, ...(quotaSoftNote ? { resourceNote: quotaSoftNote } : {}) };
  }

  // 建一位成员的会话并排上开工任务。调用前成员已标 creating 并落盘（占名额）。
  async function startMember(team, plan, spec, member) {
    const lead = sessionManager.getSession(team.leadSid);
    let reservation = null;
    try {
      const config = getConfig();
      const effectiveModel = spec.model || (!company ? creationDefaults(spec.kind, config).model : '') || '';
      // 排队期间账号可能耗尽或被风控：开工前再次核对，点名号不可用就明确失败；自动选出的号直接用于启动。
      const autoPicked = (!company && plan.autoApproved)
        ? chooseConcreteAccount(spec.kind, spec.account, softenQuotaErrors(listAccounts()).accounts, effectiveModel)
        : null;
      const effectiveAccount = spec.account || autoPicked?.account || null;
      // 工作目录是 git 仓库主目录时，Hub 替成员建独立 worktree（main/team/member-worktree.js）；建不出来照常开工、开工消息里说明。
      const baseCwd = spec.cwd || lead?.cwd || undefined;
      const worktree = company || spec.kind === 'powershell' || (!deps.prepareWorktree && !MemberWorktree.mayNeedWorktree({ cwd: baseCwd, access: spec.access, enabled: spec.worktree })) ? null : await prepareWorktree({ cwd: baseCwd, memberId: member.memberId, leadSid: team.leadSid, access: spec.access, enabled: spec.worktree, now: now() }).catch(error => ({ error: error.message, repo: baseCwd }));
      if (worktree) { member.worktree = worktree; spec.worktreeInfo = worktree; }
      const opts = { ...(company ? {} : creationDefaults(spec.kind, config)), cwd: worktree?.path || baseCwd, title: spec.title, workspaceLabel: spec.title, openInBackground: true,
        // 后台建、没挂 xterm：不继承光标，否则 ConPTY 卡在 ESC[6n，CLI 不启动（2026-11-07）。
        noInheritCursor: true };
      // 点名模型 / 思考深度覆盖 Hub 默认（Codex 换模型时按新模型重算上下文上限，与前台新建一致）。
      if (!company && (spec.model || spec.effort)) {
        if (spec.kind === 'gemini') { if (spec.model) opts.model = spec.model; if (spec.effort) opts.effort = spec.effort; }
        else {
          // withModel 会按新模型删掉或重算 contextMax 等字段：整体替换，不能 Object.assign 留下旧值（Codex 审查 P2）。
          const merged = require('../../core/hub-assistant/profiles').withModel(spec.kind, opts, { model: spec.model || opts.model, effort: spec.effort || opts.effort });
          for (const key of Object.keys(opts)) if (!Object.hasOwn(merged, key)) delete opts[key];
          Object.assign(opts, merged);
        }
      }
      if (spec.kind === 'gemini' && effectiveAccount) opts.antigravityProfile = effectiveAccount;
      opts.memberGuard = true; // 成员工具权限轻量版：hook 去问 Hub（main/team/member-guard.js）
      if (spec.access === 'read') opts.memberAccess = 'read'; // Codex 起在只读沙箱里（core/session-manager.js）
      if(company) {opts.codeagentAccount='pool';opts.codeagentPoolPick=spec.account;if(spec.model){opts.model=spec.model;opts.codeagentModelPick=true;}}
      // 与 workspace-controller 的普通新建一致：可手动换号；自动换号默认打开（2026-11-16 起）。
      if (spec.kind === 'claude' && config.claudeBackend !== 'api') {
        opts.claudeProfile = spec.account || config.claudeSubscriptionProfile;
        opts.claudeAccountSwitchable = true;
      }
      if (spec.kind === 'codex' && config.codexBackend !== 'api') {
        opts.codexProfile = spec.account || config.codexSubscriptionProfile || 'default';
        opts.codexAccountPinned = true;
        opts.codexAutoSwitch = true;
      }
      // 建会话前同步预留编号、登记谱系（成员层数永久保存，离队后不归零）；层数或 hub 派生负责人的名额超限就不建。
      reservation = lineageGuard?.reserveMember(team.leadSid) || null;
      if (reservation) opts.id = reservation.id;
      const session = await createSession({ kind: spec.kind, opts });
      if (!session?.id) throw Error('Hub 没返回新会话');
      reservation = null;
      const account = company ? spec.account || session.codeagentPoolAccount : (spec.kind === 'codex' ? session.codexProfile : spec.kind === 'gemini' ? session.antigravityProfile : spec.kind === 'claude' ? session.claudeProfile : '') || spec.account;
      Object.assign(member, { sid: session.id, account: account || '', joinedAt: now(), status: 'active' });
      spec.status = 'created'; spec.sid = session.id;
      if(!company&&plan.autoApproved)deps.taskGroups?.inheritMember(plan.submittedBy||team.leadSid,session.id);
      save(team);
      if (spec.kind !== 'powershell') enqueue(team, LEAD, member.memberId, kickoff(team, member, spec, plan), { kickoff: true });
      try { resourceNotice(team, member); } catch {}
      return true;
    } catch (error) {
      // 会话没建出来：退还预留的名额和谱系。
      try { reservation?.release(); } catch {}
      spec.status = 'failed'; spec.error = String(error.message || error);
      member.status = 'failed'; member.error = spec.error;
      save(team);
      return false;
    }
  }
  // 按排队先后补名额：同一负责人、全机都不超过上限。串行执行，避免两轮同时把同一个人建两遍。
  let fillChain = Promise.resolve();
  function fillSlots(opts = {}) {
    const run = fillChain.then(() => fillOnce(opts));
    fillChain = run.catch(error => logger.warn?.('[team] 补名额失败', error.message));
    return run;
  }
  async function fillOnce({ announce = true } = {}) {
    for (const team of [...teams.values()]) {
      const waiting = (team.members || []).filter(m => m.status === 'queued')
        .sort((a, b) => (Number(a.queuedAt) || 0) - (Number(b.queuedAt) || 0) || Number(a.memberId.slice(1)) - Number(b.memberId.slice(1)));
      for (const member of waiting) {
        if (frozen || !canStart(team)) break;
        if (member.status !== 'queued') continue;
        const plan = (team.plans || []).find(p => p.id === member.planId);
        const spec = plan?.members.find(s => s.memberId === member.memberId);
        if (!spec) { member.status = 'failed'; member.error = '找不到原招人计划'; save(team); continue; }
        member.status = 'creating'; spec.status = 'creating'; save(team);
        const ok = await startMember(team, plan, spec, member);
        if (!announce) continue;
        // 补上名额只是旁听信息，不单独叫醒负责人；没建成要它处理，叫醒。
        if (ok) enqueue(team, 'hub', LEAD, `${member.memberId} ${member.title} 排到名额已开工。`, { wake: false, passive: true });
        else enqueue(team, 'hub', LEAD, `排队的 ${member.memberId}（${member.title}）没能建起来：${member.error}。可重新提交这一人的计划。`);
      }
    }

  }

  function kickoff(team, member, spec, plan) {
    return [
      `【组队开工 · 来自负责人】你是成员 ${member.memberId}，分工：${spec.role}。`,
      `团队目标：${plan.goal}`,
      `你的任务：${spec.task}`,
      '',
      ...MemberWorktree.kickoffLines(member.worktree),
      ...(plan.race ? TeamRace.kickoffLines({ worktreeReady: !!member.worktree?.path }) : []),
      ...guardGuidance(company ? 'codeagent' : spec.kind, spec.access, { company }),
      ...teamRules(spec.kind),
    ].join('\n');
  }
  function teamRules(kind) {
    const cmd = commandPath();
    return [
      '通信规矩：',
      `- 向负责人汇报：\`"${cmd}" send --to lead --message "结论 + 文件路径"\`。默认是留言、不叫醒负责人：攒到它下次醒来一起看，攒满 8 条或最老一条超过 20 分钟时负责人空闲就会收到。卡住、失败、要负责人拍板，或判断变了、影响别人的发现，加 \`--wake\` 叫醒它。`,
      `- 任务做完、交可验收的结果时加 \`--deliver\`（\`"${cmd}" send --to lead --deliver --message "…"\`）：负责人收到并处理完后，Hub 让你离队休眠、腾出名额和内存；要返工负责人直接发消息，Hub 会叫醒你接着干。汇报进度、提问、卡住时不加。`,
      `- 消息写结论和证据路径；超过约 ${NOTICE_LIMIT} 字自动保存完整正文，通知提供原文路径。用 read --id <消息编号> 可取原文。`,
      '- 要和其他成员直接交流，先向负责人说明原因，由负责人开放。',
      `- 看全队：\`"${cmd}" status\`。`,
      '- 在 PowerShell 里运行时，命令前加 `&`（例：`& "…hub-team.cmd" status`）。',
      `- ${delegationGuidance(company ? 'codeagent' : kind)}你不能再招 Hub 成员。`,
      '- 普通告知无需回执；任务、合同变更、阻塞解除确认一次即可。同一提交已审过时引用原结论。',
      '- 收到、开工确认、纯进度、登记名额或磁盘这类事务消息不发。负责人问你的问题，回复第一句先正面回答（是/否/数字），再给依据。',
      '',
      ...RECEIPT_FORMAT,
    ];
  }

  // 启动中心选了负责人（或右键负责人「创建子会话…」）建的会话，直接挂到该负责人名下：不走招人计划、
  function attachMember(args = {}) {
    if (frozen) throw Error('Hub 正在关闭');
    const leadSid = String(args.leadSid || ''), sid = String(args.sessionId || '');
    const lead = safeSid(leadSid) && sessionManager.getSession(leadSid);
    const session = safeSid(sid) && sessionManager.getSession(sid);
    if (!lead) throw Error('负责人会话已不在 Hub 里');
    if (!session) throw Error('子会话不存在');
    if (leadSid === sid) throw Error('不能把负责人加成自己的成员');
    if (teamOfMember(sid) && !isHubSeat(sid)) throw Error('这个会话已经是某个团队的成员');
    if (teamOfLead(sid)) throw Error('这个会话本身是负责人，不能再当成员');
    if (teamOfMember(leadSid) && !isHubSeat(leadSid)) throw Error('所选会话是别人团队的成员，不能当负责人');
    releaseHubSeat(sid); releaseHubSeat(leadSid);
    const task = String(args.task || '').trim().slice(0, 4000);
    const title = String(args.title || session.title || '').trim().slice(0, 40) || '子会话';
    let team = teamOfLead(leadSid);
    if (!team) {
      team = { leadSid, createdAt: now(), updatedAt: now(), plans: [], members: [], grants: [], messages: [] };
      teams.set(leadSid, team);
    }
    const nextId = Math.max(0, ...team.members.map(m => Number(m.memberId.slice(1)) || 0)) + 1;
    const kind = String(session.kind || '').replace(/-resume$/, '') || 'claude';
    const member = { memberId: 'm' + nextId, sid, role: `${approver}手动加入`, kind, title, status: 'active', joinedAt: now(), manual: true,
      account: session.codexProfile || session.claudeProfile || session.codeagentPoolAccount || '' };
    team.members.push(member);
    save(team);
    const ai = kind !== 'powershell';
    if (ai) enqueue(team, 'hub', member.memberId, manualKickoff(team, member, task), { kickoff: true });
    enqueue(team, 'hub', LEAD, `${approver}手动加了成员 ${member.memberId}（${title}），任务是：${task || `${approver}会在它的会话里直接布置`}。` +
      `它是${approver}自己开的会话，不占同时干活名额；用 send --to ${member.memberId} 和它沟通，它交付后同样会离队休眠。` +
      (ai ? '它已收到组队说明（怎么向你汇报、交付）。' : '它是终端会话，不收团队消息。'), { wake: true, immediate: true });
    return { ok: true, leadSid, memberId: member.memberId, sessionId: sid, team: publicView(team) };
  }
  function manualKickoff(team, member, task) {
    const leadTitle = String(sessionManager.getSession(team.leadSid)?.title || '负责人').slice(0, 40);
    return [
      `【组队说明 · 来自 Hub】${approver}把你手动加入了负责人「${leadTitle}」的团队，你是成员 ${member.memberId}。`,
      task ? `你的任务：${task}` : `${approver}会在本会话里直接给你布置任务；在那之前只回复一句「已入队，等待任务」，不做别的。`,
      '',
      ...teamRules(member.kind),
    ].join('\n');
  }
  // 负责人按 11-22 规则用 `hub session new` 开会话，原先只记谱系、不进团队，侧栏就把它们摊在顶层。
  // （负责人自己建的，自己知道），不占同时干活名额（hub 命令有自己的小时名额和层数护栏）。
  // 归属：调用方是负责人 → 挂它名下；调用方是某队成员 → 挂到该队负责人名下（侧栏只有一层）；
  // 普通会话 → 以它为负责人建一个未登记的项目（与手动加成员相同）；前台的派工本来就各自独立，不挂。
  // 返回 final=true 表示结论已定、不必重试；会话暂时查不到（重启后还没恢复）返回 final=false，由调用方稍后再试。
  function adoptHubChild(args = {}) {
    if (frozen) return { ok: false, reason: 'frozen' };
    load();
    const parent = String(args.parentSid || ''), sid = String(args.sessionId || '');
    if (!safeSid(parent) || !safeSid(sid) || parent === sid) return { ok: false, reason: 'bad-id', final: true };
    for (const t of teams.values()) if ((t.members || []).some(m => m.sid === sid)) return { ok: true, already: true, leadSid: t.leadSid, final: true };
    if (teams.has(sid)) return { ok: false, reason: 'child-is-lead', final: true };
    let team = teamOfLead(parent), via = null;
    if (!team) {
      // 含已离队的成员：它返工时再建的会话仍属于原项目。
      for (const t of teams.values()) { const m = (t.members || []).find(x => x.sid === parent); if (m) { team = t; via = m.memberId; break; } }
    }
    if (!team) {
      let front = '';
      try { front = String(deps.frontSessionId?.() || ''); } catch {}
      if (front && front === parent) return { ok: false, reason: 'front', final: true };
    }
    const session = recallableSession(sid);
    if (!session) return { ok: false, reason: 'child-missing' };
    if (!team) {
      if (!recallableSession(parent)) return { ok: false, reason: 'parent-missing' };
      team = { leadSid: parent, createdAt: now(), updatedAt: now(), plans: [], members: [], grants: [], messages: [] };
      teams.set(parent, team);
    }
    const nextId = Math.max(0, ...team.members.map(m => Number(String(m.memberId).slice(1)) || 0)) + 1;
    const kind = String(args.kind || session.kind || '').replace(/-resume$/, '') || 'claude';
    const title = String(args.title || session.title || '').trim().slice(0, 40) || 'hub 新建会话';
    const member = { memberId: 'm' + nextId, sid, role: via ? `${via} 用 hub 命令建` : '负责人用 hub 命令建', kind, title, status: 'active',
      joinedAt: now(), manual: true, via: 'hub', account: session.codexProfile || session.claudeProfile || session.codeagentPoolAccount || '' };
    team.members.push(member);
    save(team);
    return { ok: true, leadSid: team.leadSid, memberId: member.memberId, final: true };
  }
  function isHubSeat(sid) { return teamOfMember(sid)?.member?.via === 'hub'; }
  // 摘下不删记录（Codex 复审 P1）：编号永不复用，否则排队给旧编号的消息会被送给之后接这个编号的新会话。
  // 记录留作历史、去掉会话编号（侧栏不再把它挂在这里），没送出的消息作废，成员互通授权收回。
  function releaseHubSeat(sid) {
    for (const t of teams.values()) {
      // 已离队但还等着休眠（suspendPending）的席位也要摘：不然旧队巡检会把已经自成项目的它休眠（Codex 二次复审 P2）。
      const m = (t.members || []).find(x => x.sid === sid && x.via === 'hub');
      if (!m) continue;
      if (m.status !== 'dismissed') Object.assign(m, { status: 'dismissed', dismissedAt: now(), dismissReason: 'became-lead' });
      Object.assign(m, { releasedSid: sid, sid: null });
      delete m.suspendPending;
      for (const x of t.messages || []) if (x.to === m.memberId && (x.state === 'queued' || x.state === 'unconfirmed')) { x.state = 'failed'; x.error = '对方已自成项目、离开本队，未送达'; }
      t.grants = (t.grants || []).filter(g => !g.split(':').includes(m.memberId));
      save(t);
    }
  }
  // 只建一份空团队记录（项目名、目标），没有成员也进负责人名册，出现在所有「选负责人」的地方。
  function registerLead(args = {}) {
    if (frozen) throw Error('Hub 正在关闭');
    const sid = String(args.sessionId || '');
    const session = safeSid(sid) && sessionManager.getSession(sid);
    if (!session) throw Error('会话已不在 Hub 里');
    if (teamOfMember(sid) && !isHubSeat(sid)) throw Error('这个会话是别人团队的成员，不能再当负责人');
    releaseHubSeat(sid);
    let front = '';
    try { front = String(deps.frontSessionId?.() || ''); } catch {}
    if (front && front === sid) throw Error('前台本来就是负责人，不用登记');
    const project = String(args.project || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const goal = String(args.goal || '').trim().slice(0, 2000);
    let team = teamOfLead(sid);
    const fresh = !team;
    if (!team) {
      team = { leadSid: sid, createdAt: now(), updatedAt: now(), plans: [], members: [], grants: [], messages: [] };
      teams.set(sid, team);
    }
    team.registered = true; team.registeredAt = team.registeredAt || now();
    if (project) team.project = project;
    if (goal) team.goal = goal;
    save(team);
    const ai = !/powershell|terminal/i.test(String(session.kind || ''));
    // quiet：前台派出或收编的会话已经带着任务书（或正在干活），只登记进名册、不再塞就任说明打断它（2026-11-19 前台行为改进）。
    if (ai && !args.quiet) enqueue(team, 'hub', LEAD, leadKickoff(team, fresh), { wake: true, immediate: true, kickoff: true });
    return { ok: true, leadSid: sid, team: publicView(team) };
  }
  function leadKickoff(team, fresh) {
    const name = team.project || String(sessionManager.getSession(team.leadSid)?.title || '').slice(0, 40) || '本项目';
        const skill = skillFile ? `先读组队 skill：${skillFile}（命令、招人计划、汇报与交付规矩都在里面）。` : '组队命令和规矩见 hub-driver skill（hub help 可看全部命令）。';
    return [
      `【负责人登记 · 来自 Hub】${approver}${fresh ? '把你登记为' : '更新了你的'}项目「${name}」的负责人。`,
      team.goal ? `项目目标：${team.goal}` : '',
      skill,
      '要不要招成员、招几个，你按任务需要自己判断：单人能做完就自己做；要并行再提交招人计划。' + approver + '手动建的会话也可能直接挂到你名下，届时你会收到通知。',
      team.goal ? '现在按目标开工。' : `目标还没定：只回复一句「已就任负责人，等待任务」，等${approver}在本会话布置。`,
    ].filter(Boolean).join('\n');
  }
  // 启动中心「负责人」下拉的选项：前台排第一，其余负责人按最近活动排序；会话已不在 Hub 的不列。
  function leadOptions() {
    load();
    const activity = sid => { const s = sessionManager.getSession(sid); return Math.max(lastOutputAt(sid), Number(s?.lastMessageTime) || 0, Number(s?.createdAt) || 0); };
    const activeMembers = sid => (teams.get(sid)?.members || []).filter(m => m.status === 'active').length;
    let front = '';
    try { front = String(deps.frontSessionId?.() || ''); } catch {}
    if (front && !sessionManager.getSession(front)) front = '';
    const row = (sid, isFront) => ({ sid, title: String((!isFront && teams.get(sid)?.project) || sessionManager.getSession(sid)?.title || sid.slice(0, 8)), front: isFront, lastActive: activity(sid), members: activeMembers(sid) });
    const leads = [...teams.keys()].filter(sid => sid !== front && sessionManager.getSession(sid) && !teamOfMember(sid))
      .map(sid => row(sid, false)).sort((a, b) => b.lastActive - a.lastActive);
    return (front ? [row(front, true)] : []).concat(leads);
  }

  // ---- 消息 ----
  // 消息短号（2026-11-22）：每队从 1 递增，注入负责人时用 #12 代替 msg-xxxx-xxxxxx 长编号，read --id #12 也能取原文。
  function nextSeq(team) { team.msgSeq = (team.msgSeq || 0) + 1; return team.msgSeq; }
  const ref = m => (m.seq ? `#${m.seq}` : m.id);
  // 尾注里命令路径只写一次（回放：一条全文尾注里路径出现 3 次，占团队注入 9%）。
  // hub-team 只是简称不是别名：调用时换成完整路径（PowerShell 前加 &）；短号在命令里只写数字，# 在 shell 里是注释符（Codex 复审 + 自查）。
  const cmdLine = (cmd, parts) => `下文 hub-team 指 \`"${cmd}"\`（调用写完整路径，PowerShell 前加 &）：${parts.join('；')}。`;
  const srcRef = m => (m.sourceSeq ? `#${m.sourceSeq}` : m.sourceId);
  function enqueue(team, from, to, text, extra = {}) {
    team.messages ||= [];
    const item = { id: newId('msg'), from, to, text, state: 'queued', at: now(), ...extra };
    if (!item.seq) item.seq = nextSeq(team);
    team.messages.push(item);
    if (team.messages.length > 500) team.messages = team.messages.filter(m => m.state !== 'sent').concat(team.messages.slice(-300)).filter((m, i, a) => a.indexOf(m) === i);
    save(team);
    setImmediate(() => flush(team).catch(error => logger.warn?.('[team] 投递失败', error.message)));
    return item;
  }
  function send(callerSid, args) {
    const found = teamOfLead(callerSid) ? { team: teamOfLead(callerSid), member: { memberId: LEAD, sid: callerSid } } : teamOfMember(callerSid);
    if (!found) throw Error('你还不在任何团队里；负责人先用 propose 提交招人计划');
    const { team, member: caller } = found;
    const toId = String(args.to || '');
    const text = String(args.message || '');
    if (!text.trim()) throw Error('message 不能为空');
    const deliver = args.deliver === true;
    if (deliver && (caller.memberId === LEAD || toId !== LEAD)) throw Error('--deliver 只用于成员向负责人交付结果（send --to lead --deliver）');
    const rec = caller.memberId === LEAD ? (team.members || []).find(m => m.memberId === toId) : null;
    if (rec?.status === 'queued') throw Error(`${toId} 还在排队（${capText(team)}），开工后才能收消息；有补充要求等它开工后再发`);
    // 交付后被 Hub 收工的成员：负责人再派活就叫回它（同一会话、上下文还在），不用重新招人。
    if (rec?.status === 'dismissed' && rec.dismissReason === 'delivered' && rec.sid) {
      if (!recallableSession(rec.sid)) throw Error(`${toId} 的会话已被关闭，需要人手请重新提交计划`);
      if (teamOfMember(rec.sid) || teamOfLead(rec.sid)) throw Error(`${toId} 的会话离队后已加入别的团队或成了负责人，不能叫回；需要人手请重新提交计划`);
      if (!rec.manual && occupiedSlots(team) >= maxMembers()) throw Error(`每位负责人最多 ${maxMembers()} 名成员（安全阀），先让用不上的成员离队再叫回 ${toId}`);
      rec.status = 'active'; rec.recalledAt = now();
      for (const key of ['dismissedAt', 'dismissReason', 'suspendPending', 'suspendError', 'suspendedAt']) delete rec[key];
    }
    const target = memberById(team, toId);
    if (!target || target.memberId === caller.memberId) throw Error('to 写本队另一位成员编号（负责人是 lead，成员是 m1、m2…）');
    const peer = caller.memberId !== LEAD && target.memberId !== LEAD;
    if (peer && !(team.grants || []).includes(pair(caller.memberId, target.memberId))) throw Error('成员之间直接交流要负责人先开放；请先发给 lead 说明原因');
    // 要拍板的才叫醒。起因：近 10 天 5718 次叫醒里 1115 次负责人只回一句签收，每次叫醒都要把它的整段上下文重读一遍。
    // 还在用旧开工说明的成员不会加 --wake，正文里的这几类字眼兜住真要紧的消息。
    const wake = target.memberId === LEAD ? (args.wake === true || (args.wake !== false && isUrgent(text))) : true;
    const interrupt = caller.memberId === LEAD && args.interrupt === true;
    // 负责人给已交付的成员派新活：它重新算「在干活」，要占名额。
    if (rec && rec.deliveredAt) for (const key of ['deliveredAt', 'deliverMsgId', 'deliverSentAt']) delete rec[key];
    // 赛马还没出结果时让参赛者返工：旧交付作废，等它重新交付再出成绩单（Codex 审查 P1）。
    if (rec && rec.raceDeliveryPath && (team.plans || []).some(p => p.race && p.id === rec.planId && p.raceState !== 'done')) for (const key of ['raceDeliveryPath', 'raceDeliveredAt']) delete rec[key];
    // 先完整落盘再排队；不能把只剩前半段的合同当成功投递。
    const id = newId('msg'), at = now(), seq = nextSeq(team);
    save(team); // 短号先落盘再写存档：存档写好后 Hub 崩溃，重启也不会把同一个短号发给别的消息（Codex 审查 P1）
    const archiveDir = path.join(dir(), 'messages', team.leadSid);
    fs.mkdirSync(archiveDir, { recursive: true });
    const bodyPath = text.length > NOTICE_LIMIT ? path.join(archiveDir, id + '.md') : undefined;
    if (bodyPath) fs.writeFileSync(bodyPath, text, { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(archiveDir, id + '.json'), JSON.stringify({ id, seq, from: caller.memberId, to: target.memberId, at, text, bodyPath }), { encoding: 'utf8', flag: 'wx' });
    const notice = bodyPath ? `正文已完整保存（${text.length} 字符），执行前先读：${bodyPath}\n以下仅为预览：${text.slice(0, 240)}…` : text;
    const racePlan = deliver ? (team.plans || []).find(p => p.race && !p.raceState && p.id === (team.members || []).find(m => m.memberId === caller.memberId)?.planId) : null;
    if (racePlan) {
      // 赛马交付先由 Hub 收着，全员交齐后出成绩单、只叫醒负责人一次（见 checkRaces）。
      const self = team.members.find(m => m.memberId === caller.memberId);
      self.raceDeliveryPath = TeamRace.recordDelivery(raceDir(team, racePlan), self, text, id); self.raceDeliveredAt = at;
      self.deliveredAt = at; self.deliverMsgId = id; delete self.deliverSentAt;
      save(team); setImmediate(() => checkRaces(team));
      const left = TeamRace.planMembers(team, racePlan).filter(m => !m.raceDeliveryPath && !['failed', 'dismissed', 'interrupted'].includes(m.status)).length;
      return { messageId: id, seq, status: 'held', note: left ? `赛马交付已登记，还有 ${left} 位参赛者没交；全员交齐后 Hub 出成绩单统一交给负责人。` : '赛马交付已登记，你是最后一位；Hub 正在出成绩单交给负责人。' };
    }
    if (deliver) {
      // 交付即让出名额（排队的人随即补上）；负责人收到并处理完后再离队休眠，见 releaseDelivered。
      const self = (team.members || []).find(m => m.memberId === caller.memberId);
      if (self) { self.deliveredAt = at; self.deliverMsgId = id; delete self.deliverSentAt; }
    }
    const item = enqueue(team, caller.memberId, target.memberId, notice, { id, seq, at, wake: deliver ? true : wake, interrupt, bodyPath, ...(deliver ? { deliver: true } : {}) });
    if (peer) enqueue(team, caller.memberId, LEAD, `（抄送）${caller.memberId} → ${target.memberId}：${text.slice(0, 160)}${text.length > 160 ? '…（摘要，原文见消息编号）' : ''}`, { wake: false, copy: true, sourceId: id, sourceSeq: seq, copyTo: target.memberId });
    const asleep = target.memberId !== LEAD && ['missing', 'dormant'].includes(sessionState(target.sid));
    return { messageId: item.id, seq: item.seq, bodyPath, status: 'queued', note: target.memberId === LEAD
      ? (deliver ? '已作为交付发给负责人（会叫醒它）。负责人收到并处理完后，Hub 让你离队休眠；要返工它会直接叫醒你。'
        : wake ? '已排队，负责人空闲时送达（会叫醒它）。' : '已留言，负责人下次被叫醒时一起送达。')
      : asleep && !target.manual && !canStart(team) ? `已排队。${target.memberId} 在休眠，${capText(team)}；前面有人交付或休眠后 Hub 自动叫醒它送达。`
      : (interrupt ? '对方忙时直接插进它当前的工作，空闲时作为新任务送达。' : asleep ? `已排队，Hub 会叫醒 ${target.memberId} 送达。` : '已排队，对方空闲时送达。') };
  }
  // 不是组队负责人返回 ok:false，调用方改走普通提交。
  function notifyLead(leadSid, text, { wake = true } = {}) {
    const team = teamOfLead(leadSid);
    if (!team || !String(text || '').trim()) return { ok: false, error: '不是组队负责人' };
    const item = enqueue(team, 'hub', LEAD, String(text), { wake });
    return { ok: true, messageId: item.id };
  }
  function read(callerSid, args) {
    const found = teamOfLead(callerSid) ? { team: teamOfLead(callerSid), member: { memberId: LEAD } } : teamOfMember(callerSid);
    if (!found) throw Error('你还不在任何团队里');
    let id = String(args.messageId || '').trim();
    const { team, member } = found;
    const short = /^#?(\d{1,7})$/.exec(id);
    if (short) id = findBySeq(team, Number(short[1])) || '';
    if (!/^msg-[a-zA-Z0-9-]{1,90}$/.test(id)) throw Error(short ? `本团队没有 #${short[1]} 这条消息` : '消息编号无效（写 #12 这样的短号或 msg- 开头的长编号）');
    let item;
    try { item = JSON.parse(fs.readFileSync(path.join(dir(), 'messages', team.leadSid, id + '.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; item = (team.messages || []).find(m => m.id === id); }
    if (!item) throw Error('本团队没有这条消息；旧版已清理的记录无法恢复');
    if (member.memberId !== LEAD && item.from !== member.memberId && item.to !== member.memberId) throw Error('只有负责人或该消息参与者能读取原文');
    return { id: item.id, ...(item.seq ? { seq: item.seq } : {}), from: item.from, to: item.to, at: item.at, text: item.text, bodyPath: item.bodyPath, sourceId: item.sourceId };
  }
  // 短号先在内存里的近期消息找；早已裁掉的去成员消息存档里找（存档 json 带 seq，只有成员发出的消息有存档）。
  function findBySeq(team, seq) {
    const hit = (team.messages || []).find(m => m.seq === seq);
    if (hit) return hit.id;
    const archive = path.join(dir(), 'messages', team.leadSid);
    try {
      for (const f of fs.readdirSync(archive)) {
        if (!f.endsWith('.json')) continue;
        try { const j = JSON.parse(fs.readFileSync(path.join(archive, f), 'utf8')); if (j.seq === seq) return j.id; } catch {}
      }
    } catch {}
    return null;
  }
  const pair = (a, b) => [a, b].sort().join(':');
  function allow(callerSid, args) {
    const team = teamOfLead(callerSid);
    if (!team) throw Error('只有负责人能开放或收回成员间交流');
    const a = memberById(team, String(args.memberA || '')), b = memberById(team, String(args.memberB || ''));
    if (!a || !b || a.memberId === b.memberId || a.memberId === LEAD || b.memberId === LEAD) throw Error('memberA、memberB 写两位不同的成员编号');
    if (typeof args.allow !== 'boolean') throw Error('allow 写 true 或 false');
    const key = pair(a.memberId, b.memberId), had = team.grants.includes(key);
    if (args.allow && !had) team.grants.push(key);
    if (!args.allow && had) team.grants = team.grants.filter(g => g !== key);
    save(team);
    if (args.allow !== had) {
      const reason = String(args.reason || '').trim();
      const text = args.allow ? `负责人开放了 ${a.memberId} 与 ${b.memberId} 的直接交流${reason ? '：' + reason : ''}。用 send --to <对方编号> 互发，消息会抄送负责人。`
        : `负责人收回了 ${a.memberId} 与 ${b.memberId} 的直接交流。之后经负责人沟通。`;
      enqueue(team, LEAD, a.memberId, text); enqueue(team, LEAD, b.memberId, text);
    }
    return { ok: true, grants: team.grants.slice() };
  }

  // 收件人空闲才送；发给负责人的消息只有「要叫醒」的那条到了，才连同攒着的留言一起送。
  async function flush(team) {
    if (frozen) return;
    const ready = m => m.state === 'queued' && !(m.retryAt > now());
    const queued = (team.messages || []).filter(ready);
    const targets = [...new Set(queued.map(m => m.to))];
    for (const to of targets) {
      if (frozen) return;
      const target = memberById(team, to);
      if (!target) { for (const m of queued.filter(x => x.to === to)) { m.state = 'failed'; m.error = '收件人已离队'; } save(team); continue; }
      const lock = team.leadSid + ':' + to;
      if (sending.has(lock)) continue;
      // 重新取一遍：同时进行的另一轮投递可能已经送走了其中几条。
      const items = (team.messages || []).filter(m => ready(m) && m.to === to);
      if (!items.length || (to === LEAD && !leadDue(items))) continue;
      if (target.kind === 'powershell' || sessionManager.getSession(target.sid)?.kind === 'powershell') {
        // 只在隔离测试里出现的非 AI 成员：消息记为已处理，不往终端里敲字。
        for (const m of items) { m.state = 'sent'; m.via = 'not-ai'; m.sentAt = now(); }
        if (to === LEAD) noteDeliverySent(team, items);
        save(team); continue;
      }
      const state = sessionState(target.sid);
      if (state === 'missing' || state === 'dormant') {
        // 叫醒成员等于多一个干活的会话：名额满了就让消息排着，前面有人交付或休眠后再叫醒（负责人不受限）。
        if (to !== LEAD && !target.manual && !canStart(team)) continue;
        // Hub 会让空闲会话自动休眠：有消息要送时把它拉起（只拉侧栏里登记为休眠的会话，关掉的不复活）；
        // 拉起成功后下一拍照常补送。
        sending.add(lock);
        try { await revive(team, target); } finally { sending.delete(lock); }
        continue;
      }
      if (state === 'running') {
        const urgent = items.find(m => m.interrupt);
        if (urgent && typeof injectPrompt === 'function') await interruptNow(team, urgent, target);
        continue;
      }
      sending.add(lock);
      const batch = to === LEAD ? items : [items[0]];
      batch.forEach(m => { m.state = 'sending'; });
      save(team);
      try {
        const skillNote = to === LEAD ? skillUpdateNote(team) : null;
        let text = batch.length === 1 && batch[0].kickoff ? batch[0].text : to === LEAD ? leadBatchText(team, batch) : formatBatch(team, batch, to);
        if (skillNote) { const cut = text.indexOf('\n'); text = cut < 0 ? text + '\n' + skillNote.line : text.slice(0, cut + 1) + skillNote.line + '\n' + text.slice(cut + 1); }
        const result = await submitPrompt(target.sid, text);
        if (skillNote && !(result?.ok === false && result.notSent === true)) { team.skillVersionSeen = skillNote.version; }
        // 正文已写进输入框、没有提交（Codex 编辑器回填后复核拒绝）：按「送达未确认」处理，不报失败、不提示重发（P2 返工 1 第 2 条）。
        if (result?.unconfirmed || (result && result.ok === false && result.written === true)) markUnconfirmed(team, batch, to, result.message || result.error || result.reason);
        else if (result && result.ok === false && result.notSent === true && await retryLater(team, batch, to, target, result)) { /* 已改回排队，稍后重发 */ }
        else {
          if (result && result.ok === false) throw Error(result.message || result.error || '未发送');
          batch.forEach(m => { m.state = 'sent'; m.sentAt = now(); });
          // 持久标记：消息列表会被裁剪，不能只靠它判断成员是否开始过对话。
          if (to !== LEAD && target.memberId !== LEAD) { const rec = (team.members || []).find(x => x.memberId === to); if (rec && !rec.everDelivered) rec.everDelivered = true; }
          if (to === LEAD) noteDeliverySent(team, batch);
        }
      } catch (error) {
        batch.forEach(m => { m.state = 'failed'; m.error = String(error.message || error).slice(0, 300); });
        if (to !== LEAD) enqueue(team, 'hub', LEAD, `发给 ${to} 的消息没送达：${String(error.message || error).slice(0, 200)}。内容保留，可用 status 查看后重发。`);
      } finally {
        sending.delete(lock);
        save(team);
        if ((team.messages || []).some(m => m.state === 'queued' && m.to === to)) setImmediate(() => flush(team).catch(() => {}));
      }
    }
  }
  // 交付消息进了负责人会话：从这一刻起等负责人处理完，再让该成员离队休眠（见 releaseDelivered）。
  function noteDeliverySent(team, batch) {
    for (const m of batch.filter(x => x.raceMembers)) for (const id of m.raceMembers) {
      const rec = (team.members || []).find(x => x.memberId === id);
      if (rec && rec.deliveredAt) rec.deliverSentAt = m.sentAt;
    }
    for (const m of batch.filter(x => x.deliver)) {
      const rec = (team.members || []).find(x => x.memberId === m.from);
      if (rec && rec.deliverMsgId === m.id) rec.deliverSentAt = m.sentAt;
    }
  }
  function leadSettleMs() {
    const configured = Number(getConfig()?.team?.leadSettleSeconds);
    return Number.isFinite(configured) && configured >= 0 ? configured * 1000 : LEAD_SETTLE_MS;
  }
  const oldestAt = items => Math.min(...items.map(m => Number(m.at) || now()));
  // 抄送和 Hub 的旁听通知（passive：成员排到名额、交付后离队）只是记录，自己不叫醒负责人，等下一次叫醒时顺带送达。
  function leadDue(items) {
    if (items.some(m => m.immediate)) return true;
    const wake = items.filter(m => m.wake !== false);
    if (wake.length) return now() - oldestAt(wake) >= leadSettleMs();
    const notes = items.filter(m => !m.copy && !m.passive);
    return notes.length >= NOWAKE_MAX_COUNT || (notes.length > 0 && now() - oldestAt(notes) >= NOWAKE_MAX_AGE_MS);
  }
  // 明确没写进对方输入框的消息：按 1/3/10 分钟退避重发；用完仍不行，给成员自动重启一次再重发一轮。
  async function retryLater(team, items, to, target, result) {
    const reason = String(result.message || result.error || '未发送').slice(0, 160);
    const tries = Math.max(...items.map(m => m.retries || 0));
    if (tries < RETRY_BACKOFF_MS.length) {
      for (const m of items) {
        m.retries = tries + 1; m.state = 'queued'; m.retryAt = now() + RETRY_BACKOFF_MS[tries];
        m.error = `${reason}；第 ${tries + 1} 次自动重发排在 ${Math.round(RETRY_BACKOFF_MS[tries] / 60000)} 分钟后`;
      }
      return true;
    }
    if (to === LEAD || items.some(m => m.restarted)) return false;
    // 30 分钟内同一成员只自动重启一次；刚重启过的，排在后面的消息也等重启后再试一轮。
    if (now() - (autoRestarted.get(target.sid) || 0) > RESTART_COOLDOWN_MS) {
      if (typeof restartSession !== 'function') return false;
      autoRestarted.set(target.sid, now());
      let ok = false;
      try { const r = await restartSession(target.sid, restartOverrides(team, target)); ok = r?.ok === true || (r?.id === target.sid && !!sessionManager.getSession(target.sid)); }
      catch (error) { logger.warn?.('[team] 自动重启失败', target.sid, error.message); }
      if (!ok) return false;
      enqueue(team, 'hub', LEAD, `${to} 连续 ${RETRY_BACKOFF_MS.length + 1} 次没能接收消息（${reason}），Hub 已自动重启它一次（${restartOverrides(team, target) ? '它还没开始过对话，按原配置重新首次启动' : '接着原会话历史'}），消息会在它就绪后重发。`, { wake: false });
    }
    for (const m of items) { m.restarted = true; m.retries = 0; m.state = 'queued'; m.retryAt = now() + RETRY_BACKOFF_MS[0]; m.error = `${reason}；已自动重启 ${to}，1 分钟后重发`; }
    return true;
  }
  function lastOutputAt(sid) {
    return typeof sessionManager.getGroupChatLastActivity === 'function' ? Number(sessionManager.getGroupChatLastActivity(sid)) || 0 : 0;
  }
  // 从没收到过确认送达的消息（开工消息也没进去）的 Claude 成员：预分配的原生 id 后面没有对话，
  // 重启/唤醒按原配置首次启动，而不是续接一个不存在的历史（续接会报「原生会话记录缺失」并永久起不来）。
  function neverStarted(team, member) {
    if (!member || member.memberId === LEAD) return false;
    const kind = String(sessionManager.getSession(member.sid)?.kind || member.kind || '');
    if (!/^claude(?:-resume)?$/.test(kind)) return false;
    const rec = (team.members || []).find(x => x.memberId === member.memberId);
    if (rec?.everDelivered) return false;
    return !(team.messages || []).some(x => x.to === member.memberId && x.state === 'sent' && x.via !== 'not-ai');
  }
  function restartOverrides(team, member) { return neverStarted(team, member) ? { claudeFirstLaunch: true } : null; }
  const alive = sid => { const st = sessionState(sid); return st !== 'missing' && st !== 'dormant'; };
  // 拉起离线/休眠的会话。冷却：前两次间隔 1 分钟，之后每 10 分钟最多一次；成功清零。
  async function revive(team, target, { force = false } = {}) {
    const sid = target?.sid;
    if (!sid || frozen || reviving.has(sid)) return false;
    if (alive(sid)) { revival.delete(sid); return true; }
    const rec = revival.get(sid) || { at: 0, failures: 0, error: '' };
    const gap = rec.failures >= REVIVE_ALERT_AFTER ? REVIVE_COOLDOWN_MS : WAKE_RETRY_MS;
    if (!force && rec.at && now() - rec.at < gap) return false;
    rec.at = now(); revival.set(sid, rec);
    reviving.add(sid);
    const firstLaunch = neverStarted(team, target);
    let ok = false, error = '';
    try {
      if (typeof wakeSession !== 'function') error = '当前 Hub 不支持自动拉起';
      else if ((await wakeSession(sid, firstLaunch ? { firstLaunch: true } : {})) === false) error = '侧栏里没有可恢复的记录（可能已被关闭）';
      else if (!alive(sid)) error = '拉起后会话仍未运行';
      else ok = true;
    } catch (e) { error = String(e?.message || e).slice(0, 160); logger.warn?.('[team] 自动拉起失败', sid, error); }
    finally { reviving.delete(sid); }
    if (ok) { revival.delete(sid); return true; }
    rec.failures += 1; rec.error = error;
    return false;
  }
  // Hub 重启后：在队且有排队消息、或上次处于运行中的负责人/成员，错峰自动拉起。
  function reviveAfterRestart() {
    load();
    const jobs = [];
    for (const team of teams.values()) {
      // 附带通知（passive，如「m3 已交付、已离队休眠」）和抄送只跟着下一批正式消息一起送，不单独发出：
      // 不能拿它们当拉起理由，否则旧负责人每次重启都被叫醒、消息又永远送不出（2026-11-19，5 个旧负责人反复复活占侧栏）。
      const queued = id => (team.messages || []).some(x => x.to === id && x.state === 'queued' && !x.passive && !x.copy);
      if (queued(LEAD) || team.leadLastState === 'running') jobs.push([team, memberById(team, LEAD)]);
      for (const m of team.members || []) {
        if (m.status !== 'active' || !m.sid || m.kind === 'powershell') continue;
        if (queued(m.memberId) || m.lastState === 'running') jobs.push([team, m]);
      }
    }
    jobs.forEach(([team, m], i) => schedule(() => {
      if (frozen) return;
      // 成员同样受同时干活上限约束；没轮上的，有消息排着就由投递循环在空出名额后叫醒。
      if (m.memberId !== LEAD && !m.manual && !canStart(team)) return;
      revive(team, m, { force: true }).then(ok => { if (ok) return flush(team); })
        .catch(error => logger.warn?.('[team] 重启后拉起失败', m.sid, error.message));
    }, STARTUP_REVIVE_DELAY_MS + i * STARTUP_STAGGER_MS));
    return jobs.length;
  }
  const memberList = ids => {
    const nums = ids.map(id => Number(String(id).slice(1))).filter(Number.isFinite).sort((a, b) => a - b);
    if (nums.length !== ids.length) return ids.join('、');
    const parts = [];
    for (let i = 0; i < nums.length;) {
      let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      parts.push(j - i >= 2 ? `m${nums[i]}–m${nums[j]}` : nums.slice(i, j + 1).map(n => 'm' + n).join('、'));
      i = j + 1;
    }
    return parts.join('、');
  };
  // 心跳巡检：只读、零 token。成员运行中却长时间无输出、离线且自动拉起失败、全队空转，就叫醒负责人说明。
  function watch() {
    const t = now();
    if (t - lastWatch < WATCH_MS) return;
    lastWatch = t;
    for (const team of teams.values()) {
      let changed = false;
      const offline = [], stalls = [];
      const leadRunning = sessionState(team.leadSid) === 'running';
      if ((team.leadLastState === 'running') !== leadRunning) { team.leadLastState = leadRunning ? 'running' : 'idle'; changed = true; }
      for (const m of team.members || []) {
        if (m.status === 'dismissed' && m.suspendPending) { suspendDismissed(team, m); continue; }
        if (m.status !== 'active' || !m.sid) continue;
        const state = sessionState(m.sid);
        if (state !== 'missing' && state !== 'dormant' && (m.lastState === 'running') !== (state === 'running')) { m.lastState = state === 'running' ? 'running' : 'idle'; changed = true; }
        const flagged = state !== 'missing' && state !== 'dormant' && !sessionManager.getSession(m.sid)?.runtimeBackend
          && sessionManager.isAgentTurnActive(m.sid);
        if (flagged) {
          const last = lastOutputAt(m.sid);
          if (!last || t - last < STALL_MS) { if (alerted.get(m.sid)?.kind === 'stall') alerted.delete(m.sid); continue; }
          const key = 'stall:' + last;
          if (alerted.get(m.sid)?.key === key) continue;
          alerted.set(m.sid, { kind: 'stall', key });
          stalls.push({ m, minutes: Math.round((t - last) / 60000) });
        } else if (state === 'missing' || state === 'dormant') {
          const waiting = (team.messages || []).filter(x => x.to === m.memberId && x.state === 'queued');
          if (!waiting.length) continue;
          const oldest = Math.min(...waiting.map(x => Number(x.at) || t));
          // 先由 Hub 自动拉起（投递循环在拉）；拉起失败够次数才提醒负责人。
          const rec = revival.get(m.sid);
          if (t - oldest < MISSING_ALERT_MS || !rec || rec.failures < REVIVE_ALERT_AFTER) continue;
          const key = 'missing:' + oldest;
          if (alerted.get(m.sid)?.key === key) continue;
          offline.push({ m, key, waiting: waiting.length, failures: rec.failures, error: rec.error });
        } else if (alerted.has(m.sid)) alerted.delete(m.sid);
      }
      // 同一次巡检里同类问题合并成一条，不一人一条。
      if (stalls.length === 1) {
        const { m, minutes } = stalls[0];
        enqueue(team, 'hub', LEAD, `${m.memberId}（${m.title}）显示在运行中，但已 ${minutes} 分钟没有任何终端输出，可能卡住；Hub 会照常把消息送进去。先看一眼它的会话，确认卡住再用 restart --member ${m.memberId}。`);
      } else if (stalls.length > 1) {
        const mins = stalls.map(x => x.minutes), lo = Math.min(...mins), hi = Math.max(...mins);
        enqueue(team, 'hub', LEAD, `${memberList(stalls.map(x => x.m.memberId))} 显示在运行中，但已 ${lo === hi ? lo : lo + '–' + hi} 分钟没有任何终端输出，可能卡住；Hub 会照常送消息。先看一眼它们的会话，确认卡住再逐个 restart --member <编号>。`);
      }
      if (offline.length) {
        for (const x of offline) alerted.set(x.m.sid, { kind: 'missing', key: x.key });
        const tries = Math.max(...offline.map(x => x.failures));
        const reason = offline.find(x => x.error)?.error;
        const ids = memberList(offline.map(x => x.m.memberId));
        enqueue(team, 'hub', LEAD, `${ids} 未能启动，Hub 已尝试自动拉起 ${tries} 次失败${reason ? '（' + reason.slice(0, 60) + '）' : ''}，${offline.reduce((n, x) => n + x.waiting, 0)} 条消息待送。可看侧栏或 restart --member <编号> 重试。`);
      }
      if (releaseDelivered(team, t)) changed = true;
      if (watchIdle(team, t)) changed = true;
      if (changed) save(team);
    }
  }
  // 全队空转：负责人与所有在队成员都空闲（含已休眠）超过 20 分钟、没有排队消息、团队未解散，提醒负责人一次。
  // 「同一段」以成员活动和非 Hub 消息为界：提醒后负责人自己的输出不算新的一段，避免每 20 分钟催一次。
  function watchIdle(team, t) {
    // hub 命令建的一次性会话不参加全队空转提醒：它的回复已经由 hub --watch 送回负责人（Codex 审查附带项）。
    const active = (team.members || []).filter(m => m.status === 'active' && m.sid && m.kind !== 'powershell' && m.via !== 'hub');
    if (!active.length || (team.plans || []).some(p => p.status === 'pending')) return false;
    if ((team.members || []).some(m => m.status === 'queued' || m.status === 'creating')) return false; // 还有人排队等名额
    if ((team.messages || []).some(m => !m.copy && !m.passive && (m.state === 'queued' || m.state === 'sending'))) return false;
    const idle = sid => ['idle', 'dormant'].includes(sessionState(sid));
    if (!idle(team.leadSid) || !active.every(m => idle(m.sid))) return false;
    const real = (team.messages || []).filter(m => m.from !== 'hub');
    const memberMark = Math.max(0, ...active.map(m => Math.max(lastOutputAt(m.sid), Number(m.joinedAt) || 0)),
      ...real.map(m => Math.max(Number(m.at) || 0, Number(m.sentAt) || 0)));
    const lastActive = Math.max(memberMark, lastOutputAt(team.leadSid));
    if (!lastActive || t - lastActive < IDLE_TEAM_MS || (team.idleAlertAt || 0) >= memberMark) return false;
    team.idleAlertAt = t;
    enqueue(team, 'hub', LEAD, `全队已空闲 ${Math.round((t - lastActive) / 60000)} 分钟，没有排队消息。请决定：继续派活（send），还是收尾（dismiss 成员）。`);
    return true;
  }
  function markUnconfirmed(team, items, to, error) {
    const warning = '可能已送达，请先核对对方会话再决定是否重发';
    for (const item of items) { item.state = 'unconfirmed'; item.error = error ? `${String(error).slice(0, 200)}；${warning}` : warning; }
    if (to !== LEAD) enqueue(team, 'hub', LEAD, `发给 ${to} 的消息${warning}。用 status 查看保留的正文。`);
  }
  // 对话里只放清单、文件路径和读法；原文一字不丢（团队状态照存全文，read --id 照常可用）。
  function leadInboxLimit() {
    const configured = Number(getConfig()?.team?.leadInboxChars);
    return Number.isFinite(configured) && configured > 0 ? configured : LEAD_INBOX_CHARS;
  }
    const leadQuietRule = () => `\n对${approver}：成员消息不逐条转述，只在里程碑、坏消息、要他拍板时汇报，先答他最近的问题或离总目标还差多少。其余处理完只回一行 ${NO_UPDATE_MARK}。`;
  // 每批末尾的固定说明 4 小时内只给一次全文，其余批次给一行（近 10 天这段说明重复了 5787 次，占团队消息的 16%）。
  const FOOTER_FULL_EVERY_MS = 4 * 60 * 60 * 1000;
  function leadFooter(team, full) {
    if (!team.leadFooterAt || now() - team.leadFooterAt >= FOOTER_FULL_EVERY_MS) { team.leadFooterAt = now(); return full; }
    return `（规则同前；无里程碑、坏消息或待拍板只回 ${NO_UPDATE_MARK}）`;
  }
  function leadBatchText(team, batch) {
    const footerBefore = team.leadFooterAt;
    const full = formatBatch(team, batch, LEAD);
    const total = batch.reduce((n, m) => n + String(m.text || '').length, 0);
    if (total <= leadInboxLimit()) return full;
    // 落盘的原文里带了说明不算数：负责人会话里实际收到的是下面这份索引，由它决定给全文还是一行（Codex 复审 2026-11-15）。
    team.leadFooterAt = footerBefore;
    const inbox = path.join(dir(), team.leadSid, 'inbox');
    const file = path.join(inbox, `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}-batch.md`);
    // 落盘失败（磁盘满、权限）就整批直送：宁可多占上下文，也不能让消息丢掉。
    try {
      fs.mkdirSync(inbox, { recursive: true });
      fs.writeFileSync(file, `# 团队消息原文 · ${batch.length} 条 · 共 ${total} 字\n\n${full}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error) { logger.warn?.('[team] 长批次落盘失败，改为整批直送', error.message); return full; }
    for (const m of batch) m.inboxFile = file;
    const who = id => (id === 'hub' ? 'Hub' : id === LEAD ? '负责人' : `${id} ${memberById(team, id)?.title || ''}`.trim());
    // 按发送方合并成一行（回放：逐条索引行占团队注入 5%）；没有短号的旧消息照列长编号。
    const bySender = new Map();
    for (const m of batch) { if (!bySender.has(m.from)) bySender.set(m.from, []); bySender.get(m.from).push(m); }
    const indexLines = [...bySender].map(([from, ms]) => {
      const kinds = from === 'hub' ? '' : ['汇报', '留言'].map(k => [k, ms.filter(m => (m.wake === false ? '留言' : '汇报') === k).length]).filter(([, n]) => n).map(([k, n]) => ` · ${k} ${n}`).join('');
      return `- [${who(from)}] ${ms.length} 条${kinds} · ${ms.reduce((n, m) => n + String(m.text || '').length, 0)} 字 · ${ms.map(ref).join('、')}`;
    });
    const codex = /^codex(?:-resume)?$/.test(String(sessionManager.getSession(team.leadSid)?.kind || ''));
    const howTo = codex
      ? `共 ${total} 字。有原生子 Agent 就派它读完只回结论，没有就分段读。`
      : `共 ${total} 字。2 万字以内自己按成员分段读，超过才派原生子 Agent；只看结论和要你处理的事。`;
    const cmd = commandPath();
    return [`【团队消息 · ${batch.length} 条 · 原文已存文件】`,
      ...indexLines,
      `原文：${file}`, howTo,
      leadFooter(team, cmdLine(cmd, ['回复 hub-team send --to <成员编号> --message "…"', '单条原文 hub-team read --id <短号数字>']) + leadQuietRule())].join('\n');
  }
  // 组队 skill 版本提醒：负责人只在开工时读一次 skill，之后改的规则它不知道。版本变了在下一批消息开头提醒一次。
  let skillCache = null;
  function currentSkillVersion() {
    if (!skillFile) return null;
    try {
      const stat = fs.statSync(skillFile);
      if (skillCache?.mtimeMs !== stat.mtimeMs) {
        const match = /^v(\d+(?:\.\d+)+) · (\d{4}-\d{2}-\d{2})：(.+)$/m.exec(fs.readFileSync(skillFile, 'utf8'));
        skillCache = { mtimeMs: stat.mtimeMs, info: match ? { version: 'v' + match[1], date: match[2], summary: match[3].trim().replace(/[。.]$/, '') } : null };
      }
      return skillCache.info;
    } catch { return null; }
  }
  function skillUpdateNote(team) {
    const info = currentSkillVersion();
    if (!info || team.skillVersionSeen === info.version) return null;
    // 首次见到：开工晚于该版本的负责人读的就是它，只记下不提醒。
    if (!team.skillVersionSeen && Date.parse(info.date + 'T23:59:59+08:00') < Number(team.createdAt || 0)) { team.skillVersionSeen = info.version; return null; }
    return { version: info.version, line: `组队 skill 已更新到 ${info.version}：${info.summary.slice(0, 120)}，请重读相关章节。` };
  }
  function formatBatch(team, batch, to) {
    const name = id => (id === 'hub' ? 'Hub' : id === LEAD ? '负责人' : `${id} ${memberById(team, id)?.title || ''}`.trim());
    // 抄送按交流双方合并，原消息编号全部保留；旧版抄送不猜关联，原样展示。
    const groups = new Map(), notices = [];
    for (const m of batch) {
      if (to === LEAD && m.copy && m.sourceId && m.copyTo) {
        const key = `${m.from}:${m.copyTo}`;
        if (!groups.has(key)) { const group = { items: [] }; groups.set(key, group); notices.push(group); }
        groups.get(key).items.push(m);
      } else notices.push({ items: [m] });
    }
    const named = new Set(); // 同一批里成员标题只在第一次出现时写全（回放：重复标题占团队注入约 6%）
    const tag = id => { if (id === 'hub' || id === LEAD || named.has(id)) return id === 'hub' || id === LEAD ? name(id) : id; named.add(id); return name(id); };
    const lines = notices.map(({ items }) => {
      const m = items[items.length - 1];
      const stamp = `${ref(m)} ${formatAbsoluteTime(m.at, now())}`;
      const text = items.length > 1
        ? `（抄送汇总）${m.from}→${m.copyTo} ${items.length} 条，最新：${m.text.replace(/^（抄送）[^：]*：/, '')}\n（只是最新一条的摘要，判断前读原文 ${items.map(srcRef).join('、')}）`
        : `${m.text}${m.sourceId ? '（原文 ' + srcRef(m) + '）' : ''}`;
      return `- [${tag(m.from)}${m.wake === false ? ' · 留言' : ''}] ${stamp}\n${text}`;
    });
    const cmd = commandPath();
    if (to === LEAD) return [`【团队消息 · ${notices.length} 条】`, ...lines, '',
      leadFooter(team, '普通告知无需回执。' + cmdLine(cmd, ['原文 hub-team read --id <短号数字>', '回复 hub-team send --to <成员编号> --message "…"', '全队 hub-team status']) + leadQuietRule())].join('\n');
    return [`【团队消息 · ${notices.length} 条】`, ...lines, '',
      `普通告知无需回执；处理旧消息先核对编号和当前任务。读完整原文：\`"${cmd}" read --id <短号数字>\`。`,
      `回复：\`"${cmd}" send --to ${batch[0].from === 'hub' ? LEAD : batch[0].from} --message "…"\`。`].join('\n');
  }
  async function interruptNow(team, item, target) {
    const lock = team.leadSid + ':' + item.to;
    sending.add(lock); item.state = 'sending'; save(team);
    try {
      const result = await injectPrompt(target.sid, `## 负责人追加指示（${item.id}）\n${item.text}\n\n按这条指示调整当前工作，不重做已完成的部分。`);
      if (result?.uncertain) markUnconfirmed(team, [item], item.to);
      else if (result?.accepted) { item.state = 'sent'; item.sentAt = now(); item.via = 'interrupt'; }
      else {
        item.state = 'failed'; item.error = result?.message || result?.error || '插话未发送';
        enqueue(team, 'hub', LEAD, `发给 ${item.to} 的消息没送达：${item.error}。用 status 查看保留的正文。`);
      }
    } catch (error) { markUnconfirmed(team, [item], item.to, error.message); }
    finally { sending.delete(lock); save(team); }
  }

  // ---- 其他动作 ----
  function status(callerSid) {
    const found = teamOfLead(callerSid) ? { team: teamOfLead(callerSid), member: { memberId: LEAD } } : teamOfMember(callerSid);
    if (!found) return { team: null, note: `你还不在任何团队里。当负责人：先用 accounts 看可用账号，再用 propose 提交招人计划，等${approver}批准。` };
    const { team, member } = found;
    const mine = (team.messages || []).filter(m => m.to === member.memberId || m.from === member.memberId);
    return {
      you: member.memberId, leadSid: team.leadSid,
      members: [{ memberId: LEAD, title: sessionManager.getSession(team.leadSid)?.title || '负责人', state: sessionState(team.leadSid) }]
        .concat((team.members || []).map(m => ({ memberId: m.memberId, title: m.title, role: m.role, kind: m.kind, account: m.account, ...(m.model ? { model: m.model } : {}), runtime: runtimeOf(m.sid), status: m.status,
          state: ['dismissed', 'queued'].includes(m.status) ? m.status : displayState(m.sid),
          ...(m.access === 'read' ? { access: 'read' } : {}),
          ...(m.worktree?.path ? { worktree: { path: m.worktree.path, branch: m.worktree.branch, base: m.worktree.base } } : m.worktree?.error ? { worktreeError: m.worktree.error } : {}),
          ...(displayState(m.sid) === 'error' && !['dismissed', 'queued'].includes(m.status) ? { error: `${runtimeIssue(m.sid).label}：${String(runtimeIssue(m.sid).message || '').slice(0, 200)}`, note: '先看 error 和终端最后一屏查原因，再 restart、换号或换后端补派' } : {}),
          ...(m.manual ? { manual: true } : {}), ...(m.deliveredAt ? { delivered: true } : {}), ...(m.dismissReason ? { dismissReason: m.dismissReason } : {}) }))),
      working: { cap: maxWorking(), machineCap: maxWorkingTotal(), memberCap: maxMembers(), memory: resourceStatus().memory || null, team: workingIn(team).map(m => m.memberId), machine: workingTotal(),
        queued: (team.members || []).filter(m => m.status === 'queued').map(m => m.memberId),
        ...(workingElsewhere(team).length ? { elsewhere: workingElsewhere(team) } : {}) },
      plans: member.memberId === LEAD ? (team.plans || []).map(p => ({ id: p.id, status: p.status, size: p.members.length, note: p.note || '' })) : undefined,
      grants: team.grants,
      pendingForYou: mine.filter(m => m.to === member.memberId && m.state === 'queued').map(m => ({ id: m.id, ...(m.seq ? { seq: m.seq } : {}), at: m.at, from: m.from, text: m.text, sourceId: m.sourceId, bodyPath: m.bodyPath, wake: m.wake !== false })),
      undelivered: mine.filter(m => m.from === member.memberId && ['queued', 'failed', 'unconfirmed'].includes(m.state)).map(m => ({ id: m.id, to: m.to, state: m.state, text: m.text.slice(0, 200), error: m.error || '' })),
    };
  }
  function runtimeOf(sid) {
    const s = sessionManager.getSession(sid);
    if (!s) return null;
    return { source: 'Hub 会话登记值，未独立核验 CLI 实际生效配置',
      account: s.codexProfile || s.claudeProfile || s.antigravityProfile || s.codeagentPoolAccount || null, model: s.currentModel?.id || s.model || null,
      effort: s.effort || null, cwd: s.cwd || null,
      lastOutputMinAgo: lastOutputAt(sid) ? Math.floor((now() - lastOutputAt(sid)) / 60000) : null };
  }
  async function restart(callerSid, args) {
    if (frozen) throw Error('Hub 正在关闭');
    const team = teamOfLead(callerSid);
    if (!team) throw Error('只有负责人能重启成员');
    const m = memberById(team, String(args.memberId || ''));
    if (!m || m.memberId === LEAD) throw Error('memberId 写成员编号');
    const fresh = neverStarted(team, m);
    // 已离线/休眠的成员没有可重启的进程：按自动拉起的同一条路径拉起（从没开始过对话的按首次启动）。
    if (!alive(m.sid)) {
      if (!(await revive(team, m, { force: true }))) throw Error(`没能拉起 ${m.memberId}：${revival.get(m.sid)?.error || '原因未知'}`);
      setImmediate(() => flush(team).catch(() => {}));
      return { ok: true, note: fresh ? '已按原配置首次启动；排队的消息会自动补送。' : '已拉起（接着原会话历史）；排队的消息会自动补送。' };
    }
    if (typeof restartSession !== 'function') throw Error('当前 Hub 不支持重启成员');
    const result = await restartSession(m.sid, restartOverrides(team, m));
    if (result?.ok === false || result?.error) throw Object.assign(Error(result.message || result.error || '重启失败'), { code: result.error });
    if (result?.ok !== true && !(result?.id === m.sid && sessionManager.getSession(m.sid))) throw Error('Hub 未确认会话已重启');
    return { ok: true, note: fresh ? '它还没开始过对话：已按原配置重新首次启动，排队的开工消息会自动补送。' : '已重启（接着原会话历史）；需要的话再 send 一条让它继续。' };
  }
  function dismiss(callerSid, args) {
    const team = teamOfLead(callerSid);
    if (!team) throw Error('只有负责人能让成员离队');
    const id = String(args.memberId || '');
    const waiting = (team.members || []).find(x => x.memberId === id && x.status === 'queued');
    if (waiting) {
      // 还在排队的：没有会话，直接撤掉名额。
      waiting.status = 'dismissed'; waiting.dismissedAt = now(); waiting.dismissReason = 'queued-cancelled';
      save(team);
      return { ok: true, suspended: false, note: `${id} 还没开工，已从排队里撤掉。` };
    }
    const m = memberById(team, id);
    if (!m || m.memberId === LEAD) throw Error('memberId 写成员编号');
    m.status = 'dismissed'; m.dismissedAt = now(); m.suspendPending = true;
    team.grants = team.grants.filter(g => !g.split(':').includes(m.memberId));
    const suspended = suspendDismissed(team, m);
    save(team);
    return { ok: true, suspended, note: suspended
      ? `已离队并休眠：进程已退出、内存已释放，会话保留在侧栏，${approver}点开即可恢复。`
      : `已离队：不再收发团队消息；它手头这一轮结束后 Hub 会自动休眠它，会话保留在侧栏，${approver}可以自己关闭。` };
  }
  // 由心跳每分钟再试，空下来就休眠；会话本身保留，点开即恢复。
  function suspendDismissed(team, m) {
    if (!m.sid || !sessionManager.getSession(m.sid) || sessionManager.getSession(m.sid).status === 'dormant') { delete m.suspendPending; return false; }
    if (typeof sessionManager.suspendSession !== 'function') { delete m.suspendPending; return false; }
    let result;
    const reason = m.dismissReason === 'delivered' ? 'team-delivered' : 'team-dismissed';
    try { result = sessionManager.suspendSession(m.sid, { reason, excludeFocused: true, excludePinned: true }); }
    catch (error) { logger.warn?.('[team] 离队休眠失败', m.sid, error.message); return false; }
    if (result?.ok) { delete m.suspendPending; delete m.suspendError; m.suspendedAt = now(); save(team); return true; }
    const error = result?.error || 'unknown';
    if (m.suspendError !== error) { m.suspendError = error; save(team); }
    if (!['pty-turn-unfinished', 'native-turn-unfinished', 'native-session-id-missing', 'suspend-pending', 'focused'].includes(error)) { delete m.suspendPending; save(team); }
    return false;
  }
  // 交付即收工（2026-11-09）：成员 --deliver 的交付消息已送进负责人会话、负责人这一轮处理完（不在运行）且过了
  // RELEASE_AFTER_ACK_MS，又没再给它派活、它自己也停下了 → 离队并休眠。负责人之后再 send 给它，Hub 叫回原会话。
  function raceDir(team, plan) { return path.join(dir(), 'race', team.leadSid, plan.id); }
  // 赛马交齐了就出成绩单（重启后 scoring 状态会重做一次）。
  // 2026-11-25 后台开销：getConfig 每次同步读整份 config.json。先按赛马/状态/出分中筛掉历史计划，
  // 只有仍要判断的赛马才取掉队时限；一轮心跳的所有团队共用一份（raceCtx），下一轮再取最新值。
  function raceStragglerCtx() {
    let ms = null;
    return () => ms ?? (ms = Math.max(1, Number(getConfig()?.team?.raceStragglerMinutes) || TeamRace.STRAGGLER_MS / 60000) * 60000);
  }
  function checkRaces(team, stragglerOf = raceStragglerCtx()) {
    for (const plan of team.plans || []) {
      if (!plan.race || plan.status !== 'approved' || plan.raceState === 'done' || scoring.has(plan.id)) continue;
      const stragglerMs = stragglerOf();
      if (!TeamRace.ready(team, plan, { now: now(), stragglerMs })) continue;
      const late = TeamRace.stragglers(team, plan).map(m => m.memberId);
      scoring.add(plan.id); plan.raceState = 'scoring'; save(team);
      TeamRace.score({ team, plan, dir: raceDir(team, plan) }).then(({ file, rows }) => {
        plan.raceState = 'done'; plan.raceCard = file;
        const racers = TeamRace.planMembers(team, plan).filter(m => m.raceDeliveryPath).map(m => m.memberId);
        enqueue(team, 'hub', LEAD, TeamRace.leadMessage({ plan, file, rows, cmd: commandPath(), late, stragglerMin: stragglerMs / 60000 }), { wake: true, immediate: true, raceMembers: racers });
      }).catch(error => logger.warn?.('[team] 赛马成绩单失败', error.message)).finally(() => scoring.delete(plan.id));
    }
  }
  function releaseDelivered(team, t) {
    const released = [];
    for (const m of team.members || []) {
      if (m.status !== 'active' || !m.deliveredAt || !m.deliverSentAt || t - m.deliverSentAt < RELEASE_AFTER_ACK_MS) continue;
      if (sessionState(team.leadSid) === 'running') continue;
      if ((team.messages || []).some(x => x.to === m.memberId && (x.state === 'queued' || x.state === 'sending'))) continue;
      if (sessionState(m.sid) === 'running') continue;
      m.status = 'dismissed'; m.dismissedAt = t; m.dismissReason = 'delivered'; m.suspendPending = true;
      for (const key of ['deliveredAt', 'deliverMsgId', 'deliverSentAt']) delete m[key];
      team.grants = (team.grants || []).filter(g => !g.split(':').includes(m.memberId));
      suspendDismissed(team, m);
      released.push(m.memberId);
    }
    if (!released.length) return false;
    enqueue(team, 'hub', LEAD, `${memberList(released)} 已交付，已离队休眠；要返工直接 send 给它，Hub 叫回原会话。`, { wake: false, passive: true });
    return true;
  }

  async function invoke(callerSid, action, args = {}) {
    if (!safeSid(callerSid) || !sessionManager.getSession(callerSid)) throw Error('调用者不是本 Hub 的会话（缺 CLAUDE_HUB_SESSION_ID）');
    switch (action) {
      case 'status': return status(callerSid);
      case 'accounts': return accounts();
      case 'propose': return propose(callerSid, args);
      case 'send': return send(callerSid, args);
      case 'read': return read(callerSid, args);
      case 'allow': return allow(callerSid, args);
      case 'restart': return restart(callerSid, args);
      case 'dismiss': return dismiss(callerSid, args);
      case 'pass': if (!memberGuard) throw Error('成员权限守卫没有启动'); return memberGuard.pass(callerSid, args);
      default: throw Error('未知动作；可用：status / accounts / propose / send / read / allow / pass / restart / dismiss');
    }
  }

  function tick() {
    if (frozen) return;
    try { watch(); } catch (error) { logger.warn?.('[team] 心跳巡检失败', error.message); }
    const stragglerOf = raceStragglerCtx();
    for (const team of teams.values()) { try { checkRaces(team, stragglerOf); } catch (error) { logger.warn?.('[team] 赛马巡检失败', error.message); } }
    if ([...teams.values()].some(t => (t.members || []).some(m => m.status === 'queued'))) fillSlots().catch(() => {});
    for (const team of teams.values()) flush(team).catch(error => logger.warn?.('[team] 投递失败', error.message));
  }
  function start() {
    load();
    if (!timer) { timer = setInterval(tick, TICK_MS); timer.unref?.(); reviveAfterRestart(); }
  }
  function stop() { clearInterval(timer); timer = null; }

  // 不点名账号的后端（千问、智谱、Kimi、DeepSeek 等）：给出 Hub 新建会话的默认模型，供负责人写计划时参考。
  function otherKinds() {
    const config = getConfig();
    return KINDS.filter(k => !ACCOUNT_KINDS.includes(k) && k !== 'powershell' && require('../../core/distribution').kindAllowed(k)).map(kind => {
      let model = null; try { model = creationDefaults(kind, config).model || null; } catch {}
      return { kind, label: AI_KINDS.getKindLabel(kind), defaultModel: model, account: '不点名账号，沿用 Hub 新建会话的默认配置' };
    });
  }
  function accounts() {return company ? {...listAccounts(),note:'id 填进计划 account，model 从该账号 models 清单选择；省略 model 沿用账号设置。用户在批准时可改账号和模型。'} : {...listAccounts(),otherKinds:otherKinds(),note:'kind=claude 用 claude.rows，kind=codex 用 codex.rows，kind=gemini（Antigravity，也可写 antigravity / agy）用 gemini.rows；rows 兼容旧版，仅含 Claude。account 填 id，也可写看板标签或「账号2」；留空跟随 Hub 默认账号；plenty=true 表示余量充足。其余后端见 otherKinds（qwen / glm / kimi / deepseek-acp 等）：不写 account，沿用 Hub 新建会话的默认配置；codeagent 只在公司版可用。不写 model/effort 用 Hub 默认模型与思考深度；用户点名时写进成员的 model（如 claude-opus-5-5、gpt-6.1-sol、gemini-4-neon-high；其他后端的可选模型用 hub models 查）和 effort，速度档仍用默认。负责人计划按用户规则自动批准（额度读不到只提醒不拦；点名号不存在、风控、耗尽会当场失败、不留待批单），10 分钟内重交相同计划只回原结果。order 使用统一规则：排除风控、异常、耗尽，Pro 充足优先，其次 5X；同等先会话少，再 7d 快重置。'};}
  function setLineageGuard(guard) { lineageGuard = guard || null; }
  function setMemberGuard(guard) { memberGuard = guard || null; }
  return { start, stop, invoke, decide, accounts, listTeams, attachMember, adoptHubChild, setLineageGuard, setMemberGuard, registerLead, leadOptions, teamOfLead, teamOfMember, notifyLead, flush: lead => { const t = teamOfLead(lead); return t ? flush(t) : null; },
    freeze: () => { frozen = true; }, unfreeze: () => { frozen = false; }, watch: () => { lastWatch = 0; watch(); }, tick, reviveAfterRestart, fillSlots };
}

module.exports = { createTeamService, isUrgent, MAX_MEMBERS, MAX_WORKING_MEMBERS, MAX_WORKING_TOTAL, RELEASE_AFTER_ACK_MS, NOTICE_LIMIT, LEAD_INBOX_CHARS };
