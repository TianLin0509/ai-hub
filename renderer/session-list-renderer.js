// 纯函数：按最新 AI 回答时间年龄分桶。pinned 永远进 recent（置顶不折叠）。
//   recent: <24h（保持现状 UI 置顶）· mid: 24-72h · old: ≥72h
const { isGroupChatMemberRunning } = require('../core/groupchat-running-state.js');
// 负责人组队的侧栏标签与批准弹窗（renderer/team-ui.js）随侧栏一起加载：只在真实界面里加载，单测的无 DOM 环境跳过。
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__teamUi) {
  try { require('./team-ui.js'); } catch (error) { console.warn('[team-ui] 未加载：', error && error.message); }
}
const { getMeetingUnreadMemberIds } = require('./meeting-unread');
// 独立挂载，避免修改 renderer.js / index.html 的在途改动。
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__btwAskUi) {
  const mountBtwAsk = () => { try { require('./btw-ask-ui').mountBtwAskUi(window); } catch (error) { console.warn('[btw-ask-ui] 未加载：', error.message); } try { require('./concise-view').mountConciseView(window); } catch (error) { console.warn('[concise-view] 未加载：', error.message); } };
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') document.addEventListener('DOMContentLoaded', mountBtwAsk, { once: true });
  else mountBtwAsk();
}
const { compareLatestActivityDesc, latestActivityTime } = require('../core/session-recency.js');
const {
  sessionHasCompletedUnread,
} = require('../core/session-attention-state.js');
const { sessionRuntimeIssue } = require('../core/session-runtime-issue.js');
const { KIND_LABELS, ALL_AI_KINDS } = require('../core/ai-kinds.js');
const { sessionDisplayTitle } = require('../core/session-title-guards.js');
// 右下角「国内正常 / 异常」只关 Kimi / DeepSeek 这类直连的国内 AI；发行版里一个都没有（公司纯净版只有 CodeAgent）就不显示
// （2026-10-13 用户要求删掉）。
const DOMESTIC_ROUTE_KINDS = ['kimi', 'deepseek', 'deepseek-acp', 'deepseek-claude'];
function showDomesticRoute(kindAllowed = require('../core/distribution').kindAllowed) {
  return DOMESTIC_ROUTE_KINDS.some(kind => kindAllowed(kind));
}
const {createSessionProjectionCache,createSidebarClassifier,compareSidebarPlacement,sortBySidebarPlacement,sidebarItemClassification,isPinnedToBottom,sidebarItemHasUnread,isSidebarMemberWorking,partitionSidebarSessions,_meetingRuntimeAggregate,buildSidebarView}=require('../core/session-sidebar-state');
const {sidebarRelativeTime}=require('./sidebar-relative-time');
const { sidebarMustStayVisible, sidebarCompletedAndStale, sidebarHiddenNeedsUser } = require('../core/sidebar-auto-collapse');
const {createSessionViewPublisher}=require('../core/hub-assistant/session-state');
const {reconcileSidebarDom}=require('./sidebar-dom-reconciler');
const {
  RUNTIME_STARTING,
  RUNTIME_RUNNING,
  RUNTIME_WAITING,
  RUNTIME_DORMANT,
  RUNTIME_UNKNOWN,
  getSessionRuntimeTruth,
  runtimeTruthSummary,
  sessionRuntimeIsActive,
} = require('../core/session-runtime-truth.js');

function partitionSessionsByAge(items, now) {
  const DAY = 86400000;
  const recent = [], mid = [], old = [];
  for (const s of items || []) {
    const t = latestActivityTime(s, now);
    const age = now - t;
    if (s.pinned || age < DAY) recent.push(s);
    else if (age < 3 * DAY) mid.push(s);
    else old.push(s);
  }
  return { recent, mid, old };
}

// --- 侧栏 AI 家族筛选 ---
// 家族由 kind（哪个 CLI）决定，模型只是家族内部的选择：Opus / Fable / Sonnet 都是
// Claude CLI 起的会话，GPT 各版本都是 Codex CLI 起的。所以按 kind 分族，与用户
// 心里的「这是 Claude 还是 Codex」完全对得上，不需要再解析 currentModel。
// 各家模型独立筛选；同品牌的不同后端合并，选项随支持的 AI 注册表扩展。
const SESSION_FAMILY_TABS = [
  { key: 'all', label: '模型' },
  ...[...new Set(['claude','codex',...ALL_AI_KINDS].map(familyOfKind))]
    .filter(key=>ALL_AI_KINDS.some(kind=>familyOfKind(kind)===key && require('../core/distribution').kindAllowed(kind)))
    .map(key=>({key,label:KIND_LABELS[key] || key})),
  { key: 'other', label: '其他' },
];
const SESSION_FAMILY_KEYS = SESSION_FAMILY_TABS.map(tab => tab.key);

// --- Agent 自建会话的分组收纳 ---------------------------------------------
// 用户平时不需要在列表里逐个看到它们（要用时点开一个就够）。混在人工会话里
// 会把「最近」那一段挤没，侧栏就失去了可读性。
//
// 按 purpose 分组，加新的 Agent 系统时只在这张表里加一行，不改渲染逻辑。
// 注意 xresearch-research 不在这里：它在下面的基础过滤里本来就被完全排除，
// 属于「永远不进侧栏」，而不是「可收可展」。
const AGENT_SESSION_GROUPS = [
];
const AGENT_GROUP_KEYS = AGENT_SESSION_GROUPS.map(g => g.key);
const AGENT_PURPOSE_TO_GROUP = new Map();
for (const g of AGENT_SESSION_GROUPS) {
  for (const p of g.purposes) AGENT_PURPOSE_TO_GROUP.set(p, g.key);
}
function agentGroupOf(session) {
  return AGENT_PURPOSE_TO_GROUP.get(String(session && session.purpose || '')) || '';
}

function familyOfKind(kind) {
  const base = String(kind || '').replace(/-resume$/, '');
  if (/^deepseek(?:-(?:acp|claude|legacy))?$/.test(base)) return 'deepseek';
  return ALL_AI_KINDS.includes(base) ? base : 'other';
}

// 返回条目所属的家族集合。群聊按成员归属，可以同时属于多个家族——混合群聊只算
// 一个家族的话，切到另一个页签时它会凭空消失，而它确实有那边的成员在跑。
function sessionFamilies(item, sessionMap) {
  if (!item) return new Set();
  if (!item._isMeeting) {
    const families = new Set([familyOfKind(item.kind)]);
    const ids = typeof window !== 'undefined' ? window.__teamUi?.membersOf(item.id, sessionMap) || [] : [];
    for (const id of ids) {
      const member = sessionMap?.get(id);
      if (member) families.add(familyOfKind(member.kind));
    }
    return families;
  }
  const ids = (item._meeting && item._meeting.subSessions) || [];
  const families = new Set();
  for (const id of ids) {
    const sub = sessionMap && typeof sessionMap.get === 'function' ? sessionMap.get(id) : null;
    if (sub) families.add(familyOfKind(sub.kind));
  }
  // 成员还没同步进 map 的新群聊不能凭空消失，落到「其他」保底可见。
  if (families.size === 0) families.add('other');
  return families;
}

// Search reads the sidebar's live catalogue, scoped to its document.
const sidebarSources = new WeakMap();
function getSidebarSearchEntries(doc) {
  return sidebarSources.get(doc)?.() || [];
}

function isWirelessSession(item) {
  // Stable purpose survives renaming. The title prefix also covers older
  // workbench records without purpose; unrelated wireless discussions stay.
  return item?.purpose === 'wireless-proposal';
}
// 点亮后只看这些；平时普通列表里不出现，不挤占自己开的会话。
// 2026-11-13 领域助理（desks）机制删除：旧的 hub-assistant-desk 会话不再算助理会话，按普通会话显示。
const ASSISTANT_PURPOSES = new Set(['hub-assistant', 'hub-assistant-task', 'hub-photo-assistant']);
function isAssistantSession(item) {
  return ASSISTANT_PURPOSES.has(String(item?.purpose || '')) || isWirelessSession(item);
}

function isSideSession(item) {
  return false;
}
// 助理不进普通分组，单独放在最上面的「助理」一栏，不受筛选影响；有多个（换代留下的旧助理）时只放最新的。
const RESIDENT_PURPOSE = 'company-assistant';
function companyAssistantOn() {
  try { return require('../core/company-assistant/gate').companyAssistantEnabled(); } catch { return false; }
}

function isCompanyEdition() {
  try { return require('../core/distribution').target === 'company'; } catch { return false; }
}

