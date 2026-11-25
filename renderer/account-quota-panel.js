'use strict';

// 右侧账号看板（2026-10-28 方案 C；10-29 扩到 Codex、Gemini）：按 Claude → Codex → Gemini 分段，
// 2026-10-31 用户选定 A：每号一行，只留编号 + 5h 已用/重置 + 7d 待恢复/重置；全名与详情放悬停。
// 第二行灰字：邮箱名、出口 IP、推测续费日。没有 5h 的号（Codex）一个 7d 胶囊占满两格。
// 可收起成编号细栏。看板显示时，底栏里这三家的逐号格子各收成一格「可用/总数」，点它开关看板。
// 数据只读 accountUsageController 的快照，不另取额度；IP 地点经 main 的缓存查询（每个 IP 查一次）。

const { remainingPercent, formatResetCountdown } = require('./sidebar-account-usage.js');

const accountRisk = require('./account-risk-state');
const peerReserve = require('../core/codex-peer-reserve');
const { planTier } = require('../core/account-plan-tier');
const riskKind = provider => (provider === 'antigravity' ? 'gemini' : provider);
// 「已共享」小图标（2026-11-19）：三个相连的小圆点，灰蓝、贴在编号右上角；共享给谁看悬停。
const SHARE_MARK = '<svg class="cq-share-mark acct-share-mark" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.4 5 7.6 2.4M2.4 5l5.2 2.6"/><circle cx="2.4" cy="5" r="1.5"/><circle cx="7.6" cy="2.4" r="1.5"/><circle cx="7.6" cy="7.6" r="1.5"/></svg>';
const STORAGE_KEY = 'hubClaudeQuotaPanel';
//   右键号卡 = 在额度栏隐藏；右键分组标题 = 恢复显示这一组隐藏的号。
//   Gemini 家庭组成员 Antigravity 也给「升级入口」，自动推测会误判成 Pro，只能人工指定。
// 人工档位绑定账号归属指纹的前 16 位（scope：账号目录 + 登录身份 + 出口），别人同名的「账号 2」、
// 或这个槽位换登录了别的 Google 号，都对不上、不生效，回到自动推测。
// 小标只放得下几个字：「Ultra 5X 家庭组」写成「Ultra 5X」，分组小标题仍写全名。
const shortTier = label => String(label || '').replace(/\s*家庭组$/, '').trim() || String(label || '');
const PREFS_SEED = { id: 'none', hidden: [], tiers: {} };
const prefKey = (provider, profileId) => provider + ':' + (profileId || '');
const USABLE_MIN = 15;
const LOW_MARK = 25;
const SOON_MS = { '5h': 45 * 60_000, '7d': 36 * 3600_000 };
const PROVIDERS = [
  { id: 'claude', name: 'Claude', logo: 'claude' },
  { id: 'codex', name: 'Codex', logo: 'codex' },
  { id: 'antigravity', name: 'Gemini', logo: 'gemini' },
];

function level(pct) {
  if (pct === null || pct === undefined) return 'off';
  if (pct < USABLE_MIN) return 'bad';
  if (pct <= 40) return 'warn';
  return 'ok';
}

// 有效剩余：5h 与 7d 里更紧的那个；两个都没有数据时为 null。
function effective(row) {
  const values = [row.remain5h, row.remain7d].filter(v => v !== null);
  return values.length ? Math.min(...values) : null;
}

const resetAt = window => (window?.resetsAt ? new Date(window.resetsAt).getTime() : NaN);

// 各家窗口的取法与底栏一致：Codex 订阅常没有 5h；Gemini 读 gemini 模型组。
function windowsOf(provider, row, now) {
  if (provider === 'antigravity') {
    const g = (row.groups || []).find(x => x.id === 'gemini') || null;
    return { w5h: g?.usage5h || null, w7d: g?.usage7d || null };
  }
  let w5h = row.usage5h || null;
  // 5h 窗口不可能在 5 小时以后才重置；旧缓存把 Codex 周窗口误记成 5h 时丢掉。
  if (provider === 'codex' && w5h && resetAt(w5h) > now + 5.5 * 3600_000) w5h = null;
  return { w5h, w7d: row.usage7d || null };
}

function wholePercent(window) {
  const pct = remainingPercent(window);
  return pct === null ? null : Math.round(pct);
}

// 过了重置时间记录仍没更新，说明重置后没在 Hub 用过，这个窗口就是满的，按 100% 算，不再写「待刷新」。
// 刷新报错的号（有在线会话却没读到）拿不准，Codex、Gemini 可能在 Hub 外用，都照旧写「待刷新」。
function windowView(provider, window, now, failed) {
  const pct = wholePercent(window), at = resetAt(window);
  const assumed = !failed && pct !== null && Number.isFinite(at) && at <= now;
  return { pct: assumed ? 100 : pct, at, assumed };
}

function viewRows(provider, snapshot, currentProfileId, now) {
  const rows = snapshot?.accounts?.[provider];
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => {
    const { w5h, w7d } = windowsOf(provider, row, now);
    const v5 = windowView(provider, w5h, now, !!row.error), v7 = windowView(provider, w7d, now, !!row.error);
    const view = {
      provider, no: index + 1, profileId: row.profileId || '',
      label: row.profileLabel || row.profileId || ('账号' + (index + 1)),
      remain5h: v5.pct, remain7d: v7.pct, reset5h: v5.at, reset7d: v7.at, assumed5h: v5.assumed, assumed7d: v7.assumed,
      has5h: provider === 'claude' || !!w5h,
      egress: (provider === 'claude' || provider === 'antigravity') ? (row.egressIp || '') : '', apiKey: !!row.apiKey,
      error: row.error || '', inFlight: !!row.inFlight, selected: !!row.selected, scope: typeof row.scope === 'string' ? row.scope : '',
      lastSeen: Number(row.lastSeen) || 0,
      email: row.email || '', plan: row.plan || '', planMultiplier: Number(row.planMultiplier) || 1, billing: row.billing || '', subscribedAt: row.subscribedAt || 0,
      subscriptionUntil: row.subscriptionUntil || 0, subscriptionChecked: row.subscriptionChecked || 0,
      upgradeOffered: typeof row.upgradeOffered === 'boolean' ? row.upgradeOffered : null,
      credits: typeof row.credits === 'number' && Number.isFinite(row.credits) ? row.credits : null,
      creditsError: row.creditsError || '',
      groups: Array.isArray(row.groups) ? row.groups : [],
      limitReachedType: row.limitReachedType || '', resetCredits: Number.isFinite(row.resetCredits) ? row.resetCredits : null,
      resetCreditExpiries: Array.isArray(row.resetCreditExpiries) ? row.resetCreditExpiries : [],
    };
    // 档位（2026-11-22）：三家都按档位分组，档位高的在前；Claude 的 rank 就是 5X / 20X 倍数。
    const tier = planTier(provider, view);
    view.tierRank = tier.rank; view.tierLabel = tier.label; view.tierShort = tier.short; view.tierNote = tier.note;
    view.eff = effective(view);
    view.current = currentProfileId ? view.profileId === currentProfileId : view.selected;
    if (view.eff !== null && view.eff < USABLE_MIN) {
      const by5h = view.remain5h !== null && (view.remain7d === null || view.remain5h <= view.remain7d);
      view.blockedBy = by5h ? '5h' : '7d';
      const at = by5h ? view.reset5h : view.reset7d;
      view.backIn = Number.isFinite(at) && at > now ? formatResetCountdown(at, now) : '';
    }
    return view;
  });
}

