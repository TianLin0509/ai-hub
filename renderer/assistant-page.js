'use strict';
// 左栏：上半「前台」大号身份块（状态、模型、账号、后台、今天派出摘要），点它中间回到前台会话；
//       下半会话列表 = 前台创建的会话 + 近 24 小时用过的会话，按「在跑 / 刚完成 / 空闲（默认折叠）」分组，每行一行标题 + 场景标签 + 红点 + 时间。
// 中间：主页的会话工作区原件（同一套卡片、输入框、后台按钮），默认是前台会话；点左栏哪个会话就切到哪个，输入框直接发给它。
// 右栏：分段 Tab「额度 / 导航 / 今日」。
// 领域助理名册、自绘中间对话（手机对话记录）、拍板按钮与问题目录随 desks 机制一起删除（T-20261113-004）。
const TZ = 'Asia/Shanghai';
const DAY = 86400000;
// 场景 id → 小标签（场景文件 id 形如 tech，前台建会话时也可能写成文件名 02-tech）。
const SCENE_TAG = { coding: '编程', tech: '技术', life: '生活', writing: '写作' };
const EFFORT = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', minimal: '最低', none: '不思考', ultra: '极限' };
const TABS = [['quota', '额度'], ['nav', '导航'], ['today', '今日']];
// 三栏尺寸（照 style-31：左栏约 262、右栏约 230，中间是白纸大卡）；窗口太窄时先收右栏。
const LEFT_W = 270, RIGHT_W = 236, GAP = 14, MID_MIN = 640;
const NAV_ROW_H = 46;

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = at => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(at)).map(x => [x.type, +x.value]));
const sameDay = (a, b) => { const x = ymd(a), y = ymd(b); return x.year === y.year && x.month === y.month && x.day === y.day; };
const clock = at => new Date(at).toLocaleTimeString('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const shortTime = (at, now = Date.now()) => { if (!at) return ''; if (sameDay(at, now)) return clock(at); if (sameDay(at, now - DAY)) return '昨天'; const d = ymd(at); return `${d.month}/${d.day}`; };
const sceneOf = s => {
  let id = s?.scene || s?.meta?.scene || '';
  if (!id && typeof s?.purpose === 'string' && s.purpose.startsWith('scene-')) id = s.purpose.slice(6);
  id = String(id || '').replace(/^\d+-/, '');
  return id ? { id, tag: SCENE_TAG[id] || id } : null;
};
// eslint-disable-next-line no-undef
const globalMeetings = () => { try { return typeof meetings !== 'undefined' ? meetings : undefined; } catch { return undefined; } };
const isFront = s => s?.purpose === 'hub-assistant';
const isTask = s => s?.purpose === 'hub-assistant-task';
// 已退役的旧助理：领域助理（desks 已删）和换班留下的旧前台（标题带「（已换班）」），不进左栏。
const isRetired = s => s?.purpose === 'hub-assistant-desk' || /（已换班）\s*$/.test(String(s?.title || ''));
const titleOf = s => String(s?.title || s?.name || '未命名会话').trim();

// 左栏分组（纯函数，单测用）：前台创建的会话 + 近 24 小时有活动的会话；在跑 / 刚完成 / 空闲，组内按最近活动排。
// classify(s) → 侧栏同一套状态（run / wait / error / unread / idle / dorm …）；unread(s) → 会话「答完了还没看」。
// parks：拍板项「就这样」收起记录（Hub 存一份，手机共用，规则见 core/hub-assistant/front-client.js）；收起的不排前、不亮红点，放进空闲。
function groupSessions(list, { now = Date.now(), classify, unread, activity, excludeId = null, doneWindowMs = 2 * 3600000, parks = {} } = {}) {
  const { parkState } = require('../core/hub-assistant/front-client');
  const groups = { run: [], done: [], idle: [] };
  const rows = [];
  for (const s of list || []) {
    if (!s || !s.id || s.id === excludeId || isFront(s) || isRetired(s) || s._isMeeting || s.meetingId) continue;
    const at = activity(s);
    if (!isTask(s) && !(at > now - DAY)) continue;
    const state = classify(s), parked = parkState(parks[s.id], { state, at, now }), red = !parked && !!unread(s);
    const group = parked ? 'idle' : ['run', 'wait', 'error'].includes(state) ? 'run' : red || (state !== 'dorm' && at > now - doneWindowMs) ? 'done' : 'idle';
    rows.push({ s, at, state, red, group, parked });
  }
  rows.sort((a, b) => b.at - a.at);
  for (const r of rows) groups[r.group].push(r);
  return groups;
}

// 没组队的按标题中点前的前缀（「SR·」「工程·」「研发·」）归组；都没有的单独一行。
const PREFIX_RE = /^\s*([^·・\s]{1,12})\s*[·・]\s*(.+)$/;
function groupKeyOf(s, { leadOf = () => null, getSession = () => null } = {}) {
  const lead = leadOf(s.id), m = titleOf(s).match(PREFIX_RE);
  if (lead) {
    const label = titleOf(getSession(lead) || (lead === s.id ? s : null) || { title: '组队' }), lm = label.match(PREFIX_RE);
    // 成员和负责人同一个前缀（都是「SR·」）时，展开后成员行省掉这个前缀。
    return { key: 'team:' + lead, label, team: true, lead, short: m && lm && m[1] === lm[1] ? m[2] : '' };
  }
  return m ? { key: 'pre:' + m[1], label: m[1], short: m[2] } : null;
}
// 左栏条目（纯函数，单测用）：先按组合并，再按组里最「热」的状态放进在跑 / 刚完成 / 空闲；
// 只有 1 个会话的组不折叠，直接一行。组头汇总：会话数、在跑数、红点数、最近时间。
function buildSections(list, { leadOf, getSession, ...opts } = {}) {
  const g = groupSessions(list, opts), rows = [...g.run, ...g.done, ...g.idle];
  const RANK = { run: 0, done: 1, idle: 2 };
  const byKey = new Map(), items = [];
  for (const r of rows) {
    const k = groupKeyOf(r.s, { leadOf, getSession });
    if (!k) { items.push({ type: 'row', row: r }); continue; }
    let item = byKey.get(k.key);
    if (!item) { item = { type: 'group', key: k.key, label: k.label, team: !!k.team, rows: [], leadRow: null }; byKey.set(k.key, item); items.push(item); }
    if (k.team && r.s.id === k.lead) { item.leadRow = r; continue; }
    if (k.short) r.short = k.short;
    item.rows.push(r);
  }
  const out = { run: [], done: [], idle: [] };
  for (const it of items) {
    if (it.type === 'row') { out[it.row.group].push(it); continue; }
    // 有负责人的组队：至少 1 个成员就成组；没有负责人行的组（含前缀组）照旧要 2 个以上才折叠。不成组时逐个单列、显示全名。
    if (it.rows.length < (it.leadRow ? 1 : 2)) {
      for (const r of [it.leadRow, ...it.rows].filter(Boolean)) { delete r.short; out[r.group].push({ type: 'row', row: r }); }
      continue;
    }
    it.rows.sort((a, b) => RANK[a.group] - RANK[b.group] || b.at - a.at);
    // 整组放进组里（含负责人）最热的状态区；组头的数量、在跑、红点只算成员，负责人自己的状态画在组头上。
    const all = it.leadRow ? [it.leadRow, ...it.rows] : it.rows;
    it.group = all.reduce((g, r) => (RANK[r.group] < RANK[g] ? r.group : g), 'idle');
    it.at = Math.max(...all.map(r => r.at));
    it.run = it.rows.filter(r => r.group === 'run').length;
    it.red = it.rows.filter(r => r.red).length;
    it.wait = it.rows.some(r => r.state === 'wait');
    it.bad = it.rows.some(r => r.state === 'error');
    out[it.group].push(it);
  }
  const atOf = it => it.type === 'row' ? it.row.at : it.at;
  for (const k of Object.keys(out)) out[k].sort((a, b) => atOf(b) - atOf(a));
  return out;
}

function createAssistantPage({ document, window, ipcRenderer, openSessionById = async () => {}, getSession = () => null, getActiveSessionId = () => null, listSessions = () => [], closeOtherPanels = () => {}, showMessage, onOpenChange = () => {} }) {
  let page = null, frontSid = null, tab = 'quota', idleOpen = false, stageWatch = null, placeQueued = false, ticker = null, paintQueued = false;
  let navPage = 0, lastFoldKeys = [], today = null, memos = null, opening = null, embedding = 0;
  // 拍板项收起记录（Hub 里一份，手机也读写同一份）：建页时取一次，之后跟着 assistant:parks 推送更新。
  let parks = {};
  // 分组展开状态记在本机（2026-11-14）：哪些组展开、空闲是否展开。
  const FOLD_KEY = 'hub.assistant.openGroups';
  const openGroups = new Set();
  try { const saved = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}'); for (const k of saved.groups || []) if (typeof k === 'string') openGroups.add(k); idleOpen = !!saved.idle; } catch {}
  const saveFold = () => { try { localStorage.setItem(FOLD_KEY, JSON.stringify({ groups: [...openGroups], idle: idleOpen })); } catch {} };
  try { tab = TABS.some(([k]) => k === localStorage.getItem('hub.assistant.tab')) ? localStorage.getItem('hub.assistant.tab') : 'quota'; } catch {}
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke(channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };
  const quota = () => require('./account-quota-panel.js');
  const sidebar = () => require('../core/session-sidebar-state');
  const activity = s => { try { return require('../core/session-recency').latestActivityTime(s, 0) || 0; } catch { return Math.max(Number(s?.lastMessageTime) || 0, Number(s?.createdAt) || 0); } };
  const sessionMap = () => new Map(listSessions().map(s => [s.id, s]));
  const classifyWith = map => s => { try { return sidebar().sidebarItemClassification(s, { now: Date.now(), sessionMap: map }).state; } catch { return 'idle'; } };
  const unread = s => { try { return require('../core/session-attention-state').sessionHasCompletedUnread(s); } catch { return false; } };
  const modelLabel = (kind, id) => {
    if (!id) return ''; let label = '';
    try { label = require('../core/model-options').modelOptionsFor(kind || 'claude').find(o => o.id === id)?.label || ''; } catch {}
    if (!label && /^gemini(?:-resume)?$/.test(String(kind || ''))) {
      try { label = require('../core/session-manager').SessionManager.geminiDisplayName(id); } catch {}
    }
    if (!label) { const m = String(id).match(/(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(\[1m\])?/i); label = m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + ' ' + m[2] + (m[3] ? '.' + m[3] : '') + (m[4] ? ' 1M' : '') : String(id); }
    return label.replace(/\s*\(1M context\)/i, ' 1M');
  };
  const profileOf = s => { const kind = String(s?.kind || '').replace(/-resume$/, ''); return kind === 'claude' ? ['claude', s.claudeProfile || 'default', s.claudeProfileLabel] : kind === 'codex' ? ['codex', s.codexProfile || '', s.codexProfileLabel] : kind === 'gemini' ? ['antigravity', s.antigravityProfile || '', s.antigravityProfileLabel || ''] : [kind, '', '']; };

  const ICON = {
    front: '<svg viewBox="0 0 24 24" class="ap-ic" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    backstage: '<svg viewBox="0 0 24 24" class="ap-ic" aria-hidden="true"><path d="M4 7l2-3h12l2 3v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 7h16M9 12h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    caret: '<svg viewBox="0 0 24 24" class="ap-ic" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function build() {
    if (page) return;
    page = document.createElement('section'); page.className = 'assistant-page'; page.id = 'assistant-page'; page.hidden = true; page.setAttribute('aria-label', '助理');
    page.innerHTML = `<div class="ap-shell">
      <aside class="ap-side" aria-label="前台与会话">
        <div class="ap-id">
          <button type="button" class="ap-id-head" data-ap="front" title="中间回到和前台的对话"><span class="ap-badge-mark">${ICON.front}</span><span class="ap-id-name"><b class="ap-who">前台</b><span class="ap-st"><i></i><span></span></span></span></button>
          <dl class="ap-meta"><dt>模型</dt><dd class="ap-model">—</dd><dt>账号</dt><dd class="ap-acct">—</dd></dl>
          <div class="ap-acts"><button type="button" class="ap-btn" data-ap="backstage" aria-pressed="false" title="看中间这个会话的终端：卡住了还是在干活。再点一次回到卡片">${ICON.backstage}<span>后台</span></button></div>
          <p class="ap-sum"></p>
        </div>
        <nav class="ap-list" aria-label="会话"></nav>
        <footer class="ap-foot"><button type="button" data-ap="tab-today" class="ap-foot-today"></button><span class="ap-ver"></span></footer>
      </aside>
      <div class="ap-hole" aria-hidden="true"></div>
      <aside class="ap-right" aria-label="额度、导航与今日">
        <div class="ap-seg" role="tablist">${TABS.map(([k, label]) => `<button type="button" role="tab" data-ap-tab="${k}" aria-selected="false">${label}</button>`).join('')}</div>
        <div class="ap-pane" role="tabpanel"></div>
      </aside></div>`;
    document.body.append(page);
    void call('assistant:parks').then(r => { parks = r?.parks || {}; paintSoon(); }).catch(() => {});
    page.addEventListener('click', event => {
      // 行内「就这样 / 恢复」：只改收起记录，不切会话、不给那个会话发消息。
      const pk = event.target.closest('[data-park]');
      if (pk) { void call('assistant:task-action', { sessionId: pk.dataset.psid, action: pk.dataset.park }).then(() => call('assistant:parks')).then(r => { parks = r?.parks || {}; paintSoon(); }).catch(e => showMessage?.(e.message)); return; }
      const row = event.target.closest('[data-sid]');
      if (row) { void openSession(row.dataset.sid).catch(e => showMessage?.(e.message)); return; }
      const t = event.target.closest('[data-ap-tab]');
      if (t) { setTab(t.dataset.apTab); return; }
      const b = event.target.closest('[data-ap]');
      if (b) void action(b.dataset.ap, b).catch(e => showMessage?.(e.message));
    });
    page.addEventListener('change', event => {
      const box = event.target.closest('[data-plan-item]');
      if (box) void planToggle(box).catch(e => showMessage?.(e.message));
    });
  }

  // 摆位：本页铺满导航栏右边、顶栏下面；左右两栏不透明，中间镂空，露出主页的会话工作区。
  // 会话那一栏（.session-workspace）用 body 上的 --ap-stage-ml / --ap-stage-mr 左右让位，宽度随窗口；不动它的折叠与分屏状态。
  function place() {
    if (!page || page.hidden) return;
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), panel = document.getElementById('terminal-panel');
    const stage = panel?.closest('.session-workspace') || panel;
    const left = rail && rail.offsetParent !== null ? rail.getBoundingClientRect().right : 0;
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const bottom = stage ? Math.max(0, window.innerHeight - stage.getBoundingClientRect().bottom) : 0;
    Object.assign(page.style, { left: left + 'px', top: top + 'px', bottom: bottom + 'px', right: '0px' });
    const shown = !!stage && stage.offsetParent !== null;
    const cs = shown ? window.getComputedStyle(stage) : null, rect = shown ? stage.getBoundingClientRect() : null;
    const naturalL = shown ? rect.left - (parseFloat(cs.marginLeft) || 0) : left;
    const naturalR = shown ? rect.right + (parseFloat(cs.marginRight) || 0) : window.innerWidth;
    // 右栏放不下（中间会窄于 MID_MIN）时收起，额度等去顶栏看。
    const roomy = window.innerWidth - left - LEFT_W - RIGHT_W >= MID_MIN;
    const rightW = roomy ? RIGHT_W : 0;
    page.classList.toggle('no-right', !roomy);
    page.style.setProperty('--ap-lw', LEFT_W + 'px'); page.style.setProperty('--ap-rw', rightW + 'px');
    document.body.style.setProperty('--ap-stage-ml', Math.max(0, left + LEFT_W - naturalL) + 'px');
    document.body.style.setProperty('--ap-stage-mr', Math.max(0, naturalR - (window.innerWidth - rightW - GAP)) + 'px');
  }
  const queuePlace = () => { if (placeQueued) return; placeQueued = true; requestAnimationFrame(() => { placeQueued = false; place(); }); };

  // 中间换成某个会话（主页 selectSession 同一条路，未读随之清掉）；点前台身份块 = 回到前台会话。
  async function openSession(sid, { focus = true } = {}) {
    if (!sid) return;
    if (!getSession(sid) && sid !== frontSid) { showMessage?.('这个会话已经不在当前 Hub 里了，可以到主页的会话栏里找'); return; }
    // 切会话时主页会顺手收起别的面板（含本页）：切换期间本页不收。
    embedding++;
    try { await openSessionById(sid, { keepFocus: !focus }); }
    finally { embedding--; paintSoon(); }
    if (focus) focusComposer(sid);
  }
  function focusComposer(sid) {
    const box = document.querySelector(`.floating-input-bar[data-session-id="${window.CSS?.escape ? window.CSS.escape(sid) : sid}"] .floating-input-box`) || document.querySelector('#terminal-panel .floating-input-box');
    try { box?.focus(); } catch {}
  }
  async function ensureFront() {
    if (opening) return opening;
    opening = (async () => { try { const r = await call('assistant:ensure-session'); frontSid = r.sessionId || frontSid; } catch (error) { showMessage?.('前台会话没能启动：' + error.message); } finally { opening = null; } return frontSid; })();
    return opening;
  }
  async function showFront({ focus = true } = {}) {
    const sid = await ensureFront();
    if (!sid || !page || page.hidden) return;
    await openSession(sid, { focus });
  }

  // ---------- 左栏 ----------
  function frontState(s, classify) {
    if (!s) return ['off', '还没启动，说第一句就开工'];
    const st = classify(s);
    if (st === 'run') return ['run', '处理中'];
    if (st === 'wait') return ['wait', '等你回复'];
    if (st === 'error') return ['bad', '运行异常，点「后台」看终端'];
    if (st === 'dorm') return ['off', '休眠，说一句就唤醒'];
    return ['ok', getActiveSessionId() === s.id ? '对话中' : '空闲'];
  }
  function paintSide() {
    const map = sessionMap(), classify = classifyWith(map), now = Date.now();
    const front = frontSid ? getSession(frontSid) : listSessions().find(isFront);
    if (front && !frontSid) frontSid = front.id;
    const [cls, text] = frontState(front, classify);
    const st = page.querySelector('.ap-st'); st.className = 'ap-st ' + cls; st.lastElementChild.textContent = text;
    page.querySelector('.ap-id-head').setAttribute('aria-current', String(!!front && getActiveSessionId() === front.id));
    let model = '—', acct = '—';
    if (front) {
      const [prov, pid, label] = profileOf(front);
      try { model = [modelLabel(prov === 'antigravity' ? 'gemini' : prov, require('../core/session-capabilities').sessionModelId(front)), EFFORT[front.effort] || front.effort].filter(Boolean).join(' ') || '—'; } catch {}
      if (pid || prov === 'claude') { try { acct = quota().accountShortName(prov, pid, label); } catch {} }
    }
    page.querySelector('.ap-model').textContent = model; page.querySelector('.ap-acct').textContent = acct;
    page.querySelector('[data-ap="backstage"]').setAttribute('aria-pressed', String(document.getElementById('btn-backstage')?.getAttribute('aria-pressed') === 'true'));
    // 会议表和账号看板一样直接读 renderer 的全局（team-ui 用它判断负责人是否在群聊里）；读不到就当没有。
    const meetings = globalMeetings();
    const leadOf = sid => { try { return window.__teamUi?.leadOf?.(sid, map, meetings) || (window.__teamUi?.isLead?.(sid) && window.__teamUi.membersOf(sid, map, meetings).length ? sid : null); } catch { return null; } };
    const groups = buildSections(listSessions(), { now, classify, unread, activity, excludeId: frontSid, leadOf, getSession: id => map.get(id) || null, parks });
    const sent = listSessions().filter(s => isTask(s) && sameDay(Number(s.createdAt) || activity(s), now));
    const sentRun = sent.filter(s => ['run', 'wait'].includes(classify(s))).length;
    const allRows = [...groups.run, ...groups.done, ...groups.idle].flatMap(it => it.type === 'row' ? [it.row] : it.leadRow ? [it.leadRow, ...it.rows] : it.rows);
    const reds = allRows.filter(r => r.red).length;
    page.querySelector('.ap-sum').innerHTML = (sent.length ? `今天派出：<b>${sentRun}</b> 在跑，<b>${sent.length - sentRun}</b> 已完成` : '今天还没派出会话')
      + (reds ? `<br><i class="ap-rd"></i><b>${reds}</b> 个会话有新消息` : '');
    const active = getActiveSessionId();
    // 等你的行悬停出「就这样」；已收起的行带灰字「已收起」，悬停出「恢复」。
    const park = r => r.parked
      ? `<em class="ap-parked" title="${r.parked === 'auto' ? '超过 24 小时没回，自动收起' : '已按「就这样」收起'}；助理再来消息会重新出现">已收起</em><span class="ap-park" role="button" data-park="restore" data-psid="${esc(r.s.id)}" title="恢复：重新排回前面，再给 24 小时">恢复</span>`
      : r.state === 'wait' ? `<span class="ap-park" role="button" data-park="park" data-psid="${esc(r.s.id)}" title="就这样：收起，不再排在最前、不亮红点；不会通知这个会话；它再来消息会重新出现">就这样</span>` : '';
    const row = (r, sub = false) => {
      const scene = sceneOf(r.s), icon = r.state === 'run' ? '<i class="ap-spin"></i>' : `<i class="ap-dot ${r.state === 'wait' ? 'wait' : r.state === 'error' ? 'bad' : r.group === 'done' ? 'done' : 'idle'}"></i>`;
      const tip = [titleOf(r.s), scene ? '场景：' + scene.tag : '', isTask(r.s) ? '前台创建' : '', r.state === 'wait' ? '停在等你' : r.state === 'error' ? '运行异常' : '', '点一下，中间切到这个会话'].filter(Boolean).join('\n');
      const name = sub && r.short ? r.short : titleOf(r.s);
      return `<button type="button" class="ap-row${sub ? ' ap-sub' : ''}${active === r.s.id ? ' on' : ''}${r.red ? ' unread' : ''}" data-sid="${esc(r.s.id)}" data-group="${r.group}" aria-current="${active === r.s.id}" title="${esc(tip)}">${icon}<span class="ap-row-title" title="${esc(titleOf(r.s))}">${esc(name)}</span>${scene ? `<em class="ap-tag">${esc(scene.tag)}</em>` : ''}${r.red ? '<i class="ap-rd" aria-label="有新消息"></i>' : ''}${park(r)}<time>${esc(shortTime(r.at, now))}</time></button>`;
    };
    // 组头：一行汇总（会话数 · 在跑数 · 红点数 · 最近时间），点一下展开 / 收起；折叠时当前会话在组里，组头也高亮。
    const fold = it => {
      const open = openGroups.has(it.key), here = it.rows.some(r => r.s.id === active);
      const st = it.run ? `<span class="ap-gs run" title="${it.run} 个成员在跑"><i class="ap-spin"></i>${it.run}</span>` : it.wait ? '<i class="ap-dot wait"></i>' : it.bad ? '<i class="ap-dot bad"></i>' : '';
      const reds = it.red ? `<span class="ap-gred" aria-label="${it.red} 个成员有新消息">${it.red}</span>` : '';
      const body = open ? `<div class="ap-fg-body">${it.rows.map(r => row(r, true)).join('')}</div>` : '';
      if (it.leadRow) {
        // 组队组头就是负责人那一行：左边小箭头只管展开 / 收起成员；其余部分和普通会话行一样，点一下中间切到负责人会话。
        // 数字只算成员；负责人自己的状态（转圈 / 蓝点 / 红点）、收起按钮和最后活动时间都在这一行上。
        const r = it.leadRow, scene = sceneOf(r.s), on = active === r.s.id || (here && !open);
        const icon = r.state === 'run' ? '<i class="ap-spin"></i>' : `<i class="ap-dot ${r.state === 'wait' ? 'wait' : r.state === 'error' ? 'bad' : r.group === 'done' ? 'done' : 'idle'}"></i>`;
        const tip = [titleOf(r.s), '负责人 · ' + it.rows.length + ' 个成员' + (it.run ? `，${it.run} 个在跑` : '') + (it.red ? `，${it.red} 个有新消息` : ''),
          r.state === 'wait' ? '负责人停在等你' : r.state === 'error' ? '负责人运行异常' : '', '点一下，中间切到负责人会话'].filter(Boolean).join('\n');
        return `<div class="ap-fg ap-team${open ? ' open' : ''}" data-fg="${esc(it.key)}"><div class="ap-row ap-gh ap-lead${on ? ' on' : ''}${r.red ? ' unread' : ''}" data-key="${esc(it.key)}" data-group="${r.group}">`
          + `<button type="button" class="ap-caret" data-ap="fold" data-key="${esc(it.key)}" aria-expanded="${open}" title="${open ? '收起' : '展开'} ${it.rows.length} 个成员（不打开会话）">${ICON.caret}</button>`
          + `<button type="button" class="ap-gh-main" data-sid="${esc(r.s.id)}" aria-current="${active === r.s.id}" title="${esc(tip)}">${icon}<span class="ap-row-title ap-gl" title="${esc(titleOf(r.s))}">${esc(it.label)}</span>${scene ? `<em class="ap-tag">${esc(scene.tag)}</em>` : ''}<em class="ap-cnt" title="${it.rows.length} 个成员">${it.rows.length}</em>${st}${reds}${r.red ? '<i class="ap-rd" aria-label="负责人有新消息"></i>' : ''}${park(r)}<time>${esc(shortTime(r.at, now))}</time></button>`
          + '</div>' + body + '</div>';
      }
      const tip = [it.team ? '组队：' + it.label : it.label + ' 开头的会话', `${it.rows.length} 个会话` + (it.run ? `，${it.run} 个在跑` : '') + (it.red ? `，${it.red} 个有新消息` : ''), open ? '点一下收起' : '点一下展开'].join('\n');
      return `<div class="ap-fg${open ? ' open' : ''}" data-fg="${esc(it.key)}"><button type="button" class="ap-row ap-gh${here && !open ? ' on' : ''}" data-ap="fold" data-key="${esc(it.key)}" aria-expanded="${open}" title="${esc(tip)}">${ICON.caret}<span class="ap-row-title ap-gl" title="${esc(it.label)}">${esc(it.label)}</span><em class="ap-cnt">${it.rows.length}</em>${st}${it.red ? `<span class="ap-gred" aria-label="${it.red} 个有新消息">${it.red}</span>` : ''}</button>`
        + (open ? `<div class="ap-fg-body">${it.rows.map(r => row(r, true)).join('')}</div>` : '') + '</div>';
    };
    const item = it => it.type === 'row' ? row(it.row) : fold(it);
    // 区标题的数字只数真正处在这个状态的会话（组里空闲的成员不算进「在跑」）；空闲区数全部。
    // 组队的负责人也是一个会话，区标题照样数进去（组头的数字只算成员，两者口径不同）。
    const count = (items, sec) => items.reduce((n, it) => { if (it.type === 'row') return n + 1; const all = it.leadRow ? [it.leadRow, ...it.rows] : it.rows; return n + (sec === 'idle' ? all.length : all.filter(r => r.group === sec).length); }, 0);
    const head = (label, n) => `<h3 class="ap-group-h"><span>${label}</span><b>${n}</b></h3>`;
    const keys = [...groups.run, ...groups.done, ...groups.idle].filter(it => it.type === 'group').map(it => it.key);
    lastFoldKeys = keys;
    const allOpen = (!groups.idle.length || idleOpen) && keys.every(k => openGroups.has(k));
    let html = keys.length || groups.idle.length ? `<div class="ap-list-bar"><span>会话 ${allRows.length}</span><button type="button" class="ap-foldall" data-ap="fold-all" aria-pressed="${allOpen}" title="${allOpen ? '把所有分组和空闲收成一行' : '展开所有分组和空闲'}">${allOpen ? '全部收起' : '全部展开'}</button></div>` : '';
    if (groups.run.length) html += `<section class="ap-group" data-g="run">${head('在跑', count(groups.run, 'run'))}${groups.run.map(item).join('')}</section>`;
    if (groups.done.length) html += `<section class="ap-group" data-g="done">${head('刚完成', count(groups.done, 'done'))}${groups.done.map(item).join('')}</section>`;
    if (groups.idle.length) {
      // 空闲默认折叠成一行摘要；当前打开的会话在空闲里时也展开，免得找不到它。
      const open = idleOpen || groups.idle.some(it => (it.type === 'row' ? [it.row] : it.rows).some(r => r.s.id === active));
      const names = groups.idle.map(it => it.type === 'row' ? titleOf(it.row.s) : `${it.label}（${it.rows.length}）`);
      html += `<section class="ap-group${open ? ' open' : ''}" data-g="idle"><button type="button" class="ap-group-h ap-fold" data-ap="idle-toggle" aria-expanded="${open}"><span>空闲</span><b>${count(groups.idle, 'idle')}</b></button>`
        + (open ? groups.idle.map(item).join('') : `<button type="button" class="ap-fold-sum" data-ap="idle-toggle" title="${esc(names.join('、'))}">${ICON.caret}<span>${esc(names.slice(0, 4).join('、'))}</span></button>`) + '</section>';
    }
    if (!html) html = '<p class="ap-none">近 24 小时没有用过的会话。对前台说要做什么，它会新开会话去办，会话出现在这里。</p>';
    const list = page.querySelector('.ap-list');
    if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }
    const ver = document.getElementById('hub-version')?.textContent || '';
    page.querySelector('.ap-ver').textContent = ver;
    const openMemos = memos ? memos.open.length : null, planLeft = Array.isArray(today?.plan?.items) ? today.plan.items.filter(i => !i.done).length : null;
    page.querySelector('.ap-foot-today').textContent = [planLeft != null ? `今日 ${planLeft}` : '今日', openMemos != null ? `备忘 ${openMemos}` : ''].filter(Boolean).join(' · ');
  }

  // ---------- 右栏 ----------
  function setTab(next) {
    tab = TABS.some(([k]) => k === next) ? next : 'quota'; navPage = 0;
    try { localStorage.setItem('hub.assistant.tab', tab); } catch {}
    if (tab === 'today') void loadToday();
    paintRight();
  }
  const pager = (pageNo, pages, name) => pages > 1 ? `<div class="ap-pager"><button type="button" data-ap="${name}-prev"${pageNo ? '' : ' disabled'} aria-label="上一页">‹</button><span>${pageNo + 1} / ${pages}</span><button type="button" data-ap="${name}-next"${pageNo < pages - 1 ? '' : ' disabled'} aria-label="下一页">›</button></div>` : '';
  const fitRows = rowH => { const pane = page.querySelector('.ap-pane'); return Math.max(2, Math.floor(((pane?.clientHeight || 600) - 70) / rowH)); };
  // 格子直接用看板的 quotaCell（剩余 %、重置倒计时、细线、四档颜色一致）；按 Claude / Codex / Gemini 分节，5X 号在前用小标题隔开；
  // 风控号隐藏、前台在用的号蓝色编号 + 左侧蓝线；邮箱、重置时刻在悬停里。一屏放下，不翻页。
  function paintQuota() {
    let all = [];
    try { all = quota().accountQuotaRows(); } catch {}
    const front = frontSid ? getSession(frontSid) : null, [fp, fid] = front ? profileOf(front) : [];
    const now = Date.now(), q = quota();
    const PROV = [['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'Gemini']];
    const sections = PROV.map(([id, name]) => ({ id, name, rows: all.filter(r => r.provider === id && !(r.riskShown ?? r.risky) && !r.panelHidden) })).filter(g => g.rows.length);
    if (!sections.length) return '<div class="ap-ph"><b>账号额度</b></div><p class="ap-none">还没读到额度。额度随使用更新（会话记录读取），另有 30 分钟一次兜底。</p>';
    const usable = rows => rows.filter(r => r.eff !== null && r.eff !== undefined ? r.eff >= 15 : [r.remain5h, r.remain7d].filter(v => v != null).every(v => v >= 15) && (r.remain5h != null || r.remain7d != null)).length;
    const when = at => Number.isFinite(at) && at > now ? (sameDay(at, now) ? clock(at) : shortTime(at, now) + ' ' + clock(at)) + ' 重置' : '';
    const tip = (r, isFront) => [q.accountShortName(r.provider, r.profileId, r.label) + (r.tierShort ? ' · ' + r.tierShort : ''), r.label, r.email, isFront ? '前台正在用这个号' : '',
      r.has5h ? `5h 剩余 ${r.remain5h ?? '未知'}%${when(r.reset5h) ? '，' + when(r.reset5h) : ''}` : '', `7d 剩余 ${r.remain7d ?? '未知'}%${when(r.reset7d) ? '，' + when(r.reset7d) : ''}`,
      Number.isFinite(r.sessions) ? `活跃会话 ${r.sessions} 个` : '', r.apiKey ? '' : q.readingText(r.lastSeen, now), r.error ? '刷新失败：' + r.error : ''].filter(Boolean).join('\n');
    const card = r => {
      const isFront = r.provider === fp && r.profileId === fid, empty = r.remain5h == null && r.remain7d == null;
      const cells = r.apiKey ? '<span class="cq-cell cq-wide cq-nodata">API Key 登录</span>'
        : empty ? `<span class="cq-cell cq-wide cq-nodata">${r.error ? '刷新失败' : '暂无数据'}</span>`
          : r.has5h ? q.quotaCell(r, '5h', now) + q.quotaCell(r, '7d', now) : q.NO_5H_CELL + q.quotaCell(r, '7d', now);
      const ses = Number.isFinite(r.sessions) ? `<span class="cq-sessions${r.sessions ? '' : ' is-zero'}" data-cq-many="${r.sessions >= 2 ? 1 : 0}">${r.sessions}</span>` : '<span></span>';
      return `<div class="cq-card ap-qc${isFront ? ' is-current' : ''}${r.recommended ? ' is-recommended' : ''}" data-account="${esc(r.provider + ':' + r.profileId)}" title="${esc(tip(r, isFront))}"><span class="cq-no">${r.no}${r.error ? '<span class="cq-error-mark">!</span>' : ''}</span>${cells}${ses}</div>`;
    };
    // 档位分段与右侧看板同一份（Claude Max 5X/20X、Codex Pro 5X/20X、Gemini Ultra/Pro）。
    const rowsHtml = rows => q.tierRowsHtml(rows, card);
    return `<div class="ap-ph"><b>账号额度</b><span title="数字为剩余额度，旁边是距重置的倒计时；最右是用这个号的活跃会话数">剩余 % · 重置倒计时</span></div><div class="ap-qlist ap-cq">`
      + sections.map((g, i) => `<section class="cq-group" data-cq-group="${g.id}"><h3><span class="cq-provider">${g.name}</span><span class="cq-count"><b>${usable(g.rows)}</b> / ${g.rows.length} 可用</span></h3>`
        + (i === 0 ? q.COLUMNS_HTML : '')
        + `<div class="cq-rows">${rowsHtml(g.rows)}</div></section>`).join('') + '</div>';
  }
  function paintNav() {
    const map = sessionMap(), classify = classifyWith(map), now = Date.now(), active = getActiveSessionId();
    const tasks = listSessions().filter(s => isTask(s) && s.id !== frontSid).sort((a, b) => (Number(b.createdAt) || activity(b)) - (Number(a.createdAt) || activity(a)));
    const per = Math.max(2, fitRows(NAV_ROW_H) - 1), pages = Math.max(1, Math.ceil(tasks.length / per)); navPage = Math.min(navPage, pages - 1);
    // 状态分组与左栏同一口径（groupSessions）：在跑 / 刚完成 / 空闲。
    const grouped = groupSessions(tasks, { now, classify, unread, activity }), groupOf = new Map(Object.entries(grouped).flatMap(([g, rows]) => rows.map(r => [r.s.id, r])));
    const tick = s => { const r = groupOf.get(s.id) || { group: 'idle', state: classify(s), red: unread(s) }, scene = sceneOf(s), cls = r.group;
      const label = r.state === 'wait' ? '等你' : r.state === 'error' ? '异常' : r.group === 'run' ? '在跑' : r.group === 'done' ? '刚完成' : r.state === 'dorm' ? '休眠' : '空闲';
      return `<button type="button" class="ap-tk ${cls}${active === s.id ? ' on' : ''}" data-sid="${esc(s.id)}" aria-current="${active === s.id}"><span class="ap-tk-d"><i></i>${r.red ? '<em class="ap-rd"></em>' : ''}</span><span class="ap-tk-lb" title="${esc(titleOf(s))}"><b>${esc(titleOf(s))}</b><small>${esc([shortTime(Number(s.createdAt) || activity(s), now), label, scene?.tag].filter(Boolean).join(' · '))}</small></span></button>`; };
    const front = frontSid ? `<button type="button" class="ap-tk front${active === frontSid ? ' on' : ''}" data-sid="${esc(frontSid)}" aria-current="${active === frontSid}"><span class="ap-tk-d"><i></i></span><span class="ap-tk-lb"><b>前台</b><small>点任一会话中间切过去</small></span></button>` : '';
    const body = tasks.length ? tasks.slice(navPage * per, navPage * per + per).map(tick).join('') : '<p class="ap-none">前台还没派出会话。对它说一件要动手的事，它会自己写好提示词、选好场景新开会话，会话按时间排在这里。</p>';
    return `<div class="ap-ph"><b>前台派出的会话</b><span>${tasks.length} 个 · 新的在上</span></div><div class="ap-scale">${front}${body}</div>${pager(navPage, pages, 'nav')}`;
  }
  async function loadToday() {
    const [w, m] = await Promise.all([call('assistant:workbench').catch(() => null), call('assistant:memos').catch(() => null)]);
    today = w; memos = m && Array.isArray(m.open) ? m : null;
    if (page && !page.hidden) { paintRight(); paintSide(); }
  }
  const TIMERS = [['enabled', '每日计划·总结', '08:00 今日计划和今日一档、21:00 今日总结'], ['memoDigest', '晚间备忘清单', '每晚 21:00 把待办备忘推一次'], ['checkpoint', '每日交接记录', '每天一次让前台复盘并写交接']];
  function paintToday() {
    if (!today && !memos) return '<div class="ap-ph"><b>今日</b></div><p class="ap-none">读取中…</p>';
    const p = today?.plan, cfg = today?.config || {};
    const plan = p ? `<p class="ap-plan-text">${esc(p.text)}</p>${(p.items || []).slice(0, 5).map(i => `<label class="ap-plan-item${i.done ? ' done' : ''}"><input type="checkbox" data-plan-item="${esc(i.id)}"${i.done ? ' checked' : ''}><time>${esc(i.time || '')}</time><span>${esc(i.title)}</span></label>`).join('')}`
      : `<p class="ap-none">${esc(cfg.morning || '08:00')} 生成今日计划；定时停着时，对前台说「排一下今天」也行。</p>`;
    const open = memos?.open || [];
    const memo = open.length ? open.slice(0, 5).map(m => `<div class="ap-memo"><button type="button" class="ap-memo-ck" data-ap="memo-done" data-memo="${esc(m.id)}" aria-label="办完了：${esc(m.title)}"></button><span>${m.no ? `<em>${m.no}</em>` : ''}${esc(m.title)}</span>${m.dueLabel ? `<time>${esc(m.dueLabel)}</time>` : ''}</div>`).join('') + (open.length > 5 ? `<p class="ap-more">还有 ${open.length - 5} 条，问前台「备忘」看全部</p>` : '')
      : '<p class="ap-none">备忘是空的。对前台说「记一下……」就记在这里。</p>';
    const timers = today?.config ? TIMERS.map(([k, label, tip]) => `<button type="button" class="ap-switch" data-ap="timer" data-key="${k}" aria-pressed="${!!cfg[k]}" title="${esc(tip)}；点一下${cfg[k] ? '停掉' : '打开'}"><span>${esc(label)}</span><i></i></button>`).join('') : '';
    const autoOn = document.body.classList.contains('assistant-auto-view');
    return `<div class="ap-ph"><b>今日计划</b><span>${p?.confirmedAt ? '已确认' : ''}</span></div><div class="ap-today-sec">${plan}</div>
      <div class="ap-ph"><b>备忘</b><span>${open.length} 条待办</span></div><div class="ap-today-sec">${memo}</div>
      <div class="ap-ph"><b>定时</b><span>到点提醒照常</span></div><div class="ap-today-sec ap-timers">${timers}<button type="button" class="ap-switch" data-ap="auto-view" aria-pressed="${autoOn}" title="定时生成的回合平时在前台会话里收起；打开后中间只看这些回合"><span>看定时回合</span><i></i></button></div>`;
  }
  function paintRight() {
    if (!page) return;
    for (const b of page.querySelectorAll('[data-ap-tab]')) b.setAttribute('aria-selected', String(b.dataset.apTab === tab));
    const pane = page.querySelector('.ap-pane'), html = tab === 'nav' ? paintNav() : tab === 'today' ? paintToday() : paintQuota();
    pane.dataset.tab = tab;
    if (pane.dataset.html !== html) { pane.innerHTML = html; pane.dataset.html = html; }
  }
  function paint() { if (!page || page.hidden) return; paintSide(); paintRight(); }
  function paintSoon() { if (paintQueued) return; paintQueued = true; requestAnimationFrame(() => { paintQueued = false; paint(); }); }

  async function planToggle(box) {
    box.disabled = true;
    try { today = await call('assistant:workbench-action', { action: box.checked ? 'done' : 'reopen', day: today?.day, itemId: box.dataset.planItem }); }
    catch (error) { box.checked = !box.checked; throw error; } finally { box.disabled = false; paint(); }
  }
  async function action(name, button) {
    if (name === 'front') return showFront();
    if (name === 'backstage') { document.getElementById('btn-backstage')?.click(); paintSoon(); return; }
    if (name === 'idle-toggle') { idleOpen = !idleOpen; saveFold(); paintSide(); return; }
    if (name === 'fold') { const k = button.dataset.key; if (openGroups.has(k)) openGroups.delete(k); else openGroups.add(k); saveFold(); paintSide(); return; }
    if (name === 'fold-all') {
      const open = button.getAttribute('aria-pressed') !== 'true';
      openGroups.clear(); if (open) for (const k of lastFoldKeys) openGroups.add(k);
      idleOpen = open; saveFold(); paintSide(); return;
    }
    if (name === 'tab-today') return setTab('today');
    if (/^nav-(prev|next)$/.test(name)) { navPage = Math.max(0, navPage + (name.endsWith('next') ? 1 : -1)); paintRight(); return; }
    if (name === 'memo-done') { button.disabled = true; try { await call('assistant:memo-action', { ref: button.dataset.memo, action: 'done' }); } finally { await loadToday(); } return; }
    if (name === 'timer') {
      const key = button.dataset.key, cfg = today?.config || {};
      try { const r = await call('assistant:workbench-action', { action: 'configure', config: { [key]: !cfg[key] } }); if (r?.config) today = { ...(today || {}), config: r.config }; }
      catch (error) { showMessage?.('定时开关没改成：' + error.message); }
      paintRight(); return;
    }
    if (name === 'auto-view') {
      const on = !document.body.classList.contains('assistant-auto-view');
      document.body.classList.toggle('assistant-auto-view', on);
      if (on && frontSid && getActiveSessionId() !== frontSid) await showFront({ focus: false });
      paintRight(); return;
    }
  }

  const onResize = () => { place(); paintSoon(); };
  async function open() {
    build(); closeOtherPanels(); window.__assistantHide?.();
    page.hidden = false; onOpenChange(true);
    const body = document.body;
    // assistant-embed / assistant-tools：顶栏按中间那个会话画（后台、问一下等会话工具都在）；assistant-stage：会话栏按本页让位。
    body.classList.add('assistant-page-open', 'assistant-embed', 'assistant-stage', 'assistant-tools');
    document.dispatchEvent(new window.CustomEvent('assistant-embed-change'));
    place(); paint(); requestAnimationFrame(place);
    window.addEventListener('resize', onResize);
    stageWatch?.disconnect(); stageWatch = null;
    const stage = document.getElementById('terminal-panel');
    if (stage && window.ResizeObserver) { stageWatch = new window.ResizeObserver(queuePlace); stageWatch.observe(stage); }
    document.getElementById('btn-assistant')?.classList.remove('assistant-has-unread');
    // 相对时间、额度倒计时随时间走：30 秒重画一次（只在本页开着时）。
    clearInterval(ticker); ticker = setInterval(paint, 30000);
    void loadToday();
    await showFront();
  }
  function close() {
    if (!page || page.hidden || embedding) return;
    page.hidden = true;
    document.body.classList.remove('assistant-page-open', 'assistant-embed', 'assistant-stage', 'assistant-tools', 'assistant-auto-view');
    document.body.style.removeProperty('--ap-stage-ml'); document.body.style.removeProperty('--ap-stage-mr');
    stageWatch?.disconnect(); stageWatch = null; clearInterval(ticker); ticker = null;
    document.dispatchEvent(new window.CustomEvent('assistant-embed-change'));
    window.removeEventListener('resize', onResize); onOpenChange(false);
  }
  document.addEventListener('click', e => { if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-assistant)')) close(); });
  // 侧栏每次重画（会话状态、未读、标题变了）都跟着重画左栏和右栏。
  document.addEventListener('hub-session-surfaces-rendered', paintSoon);
  try { quota().subscribeAccountQuota(() => { if (tab === 'quota') paintSoon(); }); } catch {}
  ipcRenderer.on('assistant:parks', (_e, next) => { parks = next || {}; paintSoon(); });
  ipcRenderer.on('assistant:memos-changed', () => { if (page && !page.hidden) void loadToday(); });
  // 前台换班（上下文用满后新开会话接续）：中间跟到新的前台会话。
  ipcRenderer.on('assistant:rotated', () => { frontSid = null; if (page && !page.hidden) void showFront({ focus: false }); });
  ipcRenderer.on('assistant:dialog', (_e, entry) => {
    if (!entry || entry.role !== 'assistant' || !String(entry.text || '').trim()) return;
    if (page && !page.hidden && document.hasFocus()) return;
    // 定时任务的到点推送（每日计划、总结、交接）不点亮导航红点。
    let auto = false; try { auto = require('./assistant-auto-tasks').isAutoNotice(entry); } catch {}
    if ((!page || page.hidden) && !auto) document.getElementById('btn-assistant')?.classList.add('assistant-has-unread');
    const id = String(entry.id || '');
    if (entry.lane === 'notice' && !/^notice:(podcast|memo|digest)/.test(id)) return;
    try { ipcRenderer.send('hub-pet:notice', { id: 'assistant:' + id + ':' + (entry.at || Date.now()), title: (entry.by || '前台') + ' 答复了', text: String(entry.text).slice(0, 400) }); } catch {}
  });
  return { open, close, isOpen: () => !!page && !page.hidden, showFront, openSession, frontSessionId: () => frontSid };
}
module.exports = { createAssistantPage, groupSessions, buildSections, groupKeyOf, isRetired, sceneOf };