function createSessionListRenderer(options = {}) {
  const { detailsHtml } = require('./session-details.js');
  const doc = options.document || document;
  const storage = options.localStorage || localStorage;
  const bridgeBadge = typeof options.bridgeBadge === 'function' ? options.bridgeBadge
    : id => { try { return (typeof window !== 'undefined' && window._bridgeThreads?.badge(id)) || null; } catch { return null; } };
  doc.addEventListener?.('bridge-threads-updated', () => { try { renderSessionList(); } catch (error) { console.warn('[session-list] bridge refresh failed:', error && error.message); } });
  // CodeAgent 会话的账号字母（renderer/session-account-badge.js）：账号表取到或登录变化后重画会话栏。
  const subscriptionAccount = typeof options.subscriptionAccount === 'function' ? options.subscriptionAccount : () => null;
  const accountBadge = typeof options.accountBadge === 'function' ? options.accountBadge : (() => {
    const ipc = options.ipcRenderer || (typeof process !== 'undefined' && process.type === 'renderer' ? require('electron').ipcRenderer : null);
    if (!ipc || typeof ipc.invoke !== 'function') return () => null;
    const badges = require('./session-account-badge').createAccountBadges({
      invoke: (channel, payload) => ipc.invoke(channel, payload),
      subscribe: typeof ipc.on === 'function' ? fn => ipc.on('codeagent-pool:changed', (_event, change) => fn(change)) : null,
      onChange: () => { try { renderSessionList(); } catch (error) { console.warn('[session-list] account refresh failed:', error && error.message); } },
    });
    return s => { try { return badges.badge(s); } catch { return null; } };
  })();
  const publishSessionViews=createSessionViewPublisher(packet=>{
    const ipc=options.ipcRenderer || (typeof process!=='undefined'&&process.type==='renderer'?require('electron').ipcRenderer:null);
    ipc?.send?.('assistant:session-view',packet);
  });
  const classifySession = createSidebarClassifier();
  const cacheMeetingItem = createSessionProjectionCache();
  const cachePresentation = createSessionProjectionCache();
  let previousSidebarView = null;
  let previousPresentation = null;
  // 方案 A：分组标题只剩「项目」「零碎」两个可折叠（旧的 异常 / 活跃 / 今天 记录读进来时丢掉）。
  const sectionKeys = ['sec-projects', 'sec-scraps'];
  let collapsedSections = new Set();
  let recentDays = 1;
  let pinnedOnly = false;
  // 「网页」分组（2026-10-25）：点亮后侧栏换成 AI 网页会话列表（renderer/web-sessions-ui.js），普通会话列表收起。
  let webOnly = false;
  let modelFilter = 'all';
  let assistantOnly = false;
  const sideMode = false;
  let sideOnly = false;
  try {
    const saved = JSON.parse(storage.getItem('hubSidebarCollapsedSections') || '[]');
    if (Array.isArray(saved)) collapsedSections = new Set(saved.filter(key => sectionKeys.includes(key)));
    const days = Number(storage.getItem('hubSidebarRecentDays'));
    if ([1, 3].includes(days)) recentDays = days;
    pinnedOnly = storage.getItem('hubSidebarRange') === 'pinned';
    webOnly = storage.getItem('hubSidebarRange') === 'web';
    const model = storage.getItem('hubSidebarModelFilter');
    if (SESSION_FAMILY_KEYS.includes(model)) modelFilter = model;
  } catch (error) { console.warn('[sidebar] preferences could not be read:', error.message); }
  function savePreference(key, value) {
    try { storage.setItem(key, value); }
    catch (error) { console.warn('[sidebar] preference could not be saved:', error.message); }
  }
  // 被折叠的会话出错、在跑、等你或有未读时照常显示；重新干起活来（在跑）就自动解除折叠。
  let foldedIds = new Set();
  try { const saved = JSON.parse(storage.getItem('hubSidebarFoldedIds') || '[]'); if (Array.isArray(saved)) foldedIds = new Set(saved.filter(id => typeof id === 'string')); }
  catch (error) { console.warn('[sidebar] folded sessions could not be read:', error.message); }
  const saveFolded = () => savePreference('hubSidebarFoldedIds', JSON.stringify([...foldedIds]));
  function foldHides(item, c) {
    if (!item || !foldedIds.has(item.id)) return false;
    if (c.working) { foldedIds.delete(item.id); saveFolded(); return false; }
    return !(c.error || c.waiting || c.unread);
  }
  // 只在运行、等输入、待批准、出错时临时露出，处理完回到隐藏；要彻底恢复用右键或搜索里的「取消隐藏」。
  let hiddenIds = new Set();
  try { const saved = JSON.parse(storage.getItem('hubSidebarHiddenIds') || '[]'); if (Array.isArray(saved)) hiddenIds = new Set(saved.filter(id => typeof id === 'string')); }
  catch (error) { console.warn('[sidebar] hidden sessions could not be read:', error.message); }
  function hiddenNeedsUser(item, classify, sessionMap) {
    const teamUi = typeof window !== 'undefined' ? window.__teamUi : null;
    return sidebarHiddenNeedsUser(item, classify(item), {
      pending: !item._isMeeting && !!(teamUi?.planPending?.(item.id) || teamUi?.queuedCount?.(item.id) > 0),
    }) || (!!item._isMeeting && (item._meeting?.subSessions || []).some(id => sessionMap.has(id) && hiddenNeedsUser(sessionMap.get(id), classify, sessionMap)));
  }
  function isHiddenNow(item, classify, sessionMap) {
    if (!item || !hiddenIds.has(item.id) || hiddenNeedsUser(item, classify, sessionMap)) return false;
    const teamUi = typeof window !== 'undefined' ? window.__teamUi : null;
    const members = item._isMeeting ? [] : teamUi?.membersOf?.(item.id, sessionMap, getMeetings()) || [];
    return !members.some(id => sessionMap.has(id) && hiddenNeedsUser(sessionMap.get(id), classify, sessionMap));
  }
  const rangeControls = [...(doc.querySelectorAll?.('[data-session-days]') || [])];
  function syncRangeControls() {
    for (const button of rangeControls) button.setAttribute('aria-pressed', String(!(assistantOnly && !sideMode) && (webOnly ? button.dataset.sessionDays === 'web' : pinnedOnly ? button.dataset.sessionDays === 'pinned' : Number(button.dataset.sessionDays) === recentDays)));
    doc.body?.classList?.toggle('sidebar-web-mode', webOnly);
  }
  syncRangeControls();
  const wirelessControl = doc.getElementById?.('btn-sidebar-wireless');
  let sideUnlocked = false;
  function syncSideVisibility() { if (isCompanyEdition() && wirelessControl) { wirelessControl.hidden = true; wirelessControl.style && (wirelessControl.style.display = 'none'); } }
  if (!sideMode && wirelessControl) { wirelessControl.hidden = true; wirelessControl.style && (wirelessControl.style.display = 'none'); }
  function syncWirelessControl() {
    if (sideMode) {
      wirelessControl?.setAttribute('aria-pressed', String(sideOnly));
      return;
    }
    wirelessControl?.setAttribute('aria-pressed', String(assistantOnly));
        wirelessControl?.setAttribute('title', assistantOnly ? '正在只看助理及助理派生的会话；点「置顶 / 今天 / 3 天」回到自己的会话' : '只看助理及助理派生的会话（前台、领域助理和它们的成员）');
  }
  syncSideVisibility();
  syncWirelessControl();
  wirelessControl?.addEventListener('click', () => {
    if (sideMode) {
      sideOnly = !sideOnly;
    } else {
      assistantOnly = true; webOnly = false;
      savePreference('hubSidebarAssistantOnly', 'true');
      if (storage.getItem?.('hubSidebarRange') === 'web') savePreference('hubSidebarRange', String(recentDays));
    }
    syncWirelessControl(); syncRangeControls(); renderSessionList();
  });
  // 只有换班 / 换后端留下的旧前台不进列表（当前前台单独置顶）——除非它还带着成员，照旧当项目显示（2026-11-15 Codex 复审）。
  const sideFilterPasses = item => sideMode ? isSideSession(item) === sideOnly
        : (item.purpose !== 'hub-assistant'
      || !!(typeof window !== 'undefined' && window.__teamUi?.membersOf(item.id, getSessions(), getMeetings())?.length));
  for (const button of rangeControls) button.addEventListener('click', () => {
    webOnly = button.dataset.sessionDays === 'web';
    if (assistantOnly && !sideMode) { assistantOnly = false; savePreference('hubSidebarAssistantOnly', 'false'); syncWirelessControl(); }
    pinnedOnly = button.dataset.sessionDays === 'pinned';
    if (!pinnedOnly && !webOnly) recentDays = Number(button.dataset.sessionDays) === 3 ? 3 : 1;
    savePreference('hubSidebarRange',webOnly ? 'web' : pinnedOnly ? 'pinned' : String(recentDays));
    savePreference('hubSidebarRecentDays', String(recentDays));
    syncRangeControls(); renderSessionList();
  });
  function sidebarView(items, sessionMap = getSessions(), days = recentDays, { now = Date.now(), classify = null } = {}) {
    // Membership/order still comes from the live filters. Reuse only the pure
    // partition/sort projection; rows, badges, details and DOM reconciliation
    // continue to read live data on every render. Time buckets are explicit so
    // a quiet session still crosses the 24/72-hour boundary without an event.
    let inputs = null;
    if (classify) {
      inputs = items.map(item => {
        const at = latestActivityTime(item), age = at ? now - at : 0;
        return { item, id: item.id, pinned: item.pinned, bottomed: item.bottomed,
          at, createdAt: item.createdAt, classification: classify(item),
          fresh: age < 86400000, inRange: age < (days === 3 ? 3 : 1) * 86400000 };
      });
      const previous = previousSidebarView;
      if (previous && previous.days === days && previous.pinnedOnly === pinnedOnly && previous.assistantOnly === assistantOnly && inputs.length === previous.inputs.length
          && inputs.every((input, i) => {
            const old = previous.inputs[i], a = input.classification, b = old.classification;
            return input.item === old.item && input.id === old.id && input.pinned === old.pinned && input.bottomed === old.bottomed
              && input.at === old.at && input.createdAt === old.createdAt && input.fresh === old.fresh && input.inRange === old.inRange
              && (a === b || (a.state === b.state && a.dormant === b.dormant && a.waiting === b.waiting
                && a.error === b.error && a.working === b.working && a.unread === b.unread));
          })) return previous.result;
    }
    const parts = partitionSidebarSessions(items, { now, classify, sessionMap, activeSessionId: getActiveSessionId(), activeMeetingId: getActiveMeetingId() });
    const assistantView = assistantOnly && !sideMode;
    const result = buildSidebarView(parts, { now, days: assistantView ? 3 : days, pinnedOnly: pinnedOnly && !assistantView, excludePinned: !pinnedOnly && !assistantView, sessionMap,
      hasUnread: classify ? item => classify(item).unread : sidebarItemHasUnread });
    if (inputs) previousSidebarView = { inputs, days, pinnedOnly, assistantOnly, result };
    return result;
  }
  const modelControl = doc.getElementById?.('session-model-filter');
  if (modelControl) {
    modelControl.innerHTML = SESSION_FAMILY_TABS.map(tab=>`<option value="${tab.key}">${tab.label}</option>`).join('');
    // 发行版裁掉了某个家族（公司版没有 Claude / Codex）而偏好里还存着它：退回「全部」，免得侧栏空着。
    const options = [...(modelControl.options || [])];
    if (options.length && !options.some(option => option.value === modelFilter && !option.hidden)) modelFilter = 'all';
    modelControl.value = modelFilter;
    modelControl.addEventListener('change', () => {
      modelFilter = SESSION_FAMILY_KEYS.includes(modelControl.value) ? modelControl.value : 'all';
      savePreference('hubSidebarModelFilter', modelFilter);
      renderSessionList();
    });
  }
  const { createSidebarProjectFilter } = require('./sidebar-project-filter');
  const projectFilter = createSidebarProjectFilter({
    document: doc, storage,
    ipcRenderer: options.ipcRenderer || (doc.getElementById?.('session-project-filter') ? require('electron').ipcRenderer : null),
    onChange: () => renderSessionList(),
  });
  let detailsEnabled = false;
  try { detailsEnabled = storage.getItem('hubSessionDetails') === 'true'; } catch {}
  const collapsedDetailsMeetings = new Set();
  let hoveredMeetingId = null;
  let hoverPoint = null;
  const detailsButton = doc.getElementById?.('btn-session-details');
  const syncDetailsButton = () => detailsButton?.setAttribute?.('aria-pressed', String(detailsEnabled));
  syncDetailsButton();
  detailsButton?.addEventListener('click', () => {
    detailsEnabled = !detailsEnabled;
    try { storage.setItem('hubSessionDetails', String(detailsEnabled)); }
    catch (error) { console.warn('[sidebar] detail preference could not be saved:', error.message); }
    syncDetailsButton();
    renderSessionList();
  });
  const sessionListEl = options.sessionListEl;
  const getSessions = typeof options.getSessions === 'function' ? options.getSessions : () => new Map();
  const getMeetings = typeof options.getMeetings === 'function' ? options.getMeetings : () => ({});
  const getActiveSessionId = typeof options.getActiveSessionId === 'function' ? options.getActiveSessionId : () => null;
  const getActiveMeetingId = typeof options.getActiveMeetingId === 'function' ? options.getActiveMeetingId : () => null;
  const isAiKind = options.isAiKind;
  const modelShort = options.modelShort;
  const escapeHtml = options.escapeHtml;
  const formatTime = options.formatTime;
  function timeHtml(session, unreadCount = 0) {
    const ts = latestActivityTime(session);
    const full = [formatTime?.(ts), Number(ts) > 0 ? new Date(Number(ts)).toLocaleString('zh-CN') : '', unreadCount ? `${unreadCount} 条未读` : ''].filter(Boolean).join(' · ');
    return `<span class="sl-time${unreadCount ? ' has-unread' : ''}" title="${escapeHtml(full)}" aria-label="${escapeHtml(full)}">${sidebarRelativeTime(ts)}</span>`;
  }
  const pctClass = options.pctClass;
  const getResourceUsage = typeof options.getResourceUsage === 'function' ? options.getResourceUsage : () => null;
  const getProxyInfo = typeof options.getProxyInfo === 'function' ? options.getProxyInfo : () => null;
  const selectSession = options.selectSession;
  const selectMeeting = options.selectMeeting;
  const openContextMenu = options.openContextMenu;
  const markMeetingRead = options.markMeetingRead;
  // 「已完成未读」组头上的一键已读。渲染层只负责按钮，真正清状态由 renderer.js 注入。
  const markAllSessionsRead = typeof options.markAllSessionsRead === 'function'
    ? options.markAllSessionsRead
    : null;
  // 2026-07-19 方案C：列表渲染完成后的回调（renderer 用来刷新 ctx chip/中断钮/等你响应浮动条）
  const afterRender = typeof options.afterRender === 'function' ? options.afterRender : null;
  const renderStats = { renders: 0, slowRenders: 0, lastMs: 0, maxMs: 0 };
  let sidebarPhaseInitialized=false;
  const nowMs = typeof options.nowMs === 'function'
    ? options.nowMs
    : () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now());