const mmdd = ms => { const d = new Date(ms); return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const ymd = ms => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
// Codex 的 Pro 分 5X / 20X 两档，套餐名统一走 core/account-plan-tier.js。
const LIMIT_REASONS = { workspace_member_credits_depleted: 'Team 工作区的成员额度已用完，要等工作区管理员加额度或下周重置' };
// 官方给的「已到上限」原因与免费整周重置次数（2026-11-22，来自 OpenAI 官方额度接口）。
function codexFactLines(row, now) {
  const lines = [];
  if (row.limitReachedType) lines.push('官方提示：' + (LIMIT_REASONS[row.limitReachedType] || '已到上限（' + row.limitReachedType + '）'));
  // 有逐次到期时间就按它数（去掉已过期的），没有就用官方给的总数。
  const list = row.resetCreditExpiries || [];
  const valid = list.filter(at => !at || at > now), dated = valid.filter(Boolean).sort((a, b) => a - b);
  const count = list.length ? valid.length : (row.resetCredits || 0);
  if (count > 0) lines.push('免费整周重置：可用 ' + count + ' 次' + (dated.length ? '，' + (count > 1 ? '最早一次 ' : '') + ymd(dated[0]) + ' 前有效' : '') + '（在 Codex 官方页面使用）');
  return lines;
}
const PLAN_NAMES = { claude_pro: 'Pro', claude_max: 'Max', claude_team: 'Team', claude_enterprise: 'Enterprise', plus: 'Plus', pro: 'Pro', team: 'Team', free: 'Free' };
const BILLING_NAMES = { apple_subscription: 'Apple 订阅', stripe_subscription: '网页订阅', google_play_subscription: 'Google Play 订阅' };

// 按月订阅的下一个续费日：从订阅起始日每月同一天往后推，取第一个晚于现在的（月底日按当月最后一天）。
function nextMonthlyRenewal(startMs, now) {
  const start = new Date(startMs);
  for (let i = 1; i < 600; i++) {
    const y = start.getFullYear(), m = start.getMonth() + i;
    const last = new Date(y, m + 1, 0).getDate();
    const at = new Date(y, m, Math.min(start.getDate(), last), start.getHours(), start.getMinutes()).getTime();
    if (at > now) return at;
  }
  return 0;
}

//   ① 活跃会话 ≤ 1；② 5h 剩余 > 70%；③ 7d 剩余高于「按节奏该剩的量」；标了风控、读取失败、API Key 的号不参与。
//   例：还有 2 天重置 → 该剩约 29%。7d 满额（100%）直接算满足；最后 RESERVE_7D（10%）是预留，剩 ≤ 10% 不推荐、节奏点直接红。
// 节奏公式与启动中心的推荐排序共用一份（core/claude-launch-recommend.js），两处结果不会不一致。
const { WEEKLY_PLAN, RESERVE_7D, expected7d: paceFor } = require('../core/claude-launch-recommend');
function expected7d(row, now) {
  return paceFor({ resetsAt: Number.isFinite(row.reset7d) ? row.reset7d : 0 }, now);
}
//   实际剩余比该剩的多 ≥ 5% → 绿（用得慢）；少 ≥ 5% → 红（用得快）；±5% 以内 → 黄（刚好），避免在线附近红绿来回跳。
//   7d 剩 > 70% 不看节奏，直接绿。
const PACE_BAND = 5, PLENTY_7D = 70;
function paceOf(row, now) {
  if (row.apiKey || row.remain7d === null || row.remain7d === undefined) return null;
  const expected = Math.round(expected7d(row, now)), margin = row.remain7d - expected;
  const level = row.remain7d <= RESERVE_7D ? 'fast' : row.remain7d > PLENTY_7D || margin >= PACE_BAND ? 'good' : margin <= -PACE_BAND ? 'fast' : 'even';
  return { expected, margin, level };
}
const PACE_WORDS = { good: '用得慢，余量足', even: '和节奏差不多', fast: '用得快，余量偏少', reserve: '只剩预留的 10%' };

// 和启动中心同一条规则（core/claude-launch-recommend.js）；没有才走下面的三条件。
function recommendPreferred(rows) {
  let best = null;
  for (const r of rows) {
    if (r.apiKey || r.error || r.risky || !(r.planMultiplier > 1) || !(r.remain5h > 0) || !(r.remain7d > RESERVE_7D)) continue;
    const score = Math.min(r.remain5h, r.remain7d) - (Number(r.sessions) || 0) * 10;
    if (!best || r.planMultiplier > best.row.planMultiplier || (r.planMultiplier === best.row.planMultiplier && score > best.score)) best = { row: r, score };
  }
  return best ? best.row : null;
}
function recommendClaude(rows, now) {
  for (const r of rows) { r.recommended = false; r.preferred = false; r.expected7d = r.remain7d === null ? null : Math.round(expected7d(r, now)); }
  const preferred = recommendPreferred(rows);
  if (preferred) { preferred.recommended = true; preferred.preferred = true; return preferred; }
  let best = null;
  for (const r of rows) {
    r.recommended = false;
    if (r.apiKey || r.error || r.risky || r.remain5h === null || r.remain7d === null || !Number.isFinite(r.sessions)) continue;
    r.expected7d = Math.round(expected7d(r, now));
    const ok = r.sessions <= 1 && r.remain5h > 70 && r.remain7d > RESERVE_7D && (r.remain7d > r.expected7d || r.remain7d >= 100);
    if (!ok) continue;
    const margin = r.remain7d - r.expected7d;
    if (!best || margin > best.margin || (margin === best.margin && r.remain5h > best.row.remain5h)) best = { row: r, margin };
  }
  if (best) best.row.recommended = true;
  return best ? best.row : null;
}

// 第二行的推测续费日：Claude 从订阅起始日按月推；Codex 已付到期日还没过就用它，过了就从它按月往后推。
function renewalAt(row, now) {
  if (row.provider === 'claude') return row.subscribedAt ? nextMonthlyRenewal(row.subscribedAt, now) : 0;
  if (row.provider === 'codex' && row.subscriptionUntil) return row.subscriptionUntil > now ? row.subscriptionUntil : nextMonthlyRenewal(row.subscriptionUntil, now);
  return 0;
}

// 悬停里的套餐行。Claude 本地只记起始日，续费日按月推算；Codex 凭证里有已付到期日，但只在凭证刷新时更新。
function subscriptionText(row, now) {
  const plan = PLAN_NAMES[row.plan] || row.plan;
  if (row.provider === 'claude') {
    if (!plan && !row.subscribedAt) return '';
    const billing = BILLING_NAMES[row.billing] || '';
    const parts = ['套餐：' + (plan || '未知') + (billing ? '（' + billing + '）' : '')];
    if (row.subscribedAt) {
      const next = nextMonthlyRenewal(row.subscribedAt, now);
      parts.push('订阅始于 ' + ymd(row.subscribedAt) + (next ? '，按月推算下次续费约 ' + ymd(next) : ''));
    }
    return parts.join(' · ');
  }
  if (row.provider === 'codex') {
    const name = row.tierShort || plan;
    if (!name && !row.subscriptionUntil) return '';
    let text = '套餐：' + (name || '未知');
    if (row.subscriptionUntil) {
      text += ' · 已付至 ' + ymd(row.subscriptionUntil) + (row.subscriptionChecked ? '（' + ymd(row.subscriptionChecked) + ' 核对）' : '');
      if (row.subscriptionUntil <= now) text += '，之后登录凭证没再核对，可能已自动续费';
    }
    return text;
  }
  if (row.provider === 'antigravity') return row.tierNote || '';
  return '';
}

function locationText(loc) {
  if (!loc) return '';
  return [loc.countryZh, loc.cityZh].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' ');
}