// --- Sidebar tree state: which meeting entries are expanded to show their sub-sessions ---
// Persists across reloads. Default = collapsed (白名单未命中即折叠)；用户点 ▶ 后才进
// _expandedMeetings 集合并落盘。2026-05-05 maintainer改：新 AI 群聊不再默认展开，折叠态本来
// 就有 3 个迷你头像跳转按钮可用。
const _expandedMeetings = (() => {
  try {
    const raw = storage.getItem('hubExpandedMeetings');
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
})();
function _persistExpandedMeetings() {
  try {
    storage.setItem('hubExpandedMeetings', JSON.stringify([..._expandedMeetings]));
  } catch {}
}
function toggleMeetingExpand(meetingId) {
  if (detailsEnabled && getMeetings()[meetingId]?.groupChat) {
    if (collapsedDetailsMeetings.has(meetingId)) collapsedDetailsMeetings.delete(meetingId);
    else collapsedDetailsMeetings.add(meetingId);
    renderSessionList();
    return;
  }
  if (_expandedMeetings.has(meetingId)) _expandedMeetings.delete(meetingId);
  else _expandedMeetings.add(meetingId);
  _persistExpandedMeetings();
  renderSessionList();
}

function _logoKind(kind, modelId = '') {
  const k = String(kind || '').replace(/-resume$/, '');
  if (k.startsWith('deepseek')) return 'deepseek'; // deepseek-legacy 复用 DS 图标
  if (k === 'codeagent') {
    const family = require('../core/codeagent-models').modelFamily(modelId);
    return ['deepseek', 'minimax', 'qwen'].includes(family) ? family : 'codeagent';
  }
  if (k === 'powershell' || isAiKind(k)) return k;
  return '';
}

// AI mini logo for sidebar sub-session items. Reuses the .ai-logo + .logo-<kind>
// classes already defined in styles.css for the toolbar dropdown.
// 侧栏用标题前的品牌小图标标识 AI，具体型号保留在悬停说明中。
//   扫列表时真正要一眼分辨的只是"哪家 CLI"，具体型号是二级信息 → 退到 tooltip
//   （会话行的无障碍标签也包含完整 displayName）。
//   拿不到图标的 kind 回落成原来的文字列，避免这一列直接消失。
function _sessionKindHtml(kind, modelTxt, state = 'idle', stateTip = '', modelId = '', targetSessionId = '', account = null) {
  const k = _logoKind(kind, modelId);
  if (!k) return `<span class="sl-model">${escapeHtml(modelTxt || '')}</span>`;
  const labelKind = String(kind || '').replace(/-resume$/, '') === 'codeagent' ? 'codeagent' : k;
  const label = String(modelTxt || '').startsWith('ChatGPT') ? 'ChatGPT' : (KIND_LABELS[labelKind] || labelKind);
  const tip = label === 'ChatGPT' ? modelTxt : modelTxt ? `${label} · ${modelTxt}` : label;
  const status = stateTip || STATUS_LABELS[state] || STATUS_LABELS.idle;
  const action = targetSessionId ? ' · 点击查看该成员的卡片' : '';
  const navigation = targetSessionId
    ? `role="button" tabindex="0" data-sub-id="${escapeHtml(targetSessionId)}" data-sidebar-control="group-logo-${escapeHtml(targetSessionId)}"`
    : 'role="img"';
  const accountTip = account ? ` · 账号 ${account.no}（${account.label}）` : '';
  const accountAttr = account ? ` data-account="${Number(account.no)}"` : '';
  return `<span class="sl-kind ai-logo logo-${k}" data-state="${state}"${accountAttr} ${navigation} aria-label="${escapeHtml(label + accountTip + ' · ' + status + action)}" title="${escapeHtml(tip + accountTip + ' · ' + status + action)}"></span>`;
}

const STATUS_LABELS = { wait: '等你响应', error: '运行异常', run: '运行中', start: '唤醒中', unread: '未读', dorm: '休眠', idle: '就绪', unknown: '状态未知' };
function _warningHtml(message) {
  return message ? `<svg class="sl-warning" viewBox="0 0 24 24" role="img" aria-label="${escapeHtml(message)}"><title>${escapeHtml(message)}</title><path d="M12 3 2 21h20L12 3Zm0 6v5m0 3v1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>` : '';
}

function _subIsRunning(sub) {
  return isGroupChatMemberRunning(sub);
}


function _sessionWarningText(session) {
  if (!session) return '';
  const warnings = [];
  if (session.cwdFellBackFrom) {
    warnings.push(`原目录失效：${session.cwdFellBackFrom}；当前回落到：${session.cwd || '(unknown)'}`);
  }
  if (session.memoryLinkWarning) {
    warnings.push(`记忆未接入规范库：${session.memoryLinkWarning}`);
  }
  const issue = sessionRuntimeIssue(session);
  if (issue) warnings.push(`${issue.label}：${issue.message}`);
  return warnings.join('；');
}

  function _meetingAnySubRunning(meeting, sessionMap) {
    const aggregate = _meetingRuntimeAggregate(meeting, sessionMap);
    return aggregate.running && !aggregate.disconnected;
  }

  // 代理配置只用于 tooltip；可见文案必须是 main 进程实测的公网 IP + 城市。
  // 只显示 host:port，隐去可能带凭据的 user:pass@ 部分。
  function _shortProxy(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    try {
      const u = new URL(s.includes('://') ? s : `http://${s}`);
      return u.port ? `${u.hostname}:${u.port}` : u.hostname;
    } catch {
      return s.replace(/^[a-z0-9+.-]+:\/\//i, '').replace(/^[^@/]*@/, '').split('/')[0] || null;
    }
  }

  function renderSidebarStrip(sessionMap = getSessions()) {
    const stripEl = doc.getElementById('sidebar-strip');
    if (!stripEl) return;

    const usage = getResourceUsage() || {};
    const cpuPct = Number.isFinite(usage.cpuPct) ? Math.round(usage.cpuPct) : null;
    const gpuPct = Number.isFinite(usage.gpu?.usagePct) ? Math.round(usage.gpu.usagePct) : null;
    const memoryPct = Number.isFinite(usage.memoryPct) ? Math.round(usage.memoryPct) : null;
    const metricClass = value => value != null && value >= 90 ? ' strip-resource-high strip-resource-critical'
      : value != null && value >= 85 ? ' strip-resource-high' : '';
    const proxy = typeof getProxyInfo === 'function' ? getProxyInfo() : null;
    const egress = proxy && proxy.egress;
    // Hub 没配代理、但 Windows 系统设置里有代理时（公司办公代理），出口探测走系统代理，这里按「代理」显示；
    const systemProxy = egress && egress.proxySource === 'system' ? egress.proxyEndpoint : '';
    const proxyShort = _shortProxy(proxy && proxy.proxy) || _shortProxy(systemProxy);
    const xgate = !!(egress && egress.tunnel && egress.tunnel.xgate);
    const vpnNic = egress && egress.tunnel && egress.tunnel.vpn;
    const routeLabel = vpnNic ? 'VPN' : xgate ? '代理' : systemProxy ? '代理' : proxyShort ? 'VPN' : '直连';
    const foreign = egress && egress.foreign;
    const domestic = egress && egress.domestic;
    const displayRoute = proxyShort || (xgate && foreign && foreign.ok) ? foreign : domestic;
    const alert = egress && egress.alert;
    const clashDelay = proxy?.clashDelay?.status === 'ok' ? proxy.clashDelay : null;

    const ackAttr = alert && alert.acknowledgeable ? ' data-egress-ack="true"' : '';
    const foreignTitle = [
      vpnNic ? `VPN 已连上：${vpnNic.name}（${vpnNic.address}）` : '',
      xgate ? '系统安全隧道正在运行；它选的节点读不到，下面是实测出口' : '',
      systemProxy ? '公网经 Windows 系统代理' : proxyShort ? 'Claude / Codex 订阅、Gemini：经 VPN 代理' : '未配置 VPN，显示直连出口',
      systemProxy ? `系统代理：${proxyShort}` : proxyShort ? `本地代理：${proxyShort}` : '本地代理：未配置',
      displayRoute && displayRoute.ok ? `出口地区：${displayRoute.locationLabel || '未知地区'}` : `状态：${displayRoute && displayRoute.error || '检测中'}`,
      proxy?.clashDelay?.status === 'timeout' ? `Clash 节点测速超时：${proxy.clashDelay.nodeName}（5 秒内没有响应）` : '',
      clashDelay ? `Clash 节点健康检查：${clashDelay.nodeName} · ${clashDelay.delayMs} ms（${new Date(clashDelay.measuredAt).toLocaleString('zh-CN')}）；这是探测请求延时，不能代表下载速度或 AI 网页加载耗时` : '',
      alert ? `${alert.title || '节点异常'}：${alert.message || ''}` : '',
      alert && alert.acknowledgeable ? '点击打开流量详情，在里面确认当前节点' : '点击查看 VPN 流量：哪个程序、哪个网站用得最多',
    ].filter(Boolean).join('\n');
    const domesticTitle = [
      'Kimi / DeepSeek：清空 HTTP(S)_PROXY 后直连',
      domestic && domestic.ok ? `出口地区：${domestic.locationLabel || '未知地区'}` : `状态：${domestic && domestic.error || '检测中'}`,
    ].join('\n');

    const routeClass = (route, warning) => !egress ? 'pending' : warning || !route?.ok ? 'warning' : 'ok';
    const metric = (label, value) => `<span class="strip-resource${metricClass(value)}" tabindex="0" data-resource-kind="${label === 'CPU' ? 'cpu' : 'memory'}" aria-label="${label} ${value == null ? '检测中' : value + '%'}，悬停查看占用 Top 3" title="${label} ${value == null ? '检测中' : value + '%'}">${label}<b>${value == null ? '—' : value + '%'}</b><span class="strip-mini-track"><i style="width:${value == null ? 0 : Math.max(0, Math.min(100, value))}%"></i></span></span>`;
    const gpuTitle = gpuPct == null ? 'GPU 占用率暂不可用' : `${usage.gpu.name || 'GPU'} · 占用 ${gpuPct}% · 每 10 秒采样`;
    const gpuMetric = `<span class="strip-resource strip-gpu${metricClass(gpuPct)}" tabindex="0" title="${escapeHtml(gpuTitle)}" aria-label="${escapeHtml(gpuTitle)}">GPU<b>${gpuPct == null ? '—' : gpuPct + '%'}</b></span>`;
    // C/D 同时显示（2026-11-09）：工作数据都在 D 盘，只看 Hub 所在盘时 D 盘写满了也发现不了。
    const diskVolumes = Array.isArray(usage.disk?.volumes) && usage.disk.volumes.length ? usage.disk.volumes : [usage.disk || {}];
    const diskGb = bytes => Number.isFinite(bytes) ? `${(bytes / 1024 ** 3).toFixed(0)} GB` : '';
    const diskMetric = diskVolumes.map(volume => {
      const pct = Number.isFinite(volume.usagePct) ? Math.round(volume.usagePct) : null;
      const letter = /^[a-z]:/i.test(volume.root || '') ? volume.root[0].toUpperCase() : '';
      const name = letter ? `${letter} 盘` : (volume.root || '本机磁盘');
      const state = pct == null ? '检测中' : pct + '%';
      const free = diskGb(volume.freeBytes);
      const total = diskGb(volume.totalBytes);
      const summary = `${name}已用 ${state}${free ? `（剩余 ${free}${total ? ` / 共 ${total}` : ''}）` : ''}`;
      const label = diskVolumes.length > 1 && letter ? letter + '盘' : '硬盘';
      return `<span class="strip-resource strip-disk${metricClass(pct)}" role="button" tabindex="0" aria-haspopup="dialog" title="${escapeHtml(summary + ' · 点击打开硬盘管理')}" aria-label="${escapeHtml(summary + '，点击打开硬盘管理')}">${label}<b>${pct == null ? '—' : pct + '%'}</b><span class="strip-mini-track"><i style="width:${pct == null ? 0 : Math.max(0, Math.min(100, pct))}%"></i></span></span>`;
    }).join('');
    const network = usage.network;
    const rate = value => {
      if (network?.status !== 'ok' || !Number.isFinite(value)) return '—';
      if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}<small>G</small>`;
      if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)}<small>M</small>`;
      return `${Math.round(value / 1024)}<small>K</small>`;
    };
    const networkTitle = network?.status === 'ok'
      ? `本机物理网卡合计：${(network.adapters || []).join('、')}\n下行 ${(network.downloadBps / 1024).toFixed(1)} KB/s · 上行 ${(network.uploadBps / 1024).toFixed(1)} KB/s\n最近 ${(network.windowMs / 1000).toFixed(1)} 秒均值；含所有应用，非 VPN 专属流量；K/M/G 表示 KB/s、MB/s、GB/s，按 1024 换算`
      : network?.status === 'unavailable' ? '网速暂不可用' : network?.status === 'disconnected' ? '没有已连接的物理网卡' : '网速采样中';
    const ips = Array.isArray(network?.ips) ? network.ips : [];
    const ipTitle = ips.length ? '本机 IP：\n' + ips.map(x => `${x.name}：${x.address}`).join('\n') : '';
    const ipChip = ips.length ? `<span class="strip-ip" title="${escapeHtml(ipTitle)}" aria-label="${escapeHtml('本机 IP ' + ips[0].address)}">${escapeHtml(ips[0].address)}</span>` : '';
    const transfer = `<span class="strip-transfer" title="${escapeHtml(networkTitle)}" aria-label="${escapeHtml(networkTitle)}"><span class="strip-download"><span class="strip-transfer-label">↓</span><b>${rate(network?.downloadBps)}</b></span><span class="strip-upload"><span class="strip-transfer-label">↑</span><b>${rate(network?.uploadBps)}</b></span>${ipChip}</span>`;
    const location = displayRoute?.ok
      ? [displayRoute.countryZh || displayRoute.country || '国家未知', displayRoute.cityZh || displayRoute.city || '城市未知'].join(' ')
            : '位置检测中';
    const domesticLabel = !egress ? '国内检测中' : domestic?.ok ? '国内正常' : '国内异常';
    const markup =
      '<div class="strip-resources" title="点击 CPU / 内存查看进程，点击硬盘释放空间">' + metric('CPU', cpuPct) + gpuMetric + metric('内存', memoryPct) + diskMetric + '</div>' +
      `<div class="strip-network"><button type="button" class="strip-route-row strip-route-foreign strip-proxy" title="${escapeHtml(foreignTitle)}"${ackAttr}><span class="strip-route-dot ${routeClass(displayRoute, proxyShort ? alert : null)}"></span><span>${routeLabel}</span><span class="strip-location">${escapeHtml(location)}</span>${clashDelay ? `<span class="strip-delay" data-state="known">${clashDelay.delayMs}<small>ms</small></span>` : proxy?.clashDelay?.status === 'timeout' ? '<span class="strip-delay" data-state="timeout">节点超时</span>' : ''}</button>` +
      transfer + (showDomesticRoute() ? `<span class="strip-route-row strip-route-domestic" title="${escapeHtml(domesticTitle)}"><span class="strip-route-dot ${routeClass(domestic)}"></span>${domesticLabel}</span>` : '') + '</div>';
    if (stripEl._resourceMarkup === markup) return;
    stripEl._resourceMarkup = markup;
    // Keep focused/hovered resource anchors alive during the telemetry heartbeat.
    if (stripEl.querySelector('[data-resource-kind]')) {
      const template = doc.createElement('template');
      template.innerHTML = markup;
      for (const kind of ['cpu', 'memory']) {
        const current = stripEl.querySelector(`[data-resource-kind="${kind}"]`);
        const next = template.content.querySelector(`[data-resource-kind="${kind}"]`);
        current.className = next.className;
        current.title = next.title;
        current.setAttribute('aria-label', next.getAttribute('aria-label'));
        current.querySelector('b').textContent = next.querySelector('b').textContent;
        current.querySelector('i').style.width = next.querySelector('i').style.width;
      }
      const currentGpu = stripEl.querySelector('.strip-gpu');
      const nextGpu = template.content.querySelector('.strip-gpu');
      if (currentGpu && nextGpu) {
        currentGpu.className = nextGpu.className;
        currentGpu.title = nextGpu.title;
        currentGpu.setAttribute('aria-label', nextGpu.getAttribute('aria-label'));
        currentGpu.querySelector('b').textContent = nextGpu.querySelector('b').textContent;
      }
      const currentDisks = [...stripEl.querySelectorAll('.strip-disk')];
      const nextDisks = [...template.content.querySelectorAll('.strip-disk')];
      if (currentDisks.length !== nextDisks.length) {
        currentDisks.forEach((node, index) => { if (index) node.remove(); });
        if (currentDisks[0]) currentDisks[0].outerHTML = nextDisks.map(node => node.outerHTML).join('');
      } else currentDisks.forEach((currentDisk, index) => {
        const nextDisk = nextDisks[index];
        currentDisk.className = nextDisk.className;
        currentDisk.title = nextDisk.title;
        currentDisk.setAttribute('aria-label', nextDisk.getAttribute('aria-label'));
        currentDisk.firstChild.textContent = nextDisk.firstChild.textContent;
        currentDisk.querySelector('b').textContent = nextDisk.querySelector('b').textContent;
        currentDisk.querySelector('i').style.width = nextDisk.querySelector('i').style.width;
      });
      stripEl.querySelector('.strip-network').innerHTML = template.content.querySelector('.strip-network').innerHTML;
    } else stripEl.innerHTML = markup;
    stripEl.title = '';
    stripEl.style.display = 'flex';
    // 点击 VPN 行打开流量详情（renderer/vpn-traffic-panel.js），节点变化的确认在弹层里完成。
  }

  // Session rows are rebuilt wholesale whenever status/recency changes. With
  // hundreds of rows, a rebuild can land between pointer-down and pointer-up;
  // a click listener attached to the removed row then never fires. Capture the
  // navigation intent on the stable list container and finish it on pointer-up.
  const POINTER_NAV_MAX_MOVE_PX = 8;
  const POINTER_CLICK_SUPPRESS_MS = 750;
  const POINTER_REPEAT_INTENT_MS = 500;
  let pendingPointerNavigation = null;
  let lastPointerNavigationAt = 0;
  let lastPointerActivation = null;
  // Editing another pane ends a physical double-click gesture. A later click
  // on a reordered row must use that row, not the prior sidebar target.
  doc.addEventListener?.('pointerdown', event => {
    if (!sessionListEl.contains?.(event.target)) lastPointerActivation = null;
  }, true);

  function navigationIntentFromTarget(target) {
    if (!target || typeof target.closest !== 'function') return null;
    const read = target.closest('[data-action="mark-meeting-read"]');
    if (read) return { type: 'read-meeting', id: read.closest('[data-meeting-id]')?.dataset.meetingId };
    const usage = target.closest('[data-usage-id]');
    if (usage) return { type: 'usage', id: usage.getAttribute('data-usage-id') };
    const jump = target.closest('[data-sub-id]');
    if (jump) return { type: 'session', id: jump.getAttribute('data-sub-id'), latest: true };
    const toggle = target.closest('[data-action="toggle-expand"]');
    if (toggle) {
      const meeting = toggle.closest('[data-meeting-id]');
      return meeting ? { type: 'toggle-meeting', id: meeting.getAttribute('data-meeting-id') } : null;
    }
    const meeting = target.closest('[data-meeting-id]');
    if (meeting) return { type: 'meeting', id: meeting.getAttribute('data-meeting-id') };
    const session = target.closest('[data-session-id]');
    if (session) return { type: 'session', id: session.getAttribute('data-session-id') };
    return null;
  }

  function activateNavigationIntent(intent) {
    if (!intent || !intent.id) return false;
    try {
      if (intent.type === 'read-meeting') {
        markMeetingRead?.(intent.id);
        return true;
      }
      if (intent.type === 'usage') {
        // Usage details live in the hover tooltip. Consume the click so it
        // does not activate or resume the surrounding session row.
        return true;
      }
      if (intent.type === 'toggle-meeting') {
        toggleMeetingExpand(intent.id);
        return true;
      }
      const forceScrollBottom = !!intent.latest || intent.id === getActiveSessionId()
        || sessionHasCompletedUnread(getSessions().get(intent.id))
        || Object.values(getMeetings()).some(m => getMeetingUnreadMemberIds(m, getSessions()).has(intent.id));
      const action = intent.type === 'meeting'
        ? selectMeeting(intent.id, { forceScrollBottom: true, wakeDormantMembers: true })
        : selectSession(intent.id, { forceScrollBottom });
      Promise.resolve(action).catch(error => console.warn('[sidebar] navigation failed:', error));
      return true;
    } catch (error) {
      console.warn('[sidebar] navigation failed:', error);
      return false;
    }
  }

  sessionListEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rawIntent = navigationIntentFromTarget(event.target);
    const now = Date.now();
    const x = Number(event.clientX) || 0;
    const y = Number(event.clientY) || 0;
    // A first click can immediately reorder the selected/resuming row. The
    // second half of a physical double-click then lands on whatever row moved
    // into the old coordinates, even though the user's intent did not change.
    // Keep the first intent for a same-position repeat inside the native
    // double-click window; a deliberate click elsewhere still uses its row.
    const repeatedAtSamePoint = lastPointerActivation
      && now - lastPointerActivation.at <= POINTER_REPEAT_INTENT_MS
      && Math.hypot(x - lastPointerActivation.x, y - lastPointerActivation.y) <= POINTER_NAV_MAX_MOVE_PX;
    const intent = rawIntent && repeatedAtSamePoint ? lastPointerActivation.intent : rawIntent;
    if (!intent || !intent.id) return;
    pendingPointerNavigation = {
      intent,
      pointerId: event.pointerId,
      x,
      y,
    };
    try { sessionListEl.setPointerCapture?.(event.pointerId); } catch {}
  });

  sessionListEl.addEventListener('pointerup', (event) => {
    const pending = pendingPointerNavigation;
    if (!pending || pending.pointerId !== event.pointerId) return;
    pendingPointerNavigation = null;
    try { sessionListEl.releasePointerCapture?.(event.pointerId); } catch {}
    const moved = Math.hypot(
      (Number(event.clientX) || 0) - pending.x,
      (Number(event.clientY) || 0) - pending.y,
    );
    lastPointerNavigationAt = Date.now();
    if (moved > POINTER_NAV_MAX_MOVE_PX) return;
    lastPointerActivation = {
      intent: pending.intent,
      x: pending.x,
      y: pending.y,
      at: Date.now(),
    };
    event.preventDefault();
    event.stopPropagation();
    activateNavigationIntent(pending.intent);
  });

  sessionListEl.addEventListener('pointercancel', (event) => {
    if (pendingPointerNavigation && pendingPointerNavigation.pointerId === event.pointerId) {
      pendingPointerNavigation = null;
    }
  });

  // Keyboard activation and older PointerEvent fallbacks still arrive as
  // click. Suppress the synthetic click that follows a handled pointer-up.
  sessionListEl.addEventListener('click', (event) => {
    const intent = navigationIntentFromTarget(event.target);
    if (!intent || !intent.id) return;
    // A wholesale rebuild may put a *different* row under the pointer before
    // Chromium emits its compatibility click. The pointer-up already honored
    // the captured intent, so suppress any immediately following mouse click,
    // not only one whose new DOM target happens to have the same id. Keyboard
    // and programmatic activation use detail=0 and remain available.
    const duplicate = lastPointerNavigationAt > 0
      && event.detail !== 0
      && Date.now() - lastPointerNavigationAt <= POINTER_CLICK_SUPPRESS_MS;
    event.preventDefault();
    event.stopPropagation();
    if (!duplicate) activateNavigationIntent(intent);
  });