// 没记账号的会话：Claude 算我的账号，Codex 跟新会话默认的号（与底栏编号同一口径）。
const SESSION_KINDS = { claude: 'claude', codex: 'codex', antigravity: 'gemini' };
function countActiveSessions(provider, profileId, rows, list) {
  const kind = SESSION_KINDS[provider];
  if (!kind) return null;
  const owner = s => provider === 'claude' ? (s.claudeProfile || 'default')
    : provider === 'codex' ? (s.codexProfile || rows.find(r => r.selected || r.current)?.profileId || '') : (s.antigravityProfile || 'default');
  let n = 0;
  for (const s of list) {
    if (String(s?.kind || '').replace(/-resume$/, '') !== kind || s.status === 'dormant') continue;
    if (owner(s) === profileId) n++;
  }
  return n;
}
// 一次看板渲染里每个号都要数会话：先把会话表遍历一遍，按（类型, 账号）记好数，各号直接查表（2026-11-25）。
// 以前每个号都把全部会话（实测 2882 个）数一遍，28 个号一次渲染约 13 ms。口径与 countActiveSessions 相同。
const UNASSIGNED = '\u0000unassigned';
function buildActiveSessionCounts(list) {
  const table = { claude: new Map(), codex: new Map(), gemini: new Map() };
  for (const s of list) {
    if (!s || s.status === 'dormant') continue;
    const kind = String(s.kind || '').replace(/-resume$/, '');
    const counts = table[kind];
    if (!counts) continue;
    // Codex 没记账号的会话算默认号，默认号要看当次的账号行，查表时再归过去。
    const owner = kind === 'claude' ? (s.claudeProfile || 'default') : kind === 'codex' ? (s.codexProfile || UNASSIGNED) : (s.antigravityProfile || 'default');
    counts.set(owner, (counts.get(owner) || 0) + 1);
  }
  return table;
}
function countFromTable(provider, profileId, rows, table) {
  const kind = SESSION_KINDS[provider];
  if (!kind || !table) return null;
  const counts = table[kind];
  let n = counts.get(profileId) || 0;
  if (provider === 'codex' && (rows.find(r => r.selected || r.current)?.profileId || '') === profileId) n += counts.get(UNASSIGNED) || 0;
  return n;
}
// 和进度视图、会议室一样直接读 renderer 的全局会话表；读不到时返回 null，不显示。
// table：同一次渲染建好的计数表（render 传进来）；不传时现建一次。
function activeAccountSessions(provider, profileId, rows = [], table = null) {
  if (!table) {
    if (typeof sessions === 'undefined' || !sessions || typeof sessions.values !== 'function') return null;
    table = buildActiveSessionCounts(sessions.values());
  }
  return countFromTable(provider, profileId, rows, table);
}
function globalSessionCounts() {
  if (typeof sessions === 'undefined' || !sessions || typeof sessions.values !== 'function') return null;
  return buildActiveSessionCounts(sessions.values());
}

// 线路延迟读数（主进程 route-latency:*）。单测里没有 electron，返回 null 即不显示。
function defaultLatencyApi() {
  try {
    const { ipcRenderer } = require('electron');
    const call = async (ch, payload) => { const r = await ipcRenderer.invoke(ch, payload); if (!r?.ok) throw new Error(r?.error || ch); return r.data; };
    return { get: () => call('route-latency:get'), probeClaude: ip => call('route-latency:probe-claude', { ip }) };
  } catch { return null; }
}
// Codex 派活保留线的读写（主进程 codex:get-peer-reserve / codex:set-peer-reserve，只读写 config.json，不联网）。
function defaultReserveApi() {
  try {
    const { ipcRenderer } = require('electron');
    const call = async (ch, payload) => { const r = await ipcRenderer.invoke(ch, payload); if (!r?.ok) throw new Error(r?.error || ch); return r.data; };
    return { get: () => call('codex:get-peer-reserve'), set: (profileId, pct) => call('codex:set-peer-reserve', { profileId, pct }) };
  } catch { return null; }
}
// 账号状态（2026-11-24）：标记 / 恢复正常经主进程写 account-risk-flags.json，支持一次多个号。
function defaultStatusApi() {
  try {
    const { ipcRenderer } = require('electron');
    const call = async (ch, payload) => { const r = await ipcRenderer.invoke(ch, payload); if (!r?.ok) throw new Error(r?.error || ch); return r.data; };
    return { flag: payload => call('account-risk:flag', payload), clear: payload => call('account-risk:clear', payload) };
  } catch { return null; }
}
const STATUS_ITEMS = [
  { id: 'expired', label: '会员到期', hint: '订阅到期或没续费：不推荐、不自动选，手动切换也拦下' },
  { id: 'banned', label: '风控封禁', hint: '被平台封号或限制登录：不推荐、不自动选，手动切换也拦下' },
  { id: 'risk', label: '风控观察', hint: '被提示风控、先观察：不推荐、不自动选，手动仍可用' },
  { id: 'paused', label: '暂停使用', hint: '暂时不想用（如借给别人）：不推荐、不自动选，手动仍可用' },
  { id: 'relogin', label: '登录过期（暂缓）', hint: '登录过期、暂时不想重登：不推荐、不自动选、不后台刷新，也不再提醒授权；要用时到账号页点「授权」' },
];
// 会话启动或运行中报「需要重新授权」（主进程 launch-auth-status）：连接编号 claude / claude-<号> / codex-<号> 换成看板的号。
function loginKeyOf(id) {
  const m = /^(claude|codex)(?:-(.+))?$/.exec(String(id || ''));
  return m ? prefKey(m[1], m[2] || 'default') : '';
}
function defaultLoginEvents() {
  try {
    const { ipcRenderer } = require('electron');
    return listener => ipcRenderer?.on?.('launch-auth-status', (_event, result) => listener(result));
  } catch { return null; }
}
const latColor = ms => (ms === null || ms === undefined ? 'bad' : ms < 250 ? 'good' : ms <= 500 ? 'even' : 'bad');
function readingText(at, now) {
  if (!at) return '上次读数：还没有读到';
  const d = new Date(at), hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return '上次读数：' + agoText(at, now) + '（' + (sameDay ? '' : (d.getMonth() + 1) + '-' + d.getDate() + ' ') + hm + '）';
}
function agoText(at, now) {
  const m = Math.max(0, Math.round((now - at) / 60000));
  return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : m < 48 * 60 ? Math.round(m / 60) + ' 小时前' : Math.round(m / 1440) + ' 天前';
}

//   + 数字下面一根 2px 细线表示剩余量；剩余 < 25% 的数字和细线变红，快刷新的倒计时绿色加粗（11-03）。邮箱、IP、续费都进悬停。
// reserve：Codex 派活保留线（%）。给了就在细线上画一条刻度，位置 = 剩余 reserve%。
function quotaCell(row, name, now, { wide = false, reset = true, reserve = null } = {}) {
  const pct = name === '5h' ? row.remain5h : row.remain7d, at = name === '5h' ? row.reset5h : row.reset7d;
  const assumed = name === '5h' ? row.assumed5h : row.assumed7d;
  const wait = !reset || pct === null || pct === undefined ? '' : pct >= 100 || assumed ? '已满' : !Number.isFinite(at) ? '' : at <= now ? '待刷新' : formatResetCountdown(at, now);
  const known = pct !== null && pct !== undefined, low = known && pct < LOW_MARK;
  const soon = !!wait && wait !== '已满' && wait !== '待刷新' && at - now <= SOON_MS[name];
  const tier = !known ? 'none' : pct >= 70 ? 'high' : pct >= 40 ? 'mid' : pct >= LOW_MARK ? 'warn' : 'low';
  const waitKind = !wait ? 'none' : wait === '已满' ? 'full' : wait === '待刷新' ? 'stale' : soon ? 'soon' : 'count';
  return `<span data-cq-tier="${tier}" data-cq-wait="${waitKind}" class="cq-cell${wide ? ' cq-wide' : ''}${low ? ' is-low' : ''}${soon ? ' is-soon' : ''}" data-cq-window="${name}"><b class="cq-value">${known ? pct + '%' : '—'}</b>`
    + `<span class="cq-reset">${wait}</span><span class="cq-meter"><i style="width:${known ? Math.max(pct, 2) : 0}%"></i></span>`
    + (reserve === null ? '' : `<i class="cq-reserve-tick" style="left:calc((100% - 4px) * ${reserve / 100})" aria-hidden="true"></i>`) + '</span>';
}

// 看板最近一次算出的各号读数（编号、剩余、节奏），给会话账号按钮、账号下拉、启动中心共用，
// 三处的「账号 N」与右侧栏编号一致。看板每次渲染后通知订阅者。
const shared = { rows: {}, key: '' };
const sharedListeners = new Set();
function publishRows(rowsByProvider) {
  const key = JSON.stringify(rowsByProvider);
  if (key === shared.key) return;
  shared.rows = rowsByProvider; shared.key = key;
  // 手机等「前台客户端」的状态行用同一份读数（主进程 core/hub-assistant/front-client.js）；单测里没有 electron 就跳过。
  try {
    const compact = Object.entries(rowsByProvider || {}).flatMap(([provider, rows]) => (rows || []).map(r => ({ provider: r.provider || provider, no: r.no, profileId: r.profileId || '',
      remain5h: r.remain5h ?? null, remain7d: r.remain7d ?? null, reset5h: r.reset5h || null, reset7d: r.reset7d || null })));
    require('electron').ipcRenderer.send('assistant:quota-view', compact);
  } catch {}
  for (const fn of sharedListeners) { try { fn(); } catch {} }
}
function accountQuota(provider, profileId) {
  return (shared.rows[provider] || []).find(r => r.profileId === (profileId || '')) || null;
}
// 全部号的读数（助理页右栏「额度」用），按 Claude → Codex → Gemini。
function accountQuotaRows() {
  return PROVIDERS.flatMap(p => (shared.rows[p.id] || []).map(r => ({ ...r, provider: r.provider || p.id })));
}
function subscribeAccountQuota(fn) { sharedListeners.add(fn); return () => sharedListeners.delete(fn); }
// 「账号 N」：N 取右侧栏编号；看板还没数据时，从原名里取「账号4 · 专用IP」开头的「账号4」。
function accountShortName(provider, profileId, fallbackLabel = '') {
  const row = accountQuota(provider, profileId);
  if (row) return '账号 ' + row.no;
  const m = String(fallbackLabel || '').match(/^账号\s*(\d+)/);
  return m ? '账号 ' + m[1] : (String(fallbackLabel || profileId || '').split(' · ')[0] || '账号');
}