sessionListEl.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const shortcut = event.target?.closest?.('[data-sub-id]');
  if (shortcut && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault(); event.stopPropagation();
    activateNavigationIntent(navigationIntentFromTarget(shortcut));
    return;
  }
  const row = event.target?.closest?.('.session-item');
  if (!row) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const rows = [...sessionListEl.querySelectorAll('.session-item')]
      .filter(el => !el.getClientRects || el.getClientRects().length > 0);
    const index = rows.indexOf(row);
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    event.preventDefault(); event.stopPropagation(); next?.focus();
  } else if (event.key === 'Enter' && event.target === row) {
    event.preventDefault(); event.stopPropagation();
    activateNavigationIntent(navigationIntentFromTarget(row));
  }
});

// --- Session list rendering ---
// Sort: pinned sessions first, ordinary/group sessions by latest activity, and
// explicit bottomed sessions last.  The final render also gives bottomed items
// their own literal last section so age/status buckets cannot move below them.
// Tree shape: meeting entries optionally expand to show their child sub-sessions.
// Top-level regular sessions (no meetingId) sit alongside meetings in the same sort order.
  // 前台 = Hub 助理当前绑定的会话（assistant:get-overview 的 sessionId）；换班、换后端后重取。
  // 拿不到绑定时兜底取最近活动、没换班的 hub-assistant 会话。前台永久置顶：不受筛选、不参与排序、不能拖。
  function frontEnabled() { try { return require('../core/distribution').featureEnabled('assistant'); } catch { return false; } }
  const homeIpc = options.ipcRenderer || (typeof process !== 'undefined' && process.type === 'renderer' ? require('electron').ipcRenderer : null);
  let boundFrontSid = null, frontQuery = null, frontQueriedAt = 0, frontGen = 0;
  const seenFronts = new Set();
  const isRetiredFront = s => /（已换班）\s*$/.test(String(s?.title || ''));
  // force：明确的换绑信号（换班、换后端、前台台位变化）不等在途的那次，按最新一次的结果为准。
  function queryFront(force = false) {
    if (typeof homeIpc?.invoke !== 'function' || !frontEnabled() || (frontQuery && !force)) return;
    const gen = ++frontGen;
    frontQueriedAt = Date.now();
    const pending = frontQuery = Promise.resolve(homeIpc.invoke('assistant:front-binding')).then(r => {
      if (gen !== frontGen) return;
      const sid = r && r.ok !== false && typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : null;
      if (sid !== boundFrontSid) { boundFrontSid = sid; renderSessionList(); }
    }).catch(error => console.warn('[sidebar] 前台绑定读取失败：', error && error.message)).finally(() => { if (frontQuery === pending) frontQuery = null; });
  }
  function frontSession(sessionMap = getSessions()) {
    if (!frontEnabled()) return null;
    let fresh = false, best = null;
    for (const s of sessionMap.values()) {
      if (s?.purpose !== 'hub-assistant') continue;
      if (!seenFronts.has(s.id)) { seenFronts.add(s.id); fresh = true; }
      if (!isRetiredFront(s) && !s.hiddenFromSidebar && (!best || latestActivityTime(s) > latestActivityTime(best))) best = s;
    }
    // 新出现前台会话（换后端、换班）立刻重取绑定；平时最多 15 秒对一次，手机端换后端也能跟上。
    if (fresh || Date.now() - frontQueriedAt > 15000) queryFront(fresh);
    const bound = boundFrontSid ? sessionMap.get(boundFrontSid) : null;
    return bound && !bound.hiddenFromSidebar ? bound : best;
  }
  homeIpc?.on?.('assistant:rotated', () => queryFront(true));
  homeIpc?.on?.('assistant:front-desk', () => queryFront(true));
  doc.addEventListener?.('hub:assistant-binding-changed', () => queryFront(true));
  function projectLeadsOf(sessionMap = getSessions()) {
    const teamUi = typeof window !== 'undefined' ? window.__teamUi : null;
    return teamUi ? id => (teamUi.membersOf(id, sessionMap, getMeetings()) || []) : () => [];
  }
  if (typeof window !== 'undefined' && doc === window.document) {
    // 右键「创建子会话…」和启动中心「负责人」下拉用（m10）：前台排第一，其余负责人按最近活动倒序。
    window.__homeSidebar = {
      frontSid: () => frontSession()?.id || null,
      isLead: id => !!window.__teamUi?.isLead?.(id),
      leadOptions() {
        const map = getSessions(), front = frontSession(map), out = [];
        if (front) out.push({ sid: front.id, title: '前台', isFront: true, at: latestActivityTime(front) });
        const leads = [...map.values()].filter(s => s && s.id !== front?.id && window.__teamUi?.isLead?.(s.id) && !s.hiddenFromSidebar);
        for (const s of leads.sort((a, b) => latestActivityTime(b) - latestActivityTime(a))) {
          out.push({ sid: s.id, title: sessionDisplayTitle(s, KIND_LABELS, getMeetings()[s.meetingId]), isFront: false, at: latestActivityTime(s) });
        }
        return out;
      },
      isFolded: id => foldedIds.has(id),
      toggleFold(id) {
        if (!id) return false;
        if (foldedIds.has(id)) foldedIds.delete(id); else foldedIds.add(id);
        saveFolded();
        return foldedIds.has(id);
      },
      isHidden: id => hiddenIds.has(id),
      toggleHidden(id) {
        if (!id) return false;
        if (hiddenIds.has(id)) hiddenIds.delete(id); else hiddenIds.add(id);
        savePreference('hubSidebarHiddenIds', JSON.stringify([...hiddenIds]));
        renderSessionList();
        return hiddenIds.has(id);
      },
    };
  }
  function collectSidebarItems(sessionMap = getSessions(), sorted = true) {
    const memberIds = new Set(Object.values(getMeetings()).flatMap(m => m.subSessions || []));
    // 负责人组队（renderer/team-ui.js）：成员挂在负责人行下面，不再单独出现在顶层。
    const teamMemberIds = (typeof window !== 'undefined' && window.__teamUi?.memberIdSet(sessionMap, getMeetings())) || new Set();
    const regularSessions = Array.from(sessionMap.values())
    .filter(s => !s.meetingId && !memberIds.has(s.id) && !teamMemberIds.has(s.id) && s.kind !== 'xresearch-run' && !s.hiddenFromSidebar && s.purpose !== 'xresearch-research'
      // 关掉助理的发行版（公司版）：旧版本留下的助理会话不再出现在侧栏（它跑不起来，只会显示运行异常）。
      && !(s.purpose === 'hub-assistant' && !require('../core/distribution').featureEnabled('assistant')));

  const meetingItems = Object.values(getMeetings()).map(m => {
    const unreadAnsweredSize = getMeetingUnreadMemberIds(m, sessionMap).size;
    return cacheMeetingItem(m, input => ({
    id: input.id,
    title: input.title,
    lastMessageTime: input.lastMessageTime,
    lastCompletedAt: input.lastCompletedAt,
    createdAt: input.createdAt,
    lastOutputPreview: input.groupChat
      ? `AI 群聊 · ${(input.participants || input.subSessions || []).length}/${(input.subSessions || []).length} 已选`
      : `${input.subSessions.length} 个子会话`,
    status: input.status || 'idle',
    unreadAnsweredSize,
    pinned: input.pinned,
    bottomed: input.bottomed,
    _isMeeting: true,
    _meeting: m,
  }), unreadAnsweredSize);
  });

  const all = regularSessions.concat(meetingItems);

  const ordered = sorted ? sortBySidebarPlacement(all) : all;

  // Hide any leftover legacy background PTY sessions from the removed room path.
  const everything = ordered.filter(s => !s.title || !s.title.startsWith('[Team] '));

    return everything;
  }
  sidebarSources.set(doc, () => {
    const sessionMap = getSessions();
    const parents = collectSidebarItems(sessionMap);
    const parts = sidebarView(parents, sessionMap);
    // 搜索里的「已收起」和侧栏同一套判定（含近期有意休眠的会话）。
    const now = Date.now();
    const archived = new Set(homeSections(parts, sessionMap, item => classifySession(item, { now, sessionMap }), now, frontSession(sessionMap)).collapsed.map(s => s.id));
    const items = [...parents];
    const seen = new Set(items.map(s => s.id));
    const teamParents = new Map();
    // 折叠只影响展示；搜索目录始终包括团队成员，命中后由 revealSearchItem 展开父队。
    const teamUi = typeof window !== 'undefined' ? window.__teamUi : null;
    for (const parent of parents) {
      if (parent._isMeeting) continue;
      for (const id of teamUi?.membersOf(parent.id, sessionMap, getMeetings()) || []) {
        const member = sessionMap.get(id);
        if (!member || member.hiddenFromSidebar || seen.has(id)) continue;
        items.push(member); seen.add(id); teamParents.set(id, parent.id);
      }
    }
    return items.map(s => ({ ...s,
      key: (s._isMeeting ? 'live-meeting:' : 'live-session:') + s.id,
      hubSessionId: s._isMeeting ? null : s.id, meetingId: s._isMeeting ? s.id : null,
      provider: s._isMeeting ? 'meeting' : String(s.kind || '').replace(/-resume$/, '').replace(/^deepseek.*$/, 'deepseek'),
      sidebarHidden: hiddenIds.has(s.id),
      archived: archived.has(teamParents.get(s.id) || s.id)
        || isHiddenNow(s, item => classifySession(item, { now, sessionMap }), sessionMap)
        || (teamParents.has(s.id) && getActiveSessionId() !== s.id
          && sidebarCompletedAndStale(s, classifySession(s, { now, sessionMap }), { now, dismissed: !!teamUi?.isDismissed?.(s.id, teamParents.get(s.id)) })),
      agentGroup: agentGroupOf(s),
      updatedAt: latestActivityTime(s),
      cwd: s._isMeeting ? s._meeting.workspace : s.cwd,
      projectLabel: s._isMeeting ? s._meeting.workspaceLabel : s.workspaceLabel,
    }));
  });
  function openSearch(detail) {
    if (typeof options.openSearch === 'function') return options.openSearch(detail);
    doc.dispatchEvent(new doc.defaultView.CustomEvent('sidebar:open-search', { detail }));
  }
  function filteredSidebarItems(sessionMap = getSessions(), sorted = true) {
    const frontId = frontSession(sessionMap)?.id;
    return collectSidebarItems(sessionMap, sorted).filter(item => item.purpose !== RESIDENT_PURPOSE && item.id !== frontId && sideFilterPasses(item) && projectFilter.matches(item) && (modelFilter === 'all' || sessionFamilies(item, sessionMap).has(modelFilter)));
  }
  // 常驻的助理会话：同用途里最近活动的那个。
  function residentAssistant(sessionMap = getSessions()) {
    const list = collectSidebarItems(sessionMap).filter(item => item.purpose === RESIDENT_PURPOSE);
    return list.sort((a, b) => latestActivityTime(b) - latestActivityTime(a))[0] || null;
  }
  function revealSearchItem(id, memberId = null) {
    const teamUi = typeof window !== 'undefined' ? window.__teamUi : null;
    const teamLead = teamUi?.leadOf?.(memberId || id, getSessions(), getMeetings());
    const frontId = frontSession()?.id;
    if (frontId && (teamLead || id) === frontId) {
      // 前台永久置顶，不用改其他筛选；命中前台的成员时展开前台下面的列表，被模型筛选挡住的话恢复「全部」。
      if (teamLead) { (teamUi.revealForSearch || (lead => teamUi.setCollapsed(lead, false)))(teamLead); if (teamUi.isDismissed?.(memberId || id, teamLead)) teamUi.setLeftOpen?.(teamLead, true); }
      const hit = teamLead ? getSessions().get(memberId || id) : null;
      if (hit && modelFilter !== 'all' && familyOfKind(hit.kind) !== modelFilter) {
        modelFilter = 'all';
        if (modelControl) modelControl.value = modelFilter;
        savePreference('hubSidebarModelFilter', modelFilter);
      }
      renderSessionList();
      return;
    }
    const item = collectSidebarItems().find(entry => entry.id === (teamLead || id));
    if (!item) return;
    if (sideMode && isSideSession(item) !== sideOnly) {
      // 只为这次定位切过去，不存：否则刷新后自己的会话整片消失（2026-10-17 审核）。
      sideOnly = isSideSession(item); syncWirelessControl();
    }
    if (!assistantOnly && pinnedOnly !== !!item.pinned) {
      pinnedOnly = !!item.pinned;
      savePreference('hubSidebarRange',pinnedOnly ? 'pinned' : String(recentDays)); syncRangeControls();
    }
    projectFilter.reveal(item);
    const member = teamLead ? getSessions().get(memberId || id)
      : memberId && item._meeting?.subSessions?.includes(memberId) ? getSessions().get(memberId) : null;
    if (modelFilter !== 'all' && !(member ? sessionFamilies(member, getSessions()) : sessionFamilies(item, getSessions())).has(modelFilter)) {
      modelFilter = 'all';
      if (modelControl) modelControl.value = modelFilter;
      savePreference('hubSidebarModelFilter', modelFilter);
    }
    if (teamLead) { (teamUi.revealForSearch || (lead => teamUi.setCollapsed(lead, false)))(teamLead); if (teamUi.isDismissed?.(memberId || id, teamLead)) teamUi.setLeftOpen?.(teamLead, true); }
    else if (member) {
      collapsedDetailsMeetings.delete(id);
      _expandedMeetings.add(id);
      _persistExpandedMeetings();
    }
    if (!pinnedOnly && Date.now() - latestActivityTime(item) >= recentDays * 86400000) {
      recentDays = 3;
      savePreference('hubSidebarRecentDays', '3'); syncRangeControls();
    }
    collapsedSections.delete(teamUi?.membersOf?.(item.id, getSessions(), getMeetings())?.length ? 'sec-projects' : 'sec-scraps');
    savePreference('hubSidebarCollapsedSections', JSON.stringify([...collapsedSections]));
    renderSessionList();
  }
  doc.addEventListener?.('sidebar:manage-pin', event => {
    if (!collectSidebarItems().some(item => item.id === event.detail?.id && item.pinned)) return;
    openContextMenu(event.detail.id, event.detail.x, event.detail.y);
  });
  let archivingToday = false;
  async function archiveToday() {
    if (archivingToday) return;
    archivingToday = true;
    const failures = [];
    try {
      const ipc = options.ipcRenderer || require('electron').ipcRenderer;
      const current = sidebarView(filteredSidebarItems());
      // 只休眠「零碎」里今天空闲的会话：项目负责人（下面还有成员在干活）和前台不动。
      const map = getSessions(), now = Date.now();
      const home = homeSections(current, map, item => classifySession(item, { now, sessionMap: map }), now, frontSession(map));
      const scraps = new Set(home.scraps);
      for (const item of current.today.filter(item => scraps.has(item) && !item.pinned && !sidebarItemHasUnread(item, map))) {
        try {
          // 已经自动休眠的会话没有进程可停，点「休眠」就是把它收进「已收起」。
          if (!item._isMeeting && item.status === 'dormant') { foldedIds.add(item.id); saveFolded(); continue; }
          const members = item._isMeeting ? (item._meeting.subSessions || []) : [item.id];
          for (const id of members) {
            if (getSessions().get(id)?.status === 'dormant') continue;
            const result = await ipc.invoke('suspend-session', { sessionId: id });
            if (!result?.ok) throw new Error(result?.message || result?.error || '休眠失败');
          }
          if (item._isMeeting) {
            const updated = await ipc.invoke('update-meeting-sync', { meetingId: item.id, fields: { status: 'dormant' } });
            if (!updated) throw new Error('群聊归档状态保存失败');
          }
        } catch (error) { failures.push((item.title || item.id) + '：' + error.message); }
      }
    } catch (error) { failures.push(error.message); }
    finally { archivingToday = false; renderSessionList(); }
    if (failures.length) {
      const message = '部分会话未归档，仍保留原入口：\n' + failures.join('\n');
      console.warn('[sidebar] archive:', message);
      if (options.notify) options.notify(message);
      else require('./ui-feedback').showHubAlert(message, { document: doc });
    }
  }

  // 方案 A 的分区（每次渲染算一遍，只读 sections 已有的分桶）：
  //   成员离队、成员未读或回复、整组完成都不影响负责人；只有成员在跑、等输入、待批准、出错、置顶或正被查看时才保住负责人，否则成员没入口。
  //   零碎 = 其余还在时间范围内的会话；已结束（休眠、没有未读、没出错、没置顶）的自动收进「已收起」。
  // Hub 重启后没重新打开的历史会话也显示为休眠（没有收工原因），它们照旧按时间范围留在零碎，不会一重启就全被收起。
  // 已结束且 ≥72h 无来往的旧回答（包括离队成员的未读）只保留历史入口，不再无限顶住项目。
  // 正在看、置顶、运行、等输入、出错、待批准或排队的会话/项目优先保留；不改状态和未读。
  const ENDED_REASONS = new Set(['user-suspend', 'user-close', 'manual']);
  function endedItem(item, c, sessionMap) {
    if (!c.dormant || c.unread || c.error || item._resumePending) return false;
    const endedSession = s => s?.status === 'dormant' && ENDED_REASONS.has(s.suspendReason);
    if (item._isMeeting) return item.status === 'dormant' && (item._meeting?.subSessions || []).every(id => !sessionMap.get(id) || endedSession(sessionMap.get(id)));
    return endedSession(item);
  }
  function homeSections(sections, sessionMap, classify, now, front) {
    const membersOf = projectLeadsOf(sessionMap);
    const teamUi = typeof window !== 'undefined' ? window.__teamUi : null;
    const live = new Set([...sections.failed, ...sections.active, ...sections.today]);
    const ended = item => endedItem(item, classify(item), sessionMap);
    const protectedItem = (item, keepSelection = true) => sidebarMustStayVisible(item, classify(item), {
      selected: keepSelection && (item._isMeeting ? getActiveMeetingId() === item.id : getActiveSessionId() === item.id),
      pending: !item._isMeeting && (teamUi?.planPending?.(item.id) || teamUi?.queuedCount?.(item.id) > 0),
    }) || (item._isMeeting && (item._meeting?.subSessions || []).some(id => sessionMap.has(id) && protectedItem(sessionMap.get(id), keepSelection)));
    const stale = (item, leadId) => {
      if (protectedItem(item)) return false;
      if (item._isMeeting) {
        const children = (item._meeting?.subSessions || []).map(id => sessionMap.get(id)).filter(Boolean);
        return now - latestActivityTime(item, now) >= 3 * 86400000 && children.length > 0
          && children.every(child => stale(child));
      }
      return sidebarCompletedAndStale(item, classify(item), { now, dismissed: !!teamUi?.isDismissed?.(item.id, leadId) });
    };
    const projects = [], scraps = [], collapsed = [];
    for (const item of [...sections.failed, ...sections.active, ...sections.today, ...sections.archive]) {
      const members = item._isMeeting || item.id === front?.id ? [] : membersOf(item.id);
      if (isHiddenNow(item, classify, sessionMap)) { collapsed.push(item); continue; }
      // 成员的未读和回复不算：只有在跑 / 等你 / 待批准 / 出错 / 置顶 / 正被查看才保住负责人这个入口。
      const memberBusy = (keepSelection = true) => members.some(id => { const s = sessionMap.get(id); return s && !isHiddenNow(s, classify, sessionMap) && protectedItem(s, keepSelection); });
      if (item.id !== front?.id && foldHides(item, classify(item)) && !protectedItem(item, false) && !memberBusy(false)) { collapsed.push(item); continue; }
      if (!item._isMeeting && item.id !== front?.id && (item.purpose === 'hub-assistant-desk' || isRetiredFront(item)) && !protectedItem(item) && (!classify(item).unread || stale(item)) && !memberBusy()) { collapsed.push(item); continue; }
      if (!protectedItem(item) && !memberBusy() && (!live.has(item) || stale(item) || ended(item))) { collapsed.push(item); continue; }
      // 登记过、还没招人的负责人也算项目（2026-11-15），排在「项目」里而不是「零碎」。
      if (members.length || (!item._isMeeting && item.id !== front?.id && teamUi?.isRegistered?.(item.id))) { projects.push(item); continue; }
      scraps.push(item);
    }
    const agg = item => Math.max(latestActivityTime(item), ...membersOf(item.id).map(id => latestActivityTime(sessionMap.get(id) || {})));
    projects.sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || (Number(!!a.bottomed) - Number(!!b.bottomed)) || agg(b) - agg(a));
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    let wait = 0, run = 0;
    for (const s of sessionMap.values()) {
      if (!s || s.id === front?.id || s.hiddenFromSidebar || s.kind === 'xresearch-run') continue;
      const c = classify(s);
      if (c.waiting && !c.error) wait += 1; else if (c.working && !c.error) run += 1;
    }
    return { projects, scraps, collapsed, collapsedCount: collapsed.length,
      collapsedToday: collapsed.filter(x => latestActivityTime(x) >= midnight.getTime()).length, wait, run };
  }

  function renderSessionList() {
    // One clock and one classification per item for the whole render: the
    // assistant snapshot and the sidebar sections used to classify all
    // sessions separately, three times a second.
    const renderNow = Date.now();
    const renderSessions = getSessions();
    const classifications = new Map();
    const classify = item => {
      let result = classifications.get(item);
      if (!result) { result = classifySession(item, { now: renderNow, sessionMap: renderSessions }); classifications.set(item, result); }
      return result;
    };
  publishSessionViews([...renderSessions.values()], { now: renderNow, classify });
    const renderStartedAt = nowMs();
    // Rebuilt rows join the same clock instead of restarting their pulse on
    // every runtime delta (which can otherwise make a busy logo look static).
    if(!sidebarPhaseInitialized){
      sessionListEl.style?.setProperty('--sidebar-work-phase', `${-(Date.now() % 24000)}ms`);
      sidebarPhaseInitialized=true;
    }
    const sessionMap = renderSessions;
  // partitionSidebarSessions applies the same stable placement sort. Filtering
  // preserves input order, so sorting both before and after it is redundant.
  const visible = filteredSidebarItems(sessionMap, false);
  const sections = sidebarView(visible, sessionMap, recentDays, { now: renderNow, classify });
  if (sideMode && wirelessControl) {
    const hidden = sideOnly ? [] : collectSidebarItems(sessionMap).filter(isSideSession);
    const failed = hidden.length ? new Set(partitionSidebarSessions(hidden, { now: renderNow, classify, sessionMap }).failed.map(x => x.id)) : new Set();
    const attention = hidden.filter(x => failed.has(x.id) || classify(x).unread).length;
    const label = String(attention || '');
    if (wirelessControl.textContent !== label) wirelessControl.textContent = label;
    wirelessControl.dataset.attention = attention ? (failed.size ? 'failed' : 'unread') : '';
  }
  const assistantOn = companyAssistantOn();
  const resident = assistantOn ? residentAssistant(sessionMap) : null;
  const front = frontSession(sessionMap);
  const home = homeSections(sections, sessionMap, classify, renderNow, front);
  const unreadMemberIds = new Set(Object.values(getMeetings()).flatMap(m => [...getMeetingUnreadMemberIds(m, sessionMap)]));
  // Grouping is unchanged only if every session's runtime/recency projection
  // still matches. For the actual visible rows also compare *all* source
  // metadata, external badges and exact time labels. Opaque/circular terminal
  // objects deliberately miss the cache. Check the live HTML too: another UI
  // owner (or hover styling) may have edited it since our last commit.
  let presentation = null;
  let presentationUnchanged = false;
  const previous = previousPresentation;
  try {
    const sources = new Set([...sections.failed, ...sections.active, ...sections.today, ...home.projects, ...home.scraps, ...(resident ? [resident] : []), ...(front ? [front] : [])]);
    for (const item of [...sources]) {
      const ids = item._isMeeting ? item._meeting.subSessions || []
        : typeof window !== 'undefined' ? window.__teamUi?.membersOf(item.id, sessionMap, getMeetings()) || [] : [];
      for (const id of ids) if (sessionMap.has(id)) sources.add(sessionMap.get(id));
    }
    const context = JSON.stringify([getActiveSessionId(), getActiveMeetingId(), detailsEnabled, modelFilter,
      [...collapsedSections], [...collapsedDetailsMeetings], [..._expandedMeetings], assistantOn, front?.id || null,
      home.projects.map(p => p.id), home.scraps.map(p => p.id), home.collapsedCount, home.collapsedToday, home.wait, home.run, [...foldedIds], [...hiddenIds]]);
    const rows = [...sources].map(item => {
      const at = latestActivityTime(item);
      const external = JSON.stringify([formatTime?.(at), sidebarRelativeTime(at),
        item._isMeeting ? null : accountBadge(item), item._isMeeting ? null : subscriptionAccount(item),
        item._isMeeting ? null : bridgeBadge(item.id),
        !item._isMeeting && typeof window !== 'undefined' ? window.__progressBadgeFor?.(item.id) : null,
        item.currentModel ? modelShort(item.currentModel) : null, unreadMemberIds.has(item.id),
        item._isMeeting ? null : sessionDisplayTitle(item, KIND_LABELS, getMeetings()[item.meetingId]),
        item._isMeeting || typeof window === 'undefined' ? null : window.__teamUi?.signature(item.id, sessionMap, getMeetings()) || null]);
      return cachePresentation(item, input => { Object.assign({}, input); return {}; }, external);
    });
    presentation = { sections, context, rows };
    presentationUnchanged = previous && previous.sections === sections && previous.context === context && rows.length === previous.rows.length
        && rows.every((row, i) => row === previous.rows[i]) && previous.html === sessionListEl.innerHTML;
  } catch { /* Custom metadata/badges keep the full renderer path. */ }
  if (presentationUnchanged) {
    renderSidebarStrip(sessionMap);
    if (afterRender) afterRender();
    if (detailsEnabled && options.requestSessionUsage) options.requestSessionUsage(previous.detailSessionIds);
    releaseHoveredMeeting();
    recordRenderCost();
    return;
  }
  // Preserve scroll position across rebuilds — without this, any re-render
  // (every status-event, silence-timer, or session-updated) snaps the list
  // back to the top, which feels like the sidebar is "fighting" the user.
  const savedScrollTop = sessionListEl.scrollTop;
  const focused = doc.activeElement;
  const focusId = focused?.dataset?.sessionId || focused?.dataset?.meetingId;
  const focusControl = focused?.dataset?.sidebarControl;
  const hadListFocus = focused && sessionListEl.contains?.(focused);
  // Build the entire status reclassification off-DOM, then commit once. A
  // running -> needs-input transition used to clear and repopulate the live
  // sidebar one node at a time, forcing repeated style/layout work and making
  // the window look frozen exactly when categories jumped.
  const fragment = typeof doc.createDocumentFragment === 'function'
    ? doc.createDocumentFragment()
    : null;
  const renderTarget = fragment || sessionListEl;
  if (!fragment) sessionListEl.innerHTML = '';

  // 负责人下面的成员：在队的照常排在前面；离队的（交付后休眠、被收工）一律沉到底部，
  function appendTeamMembers(leadId, members, children) {
    const teamUi = typeof window !== 'undefined' ? window.__teamUi : null;
    const shown = members.filter(m => m && (modelFilter === 'all' || familyOfKind(m.kind) === modelFilter) && !isHiddenNow(m, classify, sessionMap));
    const mustShow = m => sidebarMustStayVisible(m, classify(m), { selected: getActiveSessionId() === m.id });
    const dismissed = teamUi?.isDismissed ? shown.filter(m => teamUi.isDismissed(m.id, leadId) && !mustShow(m)) : [];
    // 手动折叠的成员和离队成员收进同一个小折叠里（2026-11-16）。
    const folded = shown.filter(m => !dismissed.includes(m)
      && ((foldHides(m, classify(m)) && !sidebarMustStayVisible(m, classify(m)))
        || (!mustShow(m) && sidebarCompletedAndStale(m, classify(m), { now: renderNow }))));
    const left = [...dismissed, ...folded];
    for (const m of shown) if (!left.includes(m)) appendItem(m, true, children);
    if (!left.length) return;
    const open = !!teamUi.isLeftOpen?.(leadId);
    const fold = doc.createElement('div');
    fold.className = 'team-left-fold' + (open ? ' is-open' : '');
    fold.dataset.sidebarRenderKey = 'team-left:' + leadId;
    fold.innerHTML = `<button type="button" class="team-left-toggle" data-team-left-toggle="${escapeHtml(leadId)}" data-sidebar-control="team-left:${escapeHtml(leadId)}" aria-expanded="${open}" title="${open ? '收起' : '展开'}已离队的 ${left.length} 个成员（交付后休眠或被收工；负责人再派活时会叫回）">`
      + `<span class="team-left-caret" aria-hidden="true">${open ? '▾' : '▸'}</span>${folded.length ? '已收起' : '已离队'} ${left.length}</button>`;
    children.appendChild(fold);
    if (open) for (const m of left) appendItem(m, true, children);
  }
  // 单条渲染（会话/会议），供「置顶 recent + 时间组」复用。
  const detailSessionIds = new Set();
  function appendItem(s, child = false, target = renderTarget, teamWrapped = false, project = null) {
    // 负责人组队：负责人行和它招的成员放进同一个分组，成员用群聊成员同款缩进子行，点开就是普通会话。
    const teamUi = !child && !teamWrapped && !s._isMeeting && typeof window !== 'undefined' ? window.__teamUi : null;
    const teamMembers = teamUi ? teamUi.membersOf(s.id, sessionMap, getMeetings()) : [];
    if (teamMembers.length) {
      // 方案 A：有成员的负责人就是一个项目文件夹，标题行就是负责人本人——左侧箭头只展开 / 收起，点标题打开负责人。
      const collapsed = !!teamUi.isCollapsed?.(s.id);
      const group = doc.createElement('div');
      group.className = 'sidebar-group team-group project-folder' + (collapsed ? ' is-collapsed' : '') + (teamMembers.includes(getActiveSessionId()) ? ' has-active-member' : '');
      group.dataset.sidebarGroup = s.id;
      group.dataset.sidebarRenderKey = 'team:' + s.id;
      group.dataset.sidebarRenderTree = 'true';
      target.appendChild(group);
      appendItem(s, false, group, true, { members: teamMembers, collapsed });
      if (collapsed) return;
      const children = doc.createElement('div');
      children.className = 'sidebar-group-children';
      children.dataset.sidebarRenderKey = 'team-members:' + s.id;
      children.dataset.sidebarRenderTree = 'true';
      group.appendChild(children);
      appendTeamMembers(s.id, teamMembers.map(id => sessionMap.get(id)), children);
      return;
    }
    if (s._isMeeting) {
      const meeting = s._meeting;
      const memberIds = meeting.subSessions || [];
      const isActive = getActiveMeetingId() === s.id;
      const isDormant = s.status === 'dormant';
      const unreadMembers = getMeetingUnreadMemberIds(meeting, sessionMap);
      const hasUnread = classify(s).unread;
      const runtime = _meetingRuntimeAggregate(meeting, sessionMap);
      const dotCls = sections.states.get(s.id) || 'idle';
      const group = doc.createElement('div');
      // All rooms keep the same parent row and visible, indented member rows.
      // Unread/runtime/detail preferences change indicators, never the layout.
      group.className = 'sidebar-group'
        + (memberIds.includes(getActiveSessionId()) ? ' has-active-member' : '');
      group.dataset.sidebarGroup = s.id;
      group.dataset.sidebarRenderKey = 'group:' + s.id;
      group.dataset.sidebarRenderTree = 'true';
      target.appendChild(group);
      const div = doc.createElement('div');
      div.className = 'session-item slim meeting gc'
        + (runtime.failed ? ' runtime-error' : '')
        + (runtime.running ? ' running' : '')
        + (isActive ? ' selected' : '')
        + (isDormant ? ' dormant' : '')
        + (hasUnread ? ' need-unread' : '');
      div.dataset.meetingId = s.id;
      div.dataset.sidebarRenderKey = 'meeting:' + s.id;
      div.dataset.state = dotCls;
      div.tabIndex = 0;
      const warning = memberIds.map(id => {
        const member = sessionMap.get(id);
        const text = _sessionWarningText(member);
        return text ? `${member?.title || member?.kind || '成员'}：${text}` : '';
      }).filter(Boolean).join('；');
      const selected = Array.isArray(meeting.participants) ? meeting.participants.length : memberIds.length;
      div.setAttribute('aria-label', [s.title, isDormant ? '休眠中' : '',
        `${selected}/${memberIds.length} 已选`, warning, `${unreadMembers.size} 位未读`].filter(Boolean).join(' · '));
      const logos = memberIds.slice(0, 2).map(id => {
        const member = sessionMap.get(id);
        if (!member) return '';
        let state = partitionSidebarSessions([member], { sessionMap, groupMemberIds: new Set([id]) }).states.get(id) || 'idle';
        if (getSessionRuntimeTruth(member).state === RUNTIME_DORMANT && !member._resumePending && state !== 'error') state = 'dorm';
        return _sessionKindHtml(member.kind, member.currentModel ? modelShort(member.currentModel) : '', state, '', require('../core/codeagent-models').iconModelId(member), id, subscriptionAccount(member));
      }).join('');
      div.innerHTML = '<div class="sl-line1">'
        + '<span class="sl-group-logos" data-state="' + dotCls + '" aria-label="群聊 · ' + STATUS_LABELS[dotCls] + '">'
        + (logos || `<svg class="sl-kind sl-group-icon" data-state="${dotCls}" role="img" aria-label="群聊" viewBox="0 0 24 24"><path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 5a3 3 0 0 1 0 6m1 3a4 4 0 0 1 4 4v2"/></svg>`) + '</span>'
        + '<span class="sl-title" title="' + escapeHtml(s.title) + '">' + _warningHtml(warning) + escapeHtml(s.title)
        + (meeting.orchestration?.enabled === true ? '<span class="sl-orch-tag" title="负责人模式：用户只和负责人对话">负责人</span>' : '') + '</span>'
        + timeHtml(s, hasUnread ? Math.max(1, unreadMembers.size) : 0) + '</div>';
      div.addEventListener('contextmenu', event => {
        event.preventDefault();
        openContextMenu(s.id, event.clientX, event.clientY);
      });
      group.appendChild(div);
      const children = doc.createElement('div');
      children.className = 'sidebar-group-children';
      children.dataset.sidebarRenderKey = 'members:' + s.id;
      children.dataset.sidebarRenderTree = 'true';
      group.appendChild(children);
      for (const id of memberIds) {
        const member = sessionMap.get(id);
        if (member && (modelFilter === 'all' || familyOfKind(member.kind) === modelFilter) && !isHiddenNow(member, classify, sessionMap)) appendItem(member, true, children);
      }
      return;
    }

    // Compact rows: stateful provider logo, title, and abbreviated activity time.
    // Runtime/context/unread details remain available through accessible labels.
    const isActive = s.id === getActiveSessionId();
    const runtimeTruth = getSessionRuntimeTruth(s, { now: Date.now() });
    const div = doc.createElement('div');
    div.tabIndex = 0;
    div.dataset.sessionId = s.id;
    div.dataset.sidebarRenderKey='session:'+s.id;
    div.dataset.runtimeState = runtimeTruth.state;
    div.dataset.runtimeSource = runtimeTruth.source || '';
    div.dataset.runtimeConfidence = runtimeTruth.confidence || '';
    const isDormant = runtimeTruth.state === RUNTIME_DORMANT;
    const isResumePending = s._resumePending === true;
    const issue = sessionRuntimeIssue(s, runtimeTruth);
    const isDisconnected = issue?.label === '连接异常';
    const dormantCls = isDormant ? ' dormant' : '';
    const showWaiting = runtimeTruth.state === RUNTIME_WAITING;
    const unreadCount = Math.max(0, Number(s.unreadCount) || 0);
    const showUnread = sessionHasCompletedUnread(s) || unreadMemberIds.has(s.id);
    // 已确认异常和待核对断连优先，不能被未读或选中状态掩盖。
    const dotCls = issue ? 'error' : s._resumePending ? 'start' : (child
      ? partitionSidebarSessions([s], { sessionMap, activeSessionId: getActiveSessionId(), groupMemberIds: new Set([s.id]) }).states.get(s.id)
      : sections.states.get(s.id)) || 'idle';
    const showRunning = dotCls === 'run' || dotCls === 'start';
    div.className = 'session-item slim' + (isActive ? ' selected' : '')
      + (showWaiting ? ' need-wait' : '') + (showUnread ? ' need-unread' : '') + dormantCls
      + (showRunning ? ' running' : '')
      + (isResumePending ? ' resuming' : '')
      + (issue ? ' runtime-error' : '')
      + (isDisconnected ? ' disconnected' : '');
    const ctxPct = typeof s.contextPct === 'number' ? s.contextPct : null;
    const modelTxt = s.currentModel ? modelShort(s.currentModel) : '';
    const anyWarning = _sessionWarningText(s);
    const dormantStateTip = isResumePending
      ? '正在唤醒原生 CLI 与历史上下文'
      : isDormant
      ? `${s.suspendReason === 'idle-timeout' ? '自动休眠' : '休眠中'}${showUnread ? `，有 ${unreadCount} 条未读` : ''}，点击唤醒`
      : '';
    const displayTitle = sessionDisplayTitle(s, KIND_LABELS, getMeetings()[s.meetingId]);
    const account = accountBadge(s);
    const accessibleSummary = [displayTitle,
      account ? account.title : '',
      s.currentModel ? (s.currentModel.displayName || s.currentModel.id) : '',
      ctxPct != null ? `Ctx ${ctxPct}%` : '',
      anyWarning,
      isDisconnected ? '连接已断开，点击进入核对' : '',
      runtimeTruthSummary(runtimeTruth),
      dormantStateTip || (showWaiting
        ? (s.waitingText || '等你输入')
        : (showUnread ? (s.replyReadyText || s.lastOutputPreview || '有完成结果尚未查看') : '')),
    ].filter(Boolean).join(' · ');
    div.setAttribute('aria-label', accessibleSummary);
    // 放在标题格里不占列，悬停看代称（个人账号 / 号池 · 号 N）。拿不到字母时不显示。
    const accountHtml = account ? `<span class="sl-acct" title="${escapeHtml(account.title)}">${escapeHtml(account.letter)}</span>` : '';
    const bridge = bridgeBadge(s.id);
    // 进展卡状态点 / 待拍板标签（2026-10-27，renderer/progress-view.js）：没有进展卡的会话不显示。悬停标题能看到白话现状。
    const progress = typeof window !== 'undefined' && typeof window.__progressBadgeFor === 'function' ? window.__progressBadgeFor(s.id) : null;
    const bridgeHtml = bridge && bridge.role === 'restart' ? `<span class="bt-badge" data-state="${escapeHtml(bridge.state)}" data-role="${escapeHtml(bridge.role || '')}" title="${escapeHtml(bridge.sub)}">${escapeHtml(bridge.chip)}</span>` : '';
    div.innerHTML = _sessionKindHtml(s.kind, modelTxt, isDormant && !isResumePending && !issue ? 'dorm' : dotCls, dormantStateTip || (issue?.label === '上轮未完成' ? `${issue.label}：${issue.message}` : runtimeTruthSummary(runtimeTruth)), require('../core/codeagent-models').iconModelId(s), '', subscriptionAccount(s))
      + '<span class="sl-title" title="' + escapeHtml(displayTitle + (progress ? '\n' + progress.tip : '')) + '">' + _warningHtml(anyWarning) + (progress ? progress.html : '') + accountHtml + bridgeHtml + escapeHtml(displayTitle) + '</span>'
      + (project ? projectChipsHtml(s, project, showUnread) : timeHtml(s, showUnread ? Math.max(1, unreadCount) : 0));
    const teamTag = typeof window === 'undefined' ? '' : project ? projectTagHtml(s.id) : window.__teamUi?.rowTagHtml(s.id, sessionMap, getMeetings());
    if (project) {
      div.className += ' project-head' + (project.collapsed ? '' : ' is-open');
      div.draggable = false;
      const n = project.members.length;
      div.insertAdjacentHTML?.('afterbegin', `<button type="button" class="project-caret" data-team-toggle="${escapeHtml(s.id)}" data-sidebar-control="team:${escapeHtml(s.id)}" aria-expanded="${!project.collapsed}" aria-label="${project.collapsed ? '展开' : '收起'} ${n} 个成员" title="${project.collapsed ? '展开' : '收起'} ${n} 个成员（不打开会话）"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>`);
      div.setAttribute('aria-label', '项目 · ' + accessibleSummary + ` · ${n} 个成员`);
    }
    if (teamTag) {
      const titleEl = div.querySelector?.('.sl-title');
      if (titleEl) titleEl.insertAdjacentHTML('afterbegin', teamTag); // 放标题前：长标题被省略号截断时标签仍看得见
    }
    if (child) div.className += ' child';
    if (detailsEnabled) {
      div.className += ' has-details';
      div.innerHTML = '<div class="sl-line1">' + div.innerHTML + '</div>'
        + detailsHtml(s, { escapeHtml, modelShort })
        + (bridge ? `<div class="bt-badge-sub" data-state="${escapeHtml(bridge.state)}">⇄ ${escapeHtml(bridge.sub)}${bridge.pin ? ' · ' + escapeHtml(bridge.pin) : ''}</div>` : '');
      detailSessionIds.add(s.id);
    }
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY); });
    target.appendChild(div);
  }

  // 项目文件夹标题行右侧（和原型一致只放两样）：成员里「N 等你」/「卡住」，再是成员数（不含负责人）。
  // 成员在跑时成员数变蓝、成员有新消息时右上角一个浅色小点，细节在悬停提示里；负责人自己的状态在它的图标上。
  function projectChipsHtml(lead, project, leadUnread) {
    const states = project.members.map(id => sessionMap.get(id)).filter(Boolean).map(m => classify(m));
    const wait = states.filter(c => c.waiting && !c.error).length, bad = states.filter(c => c.error).length;
    const run = states.filter(c => c.working && !c.waiting && !c.error).length, red = states.filter(c => c.unread).length;
    // 数字只算在队的成员；离队的另注一句（2026-11-15：离队成员沉底折叠）。
    const left = project.members.filter(id => window.__teamUi?.isDismissed?.(id, lead.id)).length;
    const n = project.members.length - left, at = latestActivityTime(lead);
    const tip = [`${n} 个在队成员（不含负责人）`, left ? `${left} 个已离队` : '', run ? `${run} 个在跑` : '', wait ? `${wait} 个等你` : '', bad ? `${bad} 个运行异常` : '', red ? `${red} 个成员有新消息` : '',
      leadUnread ? '负责人有新消息' : '', `负责人最近活动 ${formatTime?.(at) || sidebarRelativeTime(at)}`].filter(Boolean).join(' · ');
    return '<span class="pj-chips">'
      + (wait ? `<span class="pj-chip wait" title="${wait} 个成员停在等你">${wait} 等你</span>` : '')
      + (bad ? `<span class="pj-chip bad" title="${bad} 个成员运行异常">卡住</span>` : '')
      + `<span class="pj-count${run ? ' running' : ''}${red ? ' has-member-unread' : ''}" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">${n}</span></span>`;
  }
  function projectTagHtml(id) {
    const teamUi = window.__teamUi;
    if (teamUi?.planPending?.(id)) return `<button type="button" class="team-pending-badge" data-team-approve="${escapeHtml(id)}" title="负责人提交了招人计划，点开批准或驳回">待批准</button>`;
    const queued = teamUi?.queuedCount?.(id) || 0;
    return queued ? `<span class="sl-orch-tag team-queued-tag" title="同时干活的成员只有防失控的安全阀（默认每队、全机各 100 个），这 ${queued} 人排队；前面有人交付或休眠后 Hub 自动开工">排队 ${queued}</span>` : '';
  }
  // 前台置顶行：永远第一行，不能拖、不能关、不参与排序；点它和点普通会话一样打开前台。
  // 第二行写前台自己的状态，再写全 Hub 有几件等你、几个在跑；右边是前台的未读数或「等你」。
  function appendFrontPin(front) {
    const wrap = doc.createElement('div');
    wrap.className = 'sidebar-group front-group';
    wrap.dataset.sidebarRenderKey = 'front-pin';
    wrap.dataset.sidebarRenderTree = 'true';
    renderTarget.appendChild(wrap);
    const row = doc.createElement('div');
    row.tabIndex = 0;
    row.draggable = false;
    row.addEventListener('dragstart', event => event.preventDefault());
    const totals = [home.wait ? `${home.wait} 件等你` : '', home.run ? `${home.run} 个在跑` : ''].filter(Boolean).join(' · ');
    if (!front) {
      row.className = 'session-item front-pin is-empty';
      row.dataset.sidebarRenderKey = 'front-pin-row';
      row.innerHTML = '<span class="fp-avatar" data-state="idle">前</span><span class="fp-main"><span class="fp-line1"><b class="fp-title">前台</b><span class="fp-pin">置顶</span></span><span class="fp-sub">还没打开 · 点一下启动前台</span></span>';
      row.title = '启动 Hub 助理的前台会话';
      row.addEventListener('click', async () => {
        try {
          const r = await homeIpc?.invoke?.('assistant:ensure-session');
          if (!r?.sessionId) throw new Error(r?.error || '没有拿到前台会话');
          boundFrontSid = r.sessionId;
          await selectSession?.(r.sessionId, { forceScrollBottom: true });
        } catch (error) { require('./ui-feedback').showHubAlert('前台没能启动：' + error.message + '。可以稍后再点一次前台。', { document: doc }); }
      });
      wrap.appendChild(row);
      return;
    }
    const c = classify(front);
    const state = c.error ? 'error' : c.waiting ? 'wait' : c.working ? 'run' : c.unread ? 'unread' : c.dormant ? 'dorm' : 'idle';
    const own = { error: '运行异常', wait: '等你回复', run: '在跑', unread: '有新消息', dorm: '休眠中，点击唤醒', idle: '' }[state];
    const unreadCount = c.unread ? Math.max(1, Number(front.unreadCount) || 0) : 0;
    row.className = 'session-item front-pin' + (front.id === getActiveSessionId() ? ' selected' : '')
      + (state === 'run' ? ' running' : '') + (state === 'wait' ? ' need-wait' : '') + (c.unread ? ' need-unread' : '') + (state === 'error' ? ' runtime-error' : '');
    row.dataset.sessionId = front.id;
    row.dataset.sidebarRenderKey = 'session:' + front.id;
    row.dataset.state = state;
    const sub = [own, totals || (own ? '' : '没有在跑的会话')].filter(Boolean).join(' · ');
    const badge = state === 'wait' ? '<span class="fp-badge wait">等你</span>' : unreadCount ? `<span class="fp-badge unread" aria-label="${unreadCount} 条未读">${unreadCount}</span>` : '';
    row.innerHTML = `<span class="fp-avatar" data-state="${state}">前</span><span class="fp-main"><span class="fp-line1"><b class="fp-title">前台</b><span class="fp-pin" title="永久置顶：不能拖动、不能关闭，始终指向当前在用的前台会话">置顶</span></span><span class="fp-sub">${escapeHtml(sub)}</span></span>${badge}`;
    row.setAttribute('aria-label', ['前台（永久置顶）', own, totals, unreadCount ? `${unreadCount} 条未读` : ''].filter(Boolean).join(' · '));
    row.title = '前台 · ' + (sessionDisplayTitle(front, KIND_LABELS, null) || '') + (front.currentModel ? ' · ' + modelShort(front.currentModel) : '');
    row.addEventListener('contextmenu', event => { event.preventDefault(); openContextMenu(front.id, event.clientX, event.clientY); });
    wrap.appendChild(row);
    // 右键「创建子会话…」挂到前台下的成员：做完（休眠且没有未读）的不再占位，搜索照样找得到；
    // 离队的收进底部「已离队 N」折叠行，不占位也能点开找到。
    const members = projectLeadsOf(sessionMap)(front.id).map(id => sessionMap.get(id))
      .filter(m => m && (!endedItem(m, classify(m), sessionMap) || window.__teamUi?.isDismissed?.(m.id, front.id)));
    if (!members.length) return;
    const children = doc.createElement('div');
    children.className = 'sidebar-group-children';
    children.dataset.sidebarRenderKey = 'front-members';
    children.dataset.sidebarRenderTree = 'true';
    wrap.appendChild(children);
    appendTeamMembers(front.id, members, children);
  }
  function appendSecHeader(label, items, cls, action, onAction) {
    const collapsed = collapsedSections.has(cls);
    const h = doc.createElement('div');
    h.className = 'session-sec-header ' + cls;
    h.dataset.sidebarRenderKey='section:'+cls;
    h.innerHTML = '<button type="button" class="sec-collapse" data-sidebar-control="' + cls + '" aria-label="' + (collapsed ? '展开' : '折叠') + label + '" aria-expanded="' + !collapsed + '">' + (collapsed ? '▸' : '▾') + '</button><span>' + label + '</span><span class="sec-count">' + items.length + '</span><span class="sec-rule"></span>'
      + (action ? '<button type="button" class="sec-action ' + (cls === 'sec-unread' ? 'sec-mark-all-read' : '') + '">' + action + '</button>' : '');
    h.addEventListener('click', event => {
      if (event.target?.closest?.('.sec-collapse') || /sec-collapse/.test(event.target?.className || '')) {
        event.preventDefault(); event.stopPropagation();
        if (collapsedSections.has(cls)) collapsedSections.delete(cls); else collapsedSections.add(cls);
        savePreference('hubSidebarCollapsedSections', JSON.stringify([...collapsedSections]));
        renderSessionList();
        return;
      }
      if (!event.target?.closest?.('.sec-action') && !/sec-action|sec-mark-all-read/.test(event.target?.className || '')) return;
      event.preventDefault(); event.stopPropagation();
      return onAction?.();
    });
    renderTarget.appendChild(h);
    if (!collapsed) for (const item of items) appendItem(item);
  }
  // 「助理」一栏：常驻最上面，不受筛选影响；会话还没打开时放一行「点击打开」。
  if (assistantOn) {
    const h = doc.createElement('div');
    h.className = 'session-sec-header sec-resident';
    h.dataset.sidebarRenderKey = 'section:sec-resident';
    h.innerHTML = '<span>助理</span><span class="sec-rule"></span>';
    renderTarget.appendChild(h);
    if (resident) appendItem(resident);
    else {
      const row = doc.createElement('div');
      row.className = 'session-item slim resident-placeholder';
      row.dataset.sidebarRenderKey = 'resident-placeholder';
      row.tabIndex = 0;
      row.innerHTML = '<span class="sl-title">工作助理</span><span class="sl-time">点击打开</span>';
      row.title = '打开工作助理的 CodeAgent 会话（没开着就恢复或新开一个）';
      row.addEventListener('click', () => { void doc.defaultView?.__companyAssistantOpenSession?.(); });
      renderTarget.appendChild(row);
    }
  }
  if (front || frontEnabled()) appendFrontPin(front);
  if (home.projects.length) appendSecHeader('项目', home.projects, 'sec-projects');
  appendSecHeader('零碎', home.scraps, 'sec-scraps', !pinnedOnly && home.scraps.length ? '休眠' : '', archiveToday);
  if (!home.scraps.length && !collapsedSections.has('sec-scraps')) {
    const empty = doc.createElement('div');
    empty.className = 'sidebar-empty-hint';
    empty.dataset.sidebarRenderKey = 'scraps-empty';
    empty.textContent = pinnedOnly ? '没有置顶的零碎会话' : '没有零碎会话';
    renderTarget.appendChild(empty);
  }
  if (markAllSessionsRead && visible.some(item => classify(item).unread)) {
    const read = doc.createElement('button'); read.type = 'button'; read.className = 'sidebar-mark-read';
    read.textContent = '全部已读'; read.addEventListener('click', markAllSessionsRead); renderTarget.appendChild(read);
    read.dataset.sidebarRenderKey='mark-all-read';
  }
  // 「已收起」（原「归档」）：休眠了的、超出时间范围的会话都在这里；点开是同一个搜索·休眠范围。
  const archive = doc.createElement('button');
  archive.type = 'button';
  archive.className = 'session-archive-entry';
  archive.dataset.sidebarRenderKey='archive';
  archive.title = '已结束（休眠）或超出时间范围的会话，点开搜索找回';
  archive.innerHTML = '<svg class="archive-box" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v3H4zM5 10v9h14v-9M10 14h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg><span>已收起</span><span class="archive-count">今天 ' + home.collapsedToday + ' · 共 ' + home.collapsedCount + '</span>';
  archive.addEventListener('click', () => openSearch({ scope: 'dormant' }));
  renderTarget.appendChild(archive);

  if (fragment) {
    if (typeof sessionListEl.replaceChildren === 'function') reconcileSidebarDom(sessionListEl,fragment);
    else {
      sessionListEl.innerHTML = '';
      sessionListEl.appendChild(fragment);
    }
  }

  renderSidebarStrip(sessionMap);

  if (afterRender) afterRender();
  if (detailsEnabled && options.requestSessionUsage) options.requestSessionUsage([...detailSessionIds]);

  previousPresentation = presentation ? { ...presentation, html: sessionListEl.innerHTML, detailSessionIds: [...detailSessionIds] } : null;

  sessionListEl.scrollTop = savedScrollTop;
  // Whole-list updates must preserve a stationary pointer's expanded group.
  // If sorting moved that group away, release it at its new geometry.
  releaseHoveredMeeting();
  function releaseHoveredMeeting() {
    if (hoverPoint && hoveredMeetingId && sessionListEl.querySelectorAll) {
      const group = [...sessionListEl.querySelectorAll('.sidebar-group')].find(el => el.dataset.sidebarGroup === hoveredMeetingId);
      const rect = group?.getBoundingClientRect();
      if (!rect || hoverPoint.x < rect.left || hoverPoint.x > rect.right || hoverPoint.y < rect.top || hoverPoint.y > rect.bottom) {
        hoveredMeetingId = null;
        group?.classList.remove('hover-open');
      }
    }
  }
  if (hadListFocus && focusId) {
    const replacement = [...sessionListEl.querySelectorAll('.session-item')].find(row => (row.dataset.sessionId || row.dataset.meetingId) === focusId);
    replacement?.focus({ preventScroll: true });
  }
  if (hadListFocus && focusControl) {
    [...sessionListEl.querySelectorAll('[data-sidebar-control]')].find(control => control.dataset.sidebarControl === focusControl)?.focus({ preventScroll: true });
  }
  recordRenderCost();
  function recordRenderCost() {
    const elapsed = Math.max(0, nowMs() - renderStartedAt);
    renderStats.renders += 1;
    renderStats.lastMs = elapsed;
    renderStats.maxMs = Math.max(renderStats.maxMs, elapsed);
    if (elapsed >= 50) renderStats.slowRenders += 1;
  }
}