function createAccountQuotaPanel({
  document, root, footerRoot = null, getSnapshot, getCurrentProfileId = () => '', refresh = async () => {},
  lookupLocations = async () => ({}), getActiveSessionCount = activeAccountSessions, latencyApi = defaultLatencyApi(), reserveApi = defaultReserveApi(), statusApi = defaultStatusApi(), loginEvents = defaultLoginEvents(), escapeHtml, storage = null, nowFn = Date.now, setIntervalFn = setInterval, setTimeoutFn = setTimeout,
}) {
  if (!document || !root) throw new Error('account quota panel needs document and root');
  const esc = typeof escapeHtml === 'function' ? escapeHtml : s => String(s);
  let state = { collapsed: false };
  try { state = { ...state, ...JSON.parse(storage?.getItem(STORAGE_KEY) || '{}') }; } catch {}
  const save = () => { try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {} };
  if (!Array.isArray(state.hidden)) state.hidden = [];
  if (!state.tiers || typeof state.tiers !== 'object') state.tiers = {};
  if (state.prefsSeed !== PREFS_SEED.id) {
    state.hidden = [...new Set([...state.hidden, ...PREFS_SEED.hidden])];
    state.tiers = { ...PREFS_SEED.tiers, ...state.tiers };
    state.prefsSeed = PREFS_SEED.id;
    save();
  }
  const isHidden = r => state.hidden.includes(prefKey(r.provider, r.profileId));
  const selected = new Set();
  const needLogin = new Map();
  let notice = null, menuEl = null, menuCleanup = null;
  let lastHtml = '', lastOuter = '';
  const summaries = {};
  const lastSummary = {};
  const locations = {};
  const asked = new Set();
  let latency = {}, latencyAt = 0, currentRows = {};
  // 看板在显示时每 30 秒读一次延迟快照；主进程自己控制 5 分钟测一次，这里只取缓存。
  function pullLatency(now) {
    if (!latencyApi || now - latencyAt < 30_000) return;
    latencyAt = now;
    Promise.resolve(latencyApi.get()).then(next => {
      if (next && JSON.stringify(next) !== JSON.stringify(latency)) { latency = next; render(); }
    }).catch(() => {});
  }
  function latencyLine(ip, now) {
    const l = latency[ip];
    if (!l) return '';
    const g = l.google, c = l.claude;
    const parts = [];
    if (g) parts.push(g.ms !== null ? g.ms + 'ms（Google · ' + agoText(g.at, now) + '）' : '超时（Google · ' + agoText(g.at, now) + '）');
    if (c) parts.push(c.ms !== null ? 'Claude ' + c.ms + 'ms（' + agoText(c.at, now) + '）' : 'Claude 测不通（' + agoText(c.at, now) + '）');
    return parts.join(' · ');
  }

  // Codex 派活保留线：启动时从 config.json 读一次，改了就写回；没写过的号按缺省值显示（default 5%，其余 10%）。
  let reserveMap = {}, reserveEditing = null, reserveFailed = null;
  const reserveOf = profileId => peerReserve.reserveFor(reserveMap, profileId);
  const reserveHit = r => r.provider === 'codex' && !r.apiKey && r.eff !== null && r.eff <= reserveOf(r.profileId);
  if (reserveApi) Promise.resolve().then(() => reserveApi.get()).then(map => { reserveMap = map || {}; render(); }).catch(() => {});
  function reserveLine(r) {
    const id = esc(r.profileId), pct = reserveOf(r.profileId);
    if (reserveEditing === r.profileId) {
      return `<div class="cq-reserve is-editing" data-cq-reserve="${id}"><label>派活保留 <input class="cq-reserve-input" type="number" min="0" max="${peerReserve.MAX_RESERVE}" step="1" value="${pct}" data-cq-reserve-input="${id}" aria-label="派活保留线（0–${peerReserve.MAX_RESERVE}%）"> %</label><span class="cq-reserve-note">回车保存 · Esc 取消</span></div>`;
    }
    const tip = `Claude 派 Codex 活时，这个号剩余不高于 ${pct}% 就不选它，留给你自己用。点击修改（0–${peerReserve.MAX_RESERVE}）`;
    return `<div class="cq-reserve${reserveHit(r) ? ' is-hit' : ''}" data-cq-reserve="${id}"><button type="button" class="cq-reserve-edit" data-cq-reserve-edit="${id}" title="${tip}" aria-label="${tip}">派活保留 ${pct}%</button>`
      + (reserveFailed === r.profileId ? '<span class="cq-reserve-note is-error">没保存上，点左侧重试</span>'
        : reserveHit(r) ? '<span class="cq-reserve-note">Claude 派活已避开此号</span>' : '') + '</div>';
  }
  function commitReserve(profileId, text) {
    if (reserveEditing !== profileId) return;
    reserveEditing = null;
    const pct = peerReserve.normalizeReserve(String(text ?? '').trim()), before = reserveMap;
    if (pct === null || pct === reserveOf(profileId) || !reserveApi) { render(); return; }
    reserveMap = { ...reserveMap, [profileId]: pct }; reserveFailed = null;
    render();
    Promise.resolve().then(() => reserveApi.set(profileId, pct)).then(map => { if (map) reserveMap = map; })
      .catch(() => { reserveMap = before; reserveFailed = profileId; }).finally(render);
  }

  function askLocations(ips) {
    const missing = [...new Set(ips)].filter(ip => ip && !asked.has(ip));
    if (!missing.length) return;
    missing.forEach(ip => asked.add(ip));
    Promise.resolve(lookupLocations(missing)).then(found => {
      let changed = false;
      for (const [ip, loc] of Object.entries(found || {})) if (loc) { locations[ip] = loc; changed = true; }
      if (changed) render();
    }).catch(() => {}).finally(() => {
      // 查不到的 IP（网络暂时不通）10 分钟后允许再问一次，不必等重启。
      const retry = missing.filter(ip => !locations[ip]);
      if (retry.length) { const t = setTimeoutFn(() => retry.forEach(ip => asked.delete(ip)), 10 * 60_000); t?.unref?.(); }
    });
  }

  function tooltip(row, now) {
    const p = PROVIDERS.find(x => x.id === row.provider);
    const lines = [p.name + ' ' + row.no + ' · ' + row.label + (row.tierShort ? ' · ' + row.tierShort : '') + (row.current ? '（当前）' : '')];
    if (row.recommended && row.preferred) lines.push('★ 推荐使用（' + row.planMultiplier + 'X 号优先）：会话 ' + row.sessions + ' 个 · 5h 剩 ' + row.remain5h + '% · 7d 剩 ' + row.remain7d + '%');
    else if (row.recommended) lines.push('★ 推荐使用：会话 ' + row.sessions + ' 个 · 5h 剩 ' + row.remain5h + '% · 7d 剩 ' + row.remain7d
      + '%，按每周用满、每天约 ' + Math.round(WEEKLY_PLAN / 7) + '% 的节奏此时该剩 ' + row.expected7d + '%，余量 ' + (row.remain7d - row.expected7d >= 0 ? '+' : '') + (row.remain7d - row.expected7d) + '%');
    if (row.email) lines.push('邮箱：' + row.email);
    const sub = subscriptionText(row, now);
    if (sub) lines.push(sub);
    if (row.provider === 'codex') lines.push(...codexFactLines(row, now));
    if (row.renewAt) lines.push('推测续费：' + mmdd(row.renewAt) + (row.renewAt - now <= 3 * 86400_000 ? '（3 天内）' : ''));
    if (row.provider === 'claude' || (row.provider === 'antigravity' && row.egress)) lines.push('出口：' + (row.egress ? row.egress + (locationText(locations[row.egress]) ? ' · ' + locationText(locations[row.egress]) : '') : '未知'));
    const lat = row.provider === 'claude' && row.egress ? latencyLine(row.egress, now) : '';
    if (lat) lines.push('延迟：' + lat);
    if (Number.isFinite(row.sessions)) lines.push('活跃会话：' + row.sessions + ' 个');
    if (row.apiKey) lines.push('API Key 登录，没有订阅额度');
    const win = (name, pct, at, assumed) => name + (name === '5h' ? ' 已用 ' : ' 待恢复 ')
      + (pct === null ? '未知' : (100 - pct) + '%') + ' · 剩余 ' + (pct === null ? '未知' : pct + '%')
      + (assumed ? '（已过重置时间，重置后没在 Hub 用过，按满额算）'
        : Number.isFinite(at) ? (at > now ? ' · ' + formatResetCountdown(at, now) + ' 后重置' : ' · 待刷新') : '');
    if (row.has5h) lines.push(win('5h', row.remain5h, row.reset5h, row.assumed5h));
    lines.push(win('7d', row.remain7d, row.reset7d, row.assumed7d));
    if (row.provider === 'antigravity') {
      const third = (row.groups || []).find(g => g.id === 'thirdParty');
      if (third) {
        const parts = ['usage5h', 'usage7d'].filter(k => third[k]).map(k => {
          const pct = remainingPercent(third[k]);
          return `${k === 'usage5h' ? '5h' : '7d'} 剩余 ${pct === null ? '未知' : Math.round(pct) + '%'}`;
        });
        if (parts.length) lines.push((third.label || 'Claude/GPT') + '：' + parts.join(' · '));
      }
      if (row.credits !== null || row.creditsError) {
        lines.push('credits 余额：' + (row.credits ?? '未知') + (row.creditsError ? ' · ' + row.creditsError : ''));
      }
    }
    const pace = paceOf(row, now);
    if (pace) lines.push('7d 节奏：每天约 ' + Math.round(WEEKLY_PLAN / 7) + '%，此时该剩 ' + pace.expected + '%，实际剩 ' + row.remain7d + '%，'
      + (pace.margin >= 0 ? '余量 +' + pace.margin : '超前 ' + (-pace.margin)) + '% → '
      + PACE_WORDS[row.remain7d <= RESERVE_7D ? 'reserve' : pace.level]);
    if (row.provider === 'codex' && !row.apiKey) lines.push('派活保留线：' + reserveOf(row.profileId) + '%' + (reserveHit(row) ? '，已到线，Claude 派活避开此号' : ''));
    if (row.blockedBy) lines.push('现在被 ' + row.blockedBy + ' 卡住' + (row.backIn ? '，' + row.backIn + ' 后回血' : ''));
    if (!row.apiKey) lines.push(readingText(row.lastSeen, now));
    if (row.error) lines.push('刷新失败：' + row.error);
    lines.push(row.inFlight ? '刷新中…' : '点击刷新这个账号的额度 · 右键标记状态（会员到期、风控封禁…）或在额度栏隐藏 · Ctrl+点击多选');
    return lines.join('\n');
  }

  function card(r, now) {
    const empty = r.remain5h === null && r.remain7d === null;
    const tick = r.provider === 'codex' ? reserveOf(r.profileId) : null;
    const flagLabel = r.riskShown ? accountRisk.statusText(riskKind(r.provider), r.profileId) : '';
    const relogin = !flagLabel && needLogin.has(prefKey(r.provider, r.profileId));
    const quota = flagLabel ? `<span class="cq-cell cq-wide cq-flagged">${esc(flagLabel)}</span>`
      : relogin ? '<span class="cq-cell cq-wide cq-relogin">需重新登录</span>'
      : r.apiKey ? '<span class="cq-cell cq-wide cq-nodata">API Key 登录</span>'
      : empty ? `<span class="cq-cell cq-wide cq-nodata">${r.error ? '刷新失败，点击重试' : r.provider === 'claude' ? '未知（发一条消息后更新）' : '暂无数据，点击刷新'}</span>`
        : r.has5h ? quotaCell(r, '5h', now, { reserve: tick }) + quotaCell(r, '7d', now, { reserve: tick })
          : NO_5H_CELL + quotaCell(r, '7d', now, { reserve: tick });
    const sessions = Number.isFinite(r.sessions)
      ? `<span class="cq-sessions${r.sessions ? '' : ' is-zero'}" data-cq-many="${r.sessions >= 2 ? 1 : 0}" aria-hidden="true">${r.sessions}</span>` : '<span></span>';
    const risk = accountRisk.describe(riskKind(r.provider), r.profileId);
    const share = accountRisk.shareNote(riskKind(r.provider), r.profileId);
    const detail = esc((relogin ? '需重新登录：到账号页点「授权」；暂时不用可右键标「登录过期（暂缓）」\n' : '') + (risk ? '⚠ ' + risk + '\n' : '') + (share ? share + '\n' : '') + tooltip(r, now));
    return `<button type="button" class="cq-card${risk ? ' has-account-risk' : ''}${r.riskShown ? ' is-flagged' : ''}${selected.has(prefKey(r.provider, r.profileId)) ? ' is-selected' : ''}${share ? ' is-shared' : ''}${r.current ? ' is-current' : ''}${r.recommended ? ' is-recommended' : ''}${r.inFlight ? ' is-loading' : ''}${r.error ? ' is-error' : ''}${relogin ? ' needs-login' : ''}" data-cq-provider="${r.provider}" data-cq-profile="${esc(r.profileId)}" title="${detail}" aria-label="${detail}"${r.inFlight ? ' aria-busy="true"' : ''}>`
      + `<span class="cq-no">${r.no}${r.error ? '<span class="cq-error-mark" aria-hidden="true">!</span>' : share ? SHARE_MARK : ''}</span>${quota}${sessions}</button>`
      + (r.provider === 'codex' && !r.apiKey ? reserveLine(r) : '');
  }

  const usableOf = rows => rows.filter(r => r.eff !== null && r.eff >= USABLE_MIN).length;
  //   显示出来时只是灰着列在原位，计数和底栏汇总照旧不算它们。
  const countRows = rows => rows.filter(r => !r.riskShown && !r.panelHidden);
  const shownRows = rows => rows.filter(r => !r.panelHidden && (!r.riskShown || state.showFlagged));
  const hiddenNote = g => {
    const risk = g.rows.filter(r => r.riskShown).length, own = g.rows.filter(r => !r.riskShown && r.panelHidden).length;
    return (risk ? `，另有 ${risk} 个已标记状态的号${state.showFlagged ? '（灰色显示，不计数）' : '已隐藏'}` : '') + (own ? `，另有 ${own} 个号已在额度栏隐藏（右键标题恢复）` : '');
  };

  // 档位高的在最前（Claude 2026-11-06；Codex、Gemini 2026-11-22）：同组里有两种以上档位时，各加一行小标题分开。
  function rowsHtml(rows, now) {
    return tierRowsHtml(rows, r => card(r, now));
  }
  const headTipText = () => '右键这里：显示已标记状态的账号、恢复在额度栏隐藏的号' + (state.hidden.length ? `（已隐藏 ${state.hidden.length} 个）` : '');
  function html(allGroups, now) {
    // 一组的号全被手动隐藏时仍留标题（细栏留图标），好右键恢复（2026-11-22）。
    const groups = allGroups.map(g => ({ ...g, shown: shownRows(g.rows), counted: countRows(g.rows) })).filter(g => g.shown.length || g.rows.some(r => r.panelHidden && !r.riskShown));
    // 外壳（滚动的那一层）和里面的内容分开给：内容变了只换里面，滚动位置和正在拖的滚动条都不丢（2026-11-22）。
    if (state.collapsed) {
      const inner = `<button type="button" class="cq-expand" data-cq-action="expand" title="展开账号看板" aria-label="展开账号看板">«</button>`
        + groups.map(g => `<div class="cq-rail-group" data-cq-group="${g.id}"><span class="ai-logo logo-${g.logo} cq-logo" title="${g.name} ${usableOf(g.counted)}/${g.counted.length} 可用${hiddenNote(g)}" aria-hidden="true"></span>`
          + g.shown.map(r => `<button type="button" class="cq-rail-item cq-${level(r.apiKey ? null : r.eff)}${r.current ? ' is-current' : ''}${r.recommended ? ' is-recommended' : ''}" data-cq-provider="${r.provider}" data-cq-profile="${esc(r.profileId)}" title="${esc(tooltip(r, now))}">${r.no}</button>`).join('')
          + '</div>').join('');
      return { box: '.cq-rail', outer: '<div class="cq-rail"></div>', full: '<div class="cq-rail">' + inner + '</div>', inner };
    }
    const head = tip => `<header class="cq-head"${tip ? ` title="${tip}"` : ''}><strong>账号额度</strong>${state.showFlagged ? '<span class="cq-flag-mode">含已标记</span>' : ''}`
      + `<button type="button" class="cq-collapse" data-cq-action="collapse" title="收起成细栏" aria-label="收起账号看板">»</button></header>`;
    const headTip = headTipText();
    const inner = groups.map((g, i) => `<section class="cq-group" data-cq-group="${g.id}">`
        + `<h3 title="${g.name} ${g.counted.length} 个账号，${usableOf(g.counted)} 个可用${hiddenNote(g)} · 数字为剩余额度，时间为距重置的倒计时 · 右键：显示已标记账号"><span class="cq-provider">${g.name}</span><span class="cq-count"><b>${usableOf(g.counted)}</b> / ${g.counted.length} 可用</span></h3>`
        + (i === 0 ? COLUMNS_HTML : '')
        + '<div class="cq-rows">' + rowsHtml(g.shown, now) + '</div></section>').join('');
    // 外壳比较不含顶部提示：右键隐藏 / 恢复只改提示文字，不该重建滚动层。
    const note = notice ? `<div class="cq-notice" data-tone="${notice.tone}" role="status">${esc(notice.text)}</div>` : '';
    return { box: '.cq-list', outer: head('') + note + '<div class="cq-list"></div>', full: head(headTip) + note + '<div class="cq-list">' + inner + '</div>', inner, headTip };
  }

  function ensureSummary(provider) {
    if (summaries[provider] || !footerRoot) return summaries[provider] || null;
    const quota = footerRoot.querySelector('.sidebar-quota');
    if (!quota) return null;
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'sidebar-quota-provider cq-footer-summary';
    s.dataset.provider = provider + '-summary';
    s.style.order = String(-3 + PROVIDERS.findIndex(p => p.id === provider));
    s.addEventListener('click', () => { state.collapsed = !state.collapsed; save(); render(); });
    quota.prepend(s);
    summaries[provider] = s;
    return s;
  }

  function render() {
    const now = nowFn();
    let snapshot = null;
    try { snapshot = getSnapshot(); } catch {}
    let sessionCounts;
    const countsOnce = () => { if (sessionCounts === undefined) { try { sessionCounts = globalSessionCounts(); } catch { sessionCounts = null; } } return sessionCounts; };
    const groups = PROVIDERS.map(p => {
      let rows = [];
      try { rows = viewRows(p.id, snapshot, getCurrentProfileId(p.id), now); } catch {}
      for (const r of rows) {
        r.renewAt = renewalAt(r, now);
        try { r.sessions = getActiveSessionCount === activeAccountSessions
          ? (countsOnce() ? countFromTable(p.id, r.profileId, rows, countsOnce()) : null)
          : getActiveSessionCount(p.id, r.profileId, rows); } catch { r.sessions = null; }
      }
      // 标了风控的号不推荐（2026-11-01），看板里隐藏（2026-11-03）。
      // risky 管推荐（共享占位号照旧不推荐），riskShown 管看板隐藏与 ⚠。
      for (const r of rows) {
        try { r.risky = !!accountRisk.active(riskKind(p.id), r.profileId); } catch { r.risky = false; }
        try { r.riskShown = !!accountRisk.riskShown(riskKind(p.id), r.profileId); } catch { r.riskShown = r.risky; }
      }
      for (const r of rows) {
        r.panelHidden = isHidden(r);
        const tier = state.tiers[prefKey(r.provider, r.profileId)];
        if (tier?.label && (!tier.scope || String(r.scope || '').startsWith(tier.scope))) Object.assign(r, { tierRank: Number(tier.rank) || 0, tierLabel: tier.label, tierShort: tier.short || shortTier(tier.label), tierNote: tier.note || '档位：' + tier.label + '（人工指定）' });
      }
      if (p.id === 'claude') recommendClaude(rows, now);
      rows.sort((a, b) => (b.tierRank || 0) - (a.tierRank || 0) || a.no - b.no);
      // 分享版：还没用过的 AI 不占位，有读数后才出现在看板里。
      if (require('../core/distribution').sharedBuild && !rows.some(r => r.apiKey || r.remain5h != null || r.remain7d != null)) rows = [];
      return { ...p, rows };
    }).filter(g => g.rows.length);
    publishRows(Object.fromEntries(groups.map(g => [g.id, g.rows.map(r => ({
      provider: r.provider, no: r.no, profileId: r.profileId, label: r.label, remain5h: r.remain5h, remain7d: r.remain7d,
      reset5h: r.reset5h, reset7d: r.reset7d, assumed5h: r.assumed5h, assumed7d: r.assumed7d, has5h: r.has5h,
      apiKey: r.apiKey, error: r.error, sessions: r.sessions ?? null, recommended: !!r.recommended, planMultiplier: r.planMultiplier || 1, lastSeen: r.lastSeen || 0,
      tierRank: r.tierRank || 0, tierLabel: r.tierLabel || '', tierShort: r.tierShort || '',
      // 助理页「额度」Tab 照看板一样隐藏风控号、悬停显示邮箱（2026-11-14）。
      risky: !!r.risky, riskShown: !!r.riskShown, panelHidden: !!r.panelHidden, email: r.email || '', current: !!r.current,
    }))])));
    const total = groups.reduce((n, g) => n + g.rows.length, 0);
    const on = total >= 2;
    root.hidden = !on;
    root.classList.toggle('is-collapsed', !!state.collapsed);
    if (footerRoot) {
      footerRoot.dataset.accountPanel = on ? 'on' : 'off';
      // 只收看板里有的那几家；单号的 AI 在看板里也有卡片，底栏同样只留汇总。
      footerRoot.dataset.panelProviders = on ? groups.map(g => g.id).join(' ') : '';
    }
    for (const p of PROVIDERS) {
      const s = ensureSummary(p.id);
      if (!s) continue;
      const g = groups.find(x => x.id === p.id);
      s.hidden = !on || !g;
      if (!g) continue;
      const shown = countRows(g.rows), usable = usableOf(shown);
      const text = `<span class="sidebar-quota-icon ai-logo logo-${p.logo}" aria-hidden="true"></span><span class="sidebar-quota-name">${p.name}</span><span class="cq-summary-text"><b>${usable}</b>/${shown.length}</span>`;
      if (text !== lastSummary[p.id]) { s.innerHTML = text; lastSummary[p.id] = text; }
      const note = hiddenNote(g);
      s.title = `${p.name} ${shown.length} 个账号，${usable} 个可用${note ? '（' + note.slice(1) + '）' : ''} · 点击${state.collapsed ? '展开' : '收起'}右侧账号看板`;
      s.setAttribute('aria-label', s.title);
    }
    if (!on) return;
    currentRows = Object.fromEntries(groups.map(g => [g.id, g.rows]));
    ensureTipButton();
    askLocations(groups.flatMap(g => g.rows.map(r => r.egress)));
    if (!state.collapsed && !document.hidden) pullLatency(now);
    // 正在改保留线的号这次不在看板里了（被移除、换成 API Key、被隐藏）：结束编辑，免得旧输入框留在页面上。
    if (reserveEditing !== null && !groups.some(g => g.id === 'codex' && countRows(g.rows).some(r => r.profileId === reserveEditing && !r.apiKey))) reserveEditing = null;
    const view = html(groups, now), next = view.full;
    // 正在改保留线时不重建 DOM，免得输入框和已输入的数字被冲掉。
    if (reserveEditing !== null && lastHtml.includes('cq-reserve-input')) return;
    if (next !== lastHtml) {
      // 滚动的那层被换成新元素，位置归零、正在拖的滚动条也被打断。现在外壳不变时只换里面的内容。
      const box = view.outer === lastOuter ? root.querySelector?.(view.box) : null;
      if (box) {
        box.innerHTML = view.inner;
        const headEl = root.querySelector?.('.cq-head');
        if (headEl) { if (view.headTip) headEl.setAttribute('title', view.headTip); else headEl.removeAttribute?.('title'); }
      } else root.innerHTML = next;
      lastHtml = next; lastOuter = view.outer;
      if (reserveEditing !== null) { const input = root.querySelector?.('.cq-reserve-input'); input?.focus?.(); input?.select?.(); }
    }
  }

  // 悬停卡（全局 C 样式）里给 Claude 号加「测到 Claude」按钮：只在你点时经这条线路测 3 次，不带账号信息。
  // 悬停组件在页面加载完才装好，看板可能更早创建，所以在渲染时补登记一次。
  let tipRegistered = false;
  function ensureTipButton() {
    const tipApi = document.__hubTooltip;
    if (tipRegistered || !tipApi?.registerRich || !latencyApi) return;
    tipRegistered = true;
    tipApi.registerRich('#account-quota-panel .cq-card[data-cq-provider="claude"]', el => {
      const rows = currentRows.claude || [];
      const row = rows.find(r => r.profileId === el.dataset.cqProfile);
      if (!row?.egress) return null;
      const frag = tipApi.renderText(el.getAttribute('data-hub-tip'));
      const bar = document.createElement('div');
      bar.className = 'hub-tip-actions';
      const note = document.createElement('span');
      note.textContent = '不带账号信息，只在你点时发 3 个请求';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hub-tip-button';
      button.textContent = '测到 Claude';
      button.addEventListener('click', event => {
        event.stopPropagation();
        button.disabled = true; button.textContent = '测试中…';
        Promise.resolve(latencyApi.probeClaude(row.egress)).then(result => {
          latency[row.egress] = { ...(latency[row.egress] || {}), claude: result };
          const color = latColor(result?.ms);
          button.textContent = result?.ms !== null && result?.ms !== undefined ? 'Claude ' + result.ms + 'ms' : 'Claude 测不通';
          button.dataset.level = color;
          note.textContent = result?.cooldown ? '1 分钟内测过，显示的是上次结果' : '3 次取中位数 · ' + (result?.samples || []).join(' / ') + 'ms';
        }).catch(error => { button.textContent = '测试失败'; note.textContent = String(error?.message || error); })
          .finally(() => { button.disabled = false; });
      });
      bar.append(note, button);
      frag.appendChild(bar);
      return frag;
    });
  }

  root.addEventListener('click', event => {
    const action = event.target.closest('[data-cq-action]');
    if (action) { state.collapsed = action.dataset.cqAction === 'collapse'; save(); render(); return; }
    const edit = event.target.closest('[data-cq-reserve-edit]');
    if (edit) { reserveEditing = edit.dataset.cqReserveEdit; reserveFailed = null; render(); return; }
    if (event.target.closest('[data-cq-reserve]')) return;
    const card = event.target.closest('[data-cq-profile]');
    if (card && (event.ctrlKey || event.metaKey)) {
      const key = prefKey(card.dataset.cqProvider || 'claude', card.dataset.cqProfile);
      if (selected.has(key)) selected.delete(key); else selected.add(key);
      render(); return;
    }
    if (card) Promise.resolve(refresh(card.dataset.cqProvider || 'claude', card.dataset.cqProfile)).catch(() => {}).finally(render);
  });
  //   分组标题、看板顶部（细栏是 « 按钮）= 显示已标记账号、恢复在额度栏隐藏的号。
  const rowOf = key => {
    const at = key.indexOf(':'), provider = key.slice(0, at), id = key.slice(at + 1);
    return (currentRows[provider] || []).find(r => r.profileId === id) || null;
  };
  const groupName = provider => PROVIDERS.find(p => p.id === provider)?.name || provider;
  function closeMenu() {
    menuCleanup?.(); menuCleanup = null;
    menuEl?.remove?.(); menuEl = null;
  }
  function showNotice(text, tone = 'ok') {
    const mine = notice = { text, tone };
    render();
    setTimeoutFn(() => { if (notice === mine) { notice = null; render(); } }, tone === 'error' ? 12000 : 6000);
  }
  function openMenu(event, build) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'cq-menu';
    menu.setAttribute('role', 'menu');
    const add = (text, onClick, { title = '', checked = null, disabled = false, tone = '' } = {}) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cq-menu-item' + (tone ? ' is-' + tone : '');
      b.setAttribute('role', checked === null ? 'menuitem' : 'menuitemcheckbox');
      if (checked !== null) b.setAttribute('aria-checked', String(checked));
      b.textContent = (checked === null ? '' : checked ? '✓ ' : '　') + text;
      if (title) b.title = title;
      b.disabled = disabled;
      b.addEventListener('click', e => { e.stopPropagation?.(); onClick(); });
      menu.appendChild(b);
      return b;
    };
    const label = (text, cls = 'cq-menu-label') => { const d = document.createElement('div'); d.className = cls; d.textContent = text; menu.appendChild(d); return d; };
    const sep = () => { const d = document.createElement('div'); d.className = 'cq-menu-sep'; menu.appendChild(d); };
    build({ add, label, sep, menu });
    (document.body || root).appendChild(menu);
    const view = document.defaultView || {};
    const width = menu.offsetWidth || 220, height = menu.offsetHeight || 260;
    menu.style.left = Math.max(4, Math.min(event.clientX || 0, (view.innerWidth || 1440) - width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(event.clientY || 0, (view.innerHeight || 900) - height - 4)) + 'px';
    menuEl = menu;
    const outside = e => { if (!menu.contains(e.target)) closeMenu(); };
    const keys = e => { if (e.key === 'Escape') { e.preventDefault?.(); closeMenu(); } };
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', keys, true);
    menuCleanup = () => { document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', keys, true); };
  }
  async function applyStatus(rows, action, status, note) {
    closeMenu();
    if (!statusApi) { showNotice('这个窗口不能修改账号状态', 'error'); return; }
    const items = rows.map(r => ({ kind: riskKind(r.provider), profileId: r.profileId }));
    const names = rows.map(r => groupName(r.provider) + ' ' + r.no).join('、');
    try {
      const data = action === 'clear' ? await statusApi.clear({ items }) : await statusApi.flag({ items, status, note, days: null });
      accountRisk.publish(data);
      selected.clear();
      const label = STATUS_ITEMS.find(x => x.id === status)?.label;
      showNotice(action === 'clear' ? `已恢复正常：${names}` : `已标记「${label}」：${names}` + (state.showFlagged ? '' : '（已从额度栏隐藏，右键标题可显示）'));
    } catch (error) { showNotice(`没改成：${error.message || error}`, 'error'); }
  }
  function cardMenu(event, card) {
    const key = prefKey(card.dataset.cqProvider || 'claude', card.dataset.cqProfile);
    const keys = selected.has(key) && selected.size > 1 ? [...selected] : [key];
    const rows = keys.map(rowOf).filter(Boolean);
    if (!rows.length) return;
    openMenu(event, ({ add, label, sep, menu }) => {
      label(rows.length > 1 ? `已选 ${rows.length} 个号：${rows.map(r => groupName(r.provider) + ' ' + r.no).join('、')}` : `${groupName(rows[0].provider)} ${rows[0].no} · ${rows[0].email || rows[0].label}`, 'cq-menu-title');
      const input = document.createElement('input');
      input.className = 'cq-menu-note'; input.type = 'text'; input.maxLength = 200;
      input.placeholder = '备注（可选），如：Apple 订阅没续费';
      input.addEventListener('keydown', e => e.stopPropagation?.());
      menu.appendChild(input);
      label('标记状态：不推荐、不进切换序列、不自动派工、不计入额度');
      for (const item of STATUS_ITEMS) add(item.label, () => applyStatus(rows, 'flag', item.id, input.value), { title: item.hint });
      if (rows.some(r => r.risky)) { sep(); add(rows.length > 1 ? '恢复正常（选中的号）' : '恢复正常', () => applyStatus(rows, 'clear'), { tone: 'primary', title: '解除标记，记录留作历史' }); }
      sep();
      if (rows.length === 1 && !rows[0].panelHidden) add('只在额度栏隐藏（不改状态）', () => { closeMenu(); state.hidden = [...state.hidden, key]; save(); render(); }, { title: '只是这台电脑的额度栏不显示，推荐和换号照旧' });
      if (selected.size) add(`取消多选（${selected.size}）`, () => { closeMenu(); selected.clear(); render(); });
      label('Ctrl + 点击号卡可多选，再右键批量标记', 'cq-menu-hint');
    });
  }
  function headMenu(event, group) {
    const all = Object.values(currentRows).flat();
    const flagged = all.filter(r => r.riskShown).length;
    const groupHidden = group ? state.hidden.filter(k => k.startsWith(group + ':')) : [];
    openMenu(event, ({ add, sep, label }) => {
      add(`显示已标记账号（${flagged} 个）`, () => { closeMenu(); state.showFlagged = !state.showFlagged; save(); render(); },
        { checked: !!state.showFlagged, title: '会员到期、风控封禁等标了状态的号灰色列出，右键可恢复正常；计数照旧不算它们' });
      if (groupHidden.length || state.hidden.length) sep();
      if (groupHidden.length) add(`恢复这一组在额度栏隐藏的 ${groupHidden.length} 个号`, () => { closeMenu(); state.hidden = state.hidden.filter(k => !k.startsWith(group + ':')); save(); render(); });
      if (state.hidden.length && state.hidden.length !== groupHidden.length) add(`恢复全部在额度栏隐藏的 ${state.hidden.length} 个号`, () => { closeMenu(); state.hidden = []; save(); render(); });
      if (selected.size) { sep(); add(`取消多选（${selected.size}）`, () => { closeMenu(); selected.clear(); render(); }); }
      if (!flagged && !state.hidden.length) label('没有标记状态或隐藏的号', 'cq-menu-hint');
    });
  }
  root.addEventListener('contextmenu', event => {
    const at = sel => event.target.closest?.(sel);
    const card = at('[data-cq-profile]');
    if (card) { event.preventDefault?.(); cardMenu(event, card); return; }
    const title = at('h3, .cq-logo') ? at('[data-cq-group]') : null;
    if (title || at('.cq-head, .cq-expand, .cq-rail')) { event.preventDefault?.(); headMenu(event, title?.dataset.cqGroup || ''); }
  });
  root.addEventListener('keydown', event => {
    const input = event.target.closest?.('[data-cq-reserve-input]');
    if (!input) return;
    if (event.key === 'Enter') { event.preventDefault?.(); commitReserve(input.dataset.cqReserveInput, input.value); }
    else if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); reserveEditing = null; render(); }
  });
  root.addEventListener('focusout', event => {
    const input = event.target.closest?.('[data-cq-reserve-input]');
    if (input) commitReserve(input.dataset.cqReserveInput, input.value);
  });
  // 倒计时按分钟走；没有新数据时 html 不变，不重建 DOM。
  setIntervalFn(render, 60000);
  accountRisk.subscribe(render);
  loginEvents?.(result => {
    const key = loginKeyOf(result?.id);
    if (!key) return;
    if (result.required) needLogin.set(key, String(result.message || ''));
    else if (result.success) needLogin.delete(key);
    else return;
    render();
  });
  return { render, getState: () => ({ ...state }) };
}

const COLUMNS_HTML = '<div class="cq-columns"><span></span><span>5h 剩余</span><span>7d 剩余</span><span>会话</span></div>';
// 没有 5h 窗口的号：5h 格写「—」，7d 仍在 7d 那一列，和表头对齐。
const NO_5H_CELL = '<span class="cq-cell cq-nodata cq-no5h" title="这个号没有 5 小时窗口">—</span>';

// 按档位分段：同组有两种以上档位才加小标题；档位读不到的号归到「档位未知」。看板和助理页「额度」共用。
// 按档位名归段（段的先后 = 该档第一次出现的位置），同 rank 的不同套餐（如 Team 与 Business）交错时也不会拆成多段。
function tierRowsHtml(rows, cardFn) {
  const buckets = new Map();
  for (const r of rows) { const label = r.tierLabel || ''; if (!buckets.has(label)) buckets.set(label, []); buckets.get(label).push(r); }
  if (buckets.size < 2) return rows.map(cardFn).join('');
  const safe = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let out = '';
  for (const [label, list] of buckets) out += `<div class="cq-subhead" data-cq-plan="${list[0].tierRank || 0}">${safe(label || '档位未知')}</div>` + list.map(cardFn).join('');
  return out;
}

module.exports = { readingText, tierRowsHtml, COLUMNS_HTML, NO_5H_CELL, codexFactLines, LOW_MARK, SHARE_MARK, SOON_MS, createAccountQuotaPanel, viewRows, effective, locationText, nextMonthlyRenewal, renewalAt, recommendClaude, expected7d, paceOf, subscriptionText, PROVIDERS, countActiveSessions, buildActiveSessionCounts, countFromTable, activeAccountSessions,
  quotaCell, accountQuota, accountQuotaRows, accountShortName, subscribeAccountQuota, publishRows };