// --- Session card hover light-tracking + click ripple (event delegation) ---
sessionListEl.addEventListener('mousemove', (e) => {
  const group = e.target.closest('.sidebar-group');
  hoveredMeetingId = group?.dataset.sidebarGroup || null;
  hoverPoint = { x: e.clientX, y: e.clientY };
  for (const wrapper of sessionListEl.querySelectorAll('.sidebar-group')) {
    wrapper.classList.toggle('hover-open', wrapper.dataset.sidebarGroup === hoveredMeetingId);
  }
  const item = e.target.closest('.session-item');
  if (!item) return;
  const rect = item.getBoundingClientRect();
  item.style.setProperty('--mx', ((e.clientX - rect.left) / rect.width * 100) + '%');
  item.style.setProperty('--my', ((e.clientY - rect.top) / rect.height * 100) + '%');
});
sessionListEl.addEventListener('mouseleave', () => {
  hoveredMeetingId = null;
  hoverPoint = null;
  for (const wrapper of sessionListEl.querySelectorAll('.sidebar-group')) wrapper.classList.remove('hover-open');
});
sessionListEl.addEventListener('mousedown', (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const rect = item.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const r = doc.createElement('span');
  r.className = 'ripple-fx';
  r.style.width = r.style.height = size + 'px';
  r.style.left = (e.clientX - rect.left - size / 2) + 'px';
  r.style.top = (e.clientY - rect.top - size / 2) + 'px';
  item.appendChild(r);
  setTimeout(() => r.remove(), 450);
});



  queueMicrotask(() => projectFilter.refresh());

  return {
    renderSessionList,
    revealSearchItem,
    renderSidebarStrip,
    getRenderStats: () => ({ ...renderStats }),
    // 「会话详情」打开时每行显示累计用量与上下文，触发端据此判断用量变化算不算可见（renderer/surface-change-gate.js）。
    isDetailsEnabled: () => detailsEnabled,
  };
}

module.exports = {
  isWirelessSession,
  isAssistantSession,
  isSideSession,
  createSessionListRenderer,
  showDomesticRoute,
  compareLatestActivityDesc,
  compareSidebarPlacement,
  isPinnedToBottom,
  partitionSessionsByAge,
  latestActivityTime,
  familyOfKind,
  sessionFamilies,
  SESSION_FAMILY_TABS,
  AGENT_SESSION_GROUPS,
  agentGroupOf,
  partitionSidebarSessions,
  getSidebarSearchEntries,
};
