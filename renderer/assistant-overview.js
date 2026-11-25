'use strict';
// Tab「任务进展」：顶部一段白话概述；左边先看异常，再按负责人组队分组；右边看这一组每个会话的状态、一句话进展、最后活动。
// 草稿按条目编号保存，刷新、回执都不会清掉正在写的字（互评 2026-11-25 发现的问题，这里一开始就避开）。
// Tab「续跑」（P1 起左栏两组：「现在停着」= 巡逻器提醒（只提醒、不自动发），「近 3 天记录」= 自动续跑与按钮续跑的结果）。P0 返工单 1 第 13 条：近 3 天的自动续跑记录（core/hub-assistant/auto-resume-card.js），顶部提示条收起后在这里还能找到；
//   左边一次 Hub 重启 / CLI 重开一条，右边每个会话已续 / 需核对 / 未续及原因，可续的行（你亲自打开的、在等你拍板的）带「续跑」按钮。

const REFRESH_MS = 20000;
const BADGE_MS = 60000;
// 每页行数跟窗口高度走：每行 50px，扣掉弹窗头、白话一句和底栏约 340px（简化复审建议：1440×800 时第 11 行被裁）。
const taskRowsFor = h => Math.max(4, Math.min(14, Math.floor(((h || 900) - 340) / 50)));
const ST = { waiting: ['等你', 'warn'], stuck: ['卡住', 'bad'], running: ['进行中', 'acc'], done: ['已完成', 'mute'] };
const AR_ROWS = 5; // 「续跑」Tab 每页行数
const AR_ACT = { resumed: ['已续', 'ok'], uncertain: ['需核对', 'warn'], skipped: ['未续', 'mute'], failed: ['未续', 'bad'], retrying: ['重试中', 'warn'] };
const URG = { blocking: ['已停，在等你', 'bad'], deadline: ['有期限', 'warn'], partial: ['其余部分在推进', 'mute'] };
const REPLY = { delivered: ['✓ 已送达', 'ok'], read: ['✓ 已读（已开工）', 'ok'], unconfirmed: ['已发出，未确认送达', 'warn'], queued: ['排队中，对方忙完就送', 'warn'] };

function createAssistantOverview({ document, window, ipcRenderer, showMessage = () => {}, openSession = async () => {} }) {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let root = null, data = null, tab = 'd', curD = null, page = 0, showDone = false, mode = 'pending', lp = 0, timer = null, loading = false, confirmAll = null, skipping = false, skipNote = '';
  let ar = null, stalled = [], arEnabled = true, arMode = 'remind', breakers = [], curR = null, rp = 0, arPage = 0;
  const stallBadges = new Set();
  const arBusy = new Set();
  // 草稿、选中的选项、发送结果都按「条目 + 问题版本」保存：负责人改了问题，旧的选择不会带到新问题上（审查 2026-11-25 第 1 项）。
  const drafts = new Map(), picks = new Map(), results = new Map(), notices = new Map();
  const LEFT_ROWS = 5;
  const keyOf = x => x.id + '#' + (x.ver || '');
  const badges = new Set();

  async function load() {
    if (loading) return data;
    loading = true;
    try {
      const r = await ipcRenderer.invoke('assistant:overview-board');
      if (!r || r.ok === false) throw new Error(r?.error || '前台服务暂未就绪');
      data = r; paintBadges();
      // 续跑记录另走 assistant:auto-resume，读不到不影响另两个 Tab。
      try { const a = await ipcRenderer.invoke('assistant:auto-resume', { action: 'list' }); ar = a?.cards || []; stalled = a?.stalled || []; arEnabled = a?.enabled !== false; arMode = a?.mode || (arEnabled ? 'remind' : 'off'); breakers = a?.breakers || []; } catch { ar = ar || []; }
      paintBadges();
    } finally { loading = false; }
    return data;
  }
  function paintBadges() {
    const n = data?.decisions?.badge || 0;
    for (const b of badges) { b.textContent = n ? String(n) : ''; b.hidden = !n; }
    // 「现在停着」的条数单独一个角标（0 不显示），悬停说明。
    const k = (stalled || []).length;
    for (const b of stallBadges) { b.textContent = k ? String(k) : ''; b.hidden = !k; b.title = k ? `现在有 ${k} 个会话疑似停住，点开「续跑」Tab 看` : ''; }
  }
  function registerBadge(el) { badges.add(el); paintBadges(); }
  function registerStallBadge(el) { stallBadges.add(el); paintBadges(); }
  // 巡逻器一有变化（新提醒、消失）主进程就推过来，角标和 Tab 立刻跟上。
  ipcRenderer.on?.('auto-resume:patrol', (_event, payload = {}) => {
    stalled = Array.isArray(payload.stalled) ? payload.stalled : [];
    if (Array.isArray(payload.breakers)) breakers = payload.breakers;
    paintBadges();
    if (root && !root.hidden && tab === 'r') paint();
  });

  function build() {
    if (root) return;
    root = document.createElement('div'); root.className = 'ov-mask'; root.hidden = true;
    root.innerHTML = `<section class="ov-modal" role="dialog" aria-modal="true" aria-label="当前概览">
      <header class="ov-head"><h2>当前概览</h2>
        <div class="ov-tabs" role="tablist"><button type="button" role="tab" data-ov-tab="d">待我决策<span class="ov-n" data-n="d"></span></button><button type="button" role="tab" data-ov-tab="p">任务进展<span class="ov-n" data-n="p"></span></button><button type="button" role="tab" data-ov-tab="r">续跑<span class="ov-n" data-n="r"></span></button></div>
        <span class="ov-sp"></span><span class="ov-at"></span><button type="button" class="ov-icon" data-ov="refresh" title="刷新">⟳</button><button type="button" class="ov-icon" data-ov="close" title="关闭（Esc）">×</button></header>
      <div class="ov-body"></div>
      <footer class="ov-foot"></footer></section>`;
    document.body.append(root);
    root.addEventListener('click', onClick);
    root.addEventListener('input', e => { const t = e.target.closest('[data-ov-draft]'); if (t) drafts.set(t.dataset.ovDraft, t.value); });
    root.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.closest('[data-ov-draft]')) { e.preventDefault(); void send(e.target.dataset.ovDraft); }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && root && !root.hidden) close(); });
    // 拖动窗口改变高度后重画，每页行数跟着变，不裁掉最后一行（简化复审建议）。
    let resizeTimer = null;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (root && !root.hidden && tab === 'p') paint(); }, 120); });
    root.addEventListener('mousedown', e => { if (e.target === root) close(); });
  }

  function onClick(e) {
    const b = e.target.closest('[data-ov],[data-ov-tab],[data-ov-r],[data-ov-d],[data-ov-opt],[data-ov-open],[data-ov-mode]');
    if (!b) return;
    if (b.dataset.ovTab) { tab = b.dataset.ovTab; paint(); return; }
    if (b.dataset.ovR) { curR = b.dataset.ovR; arPage = 0; paint(); return; }
    if (b.dataset.ovMode) { mode = mode === b.dataset.ovMode ? 'pending' : b.dataset.ovMode; lp = 0; curD = null; confirmAll = null; skipNote = ''; paint(); return; }
    if (b.dataset.ovD) { curD = b.dataset.ovD; paint(); return; }
    if (b.dataset.ovOpt !== undefined) { const k = b.dataset.ovFor, o = b.dataset.ovOpt; picks.set(k, picks.get(k) === o ? null : o); paint(); return; }
    if (b.dataset.ovOpen) { close(); void Promise.resolve(openSession(b.dataset.ovOpen)).catch(err => showMessage(err.message)); return; }
    const a = b.dataset.ov;
    if (a === 'close') close();
    else if (a === 'refresh') void refresh(true);
    else if (a === 'send') void send(b.dataset.ovFor);
    else if (a === 'ar-go') void resumeOne(b.dataset.ovFor, b.dataset.ovSid);
    else if (a === 'ar-patrol') void patrolAct('patrol-resume', b.dataset.ovSid);
    else if (a === 'ar-ignore') void patrolAct('patrol-dismiss', b.dataset.ovSid);
    else if (a === 'ar-toggle') void toggleAutoResume();
    else if (a === 'ar-mode') void setPatrolMode(b.dataset.ovPmode);
    else if (a === 'rprev') { rp = Math.max(0, rp - 1); paint(); }
    else if (a === 'rnext') { rp++; paint(); }
    else if (a === 'arprev') { arPage = Math.max(0, arPage - 1); paint(); }
    else if (a === 'arnext') { arPage++; paint(); }
    else if (a === 'skip') { const x = allDecisions().find(i => keyOf(i) === b.dataset.ovFor); if (x) void skipItems([x], 'skip'); }
    else if (a === 'undo' || a === 'keep') { const x = (data?.decisions?.skipped || []).find(i => i.id === b.dataset.ovFor); if (x) void skipItems([x], a); }
    else if (a === 'skipall') { confirmAll = { mode, list: currentList().map(x => ({ id: x.id, ver: x.ver })) }; skipNote = ''; paint(); }
    else if (a === 'skipall-no') { confirmAll = null; paint(); }
    else if (a === 'skipall-yes') { const snap = confirmAll; confirmAll = null; if (snap && snap.list.length && sameBatch(snap)) void skipItems(snap.list, 'skip'); else { skipNote = '列表刚有变化，没有跳过，请重新点「全部跳过」确认。'; paint(); } }
    else if (a === 'prev') { page = Math.max(0, page - 1); paint(); }
    else if (a === 'next') { page++; paint(); }
    else if (a === 'lprev') { lp = Math.max(0, lp - 1); paint(); }
    else if (a === 'lnext') { lp++; paint(); }
    else if (a === 'done') { showDone = !showDone; page = 0; paint(); }
  }

  const allDecisions = () => { const d = data?.decisions; if (!d) return []; return [...d.main, ...d.more, ...d.unverified]; };
  // 「全部跳过」只跳左栏当前这一类（待你定或待核实）的全部条目，含翻页后面的。
  const currentList = () => { const d = data?.decisions; if (!d) return []; return mode === 'unverified' ? d.unverified : mode === 'pending' ? [...d.main, ...d.more] : []; };
  const sameBatch = snap => { const cur = currentList(); return snap.mode === mode && cur.length === snap.list.length && snap.list.every(s => cur.some(x => x.id === s.id && x.ver === s.ver)); };
  async function skipItems(list, action) {
    if (skipping) return;
    skipping = true;
    try {
      const r = await ipcRenderer.invoke('assistant:overview-skip', { action, items: list.map(x => ({ id: x.id, ver: x.ver })) });
      if (!r) throw new Error('没有回应');
      if (r.ok === false && !r.done && r.error) throw new Error(r.error);
      skipNote = r.text || '';
      if (action === 'skip') for (const x of list) { drafts.delete(keyOf(x)); picks.delete(keyOf(x)); results.delete(keyOf(x)); }
      curD = null;
    } catch (error) { showMessage(`没处理成：${error.message}`); }
    finally { skipping = false; }
    await refresh();
  }
  function optionKey(o) { return o.action === 'pick' ? 'pick:' + o.pick : o.action; }

  async function send(key) {
    const item = allDecisions().find(x => keyOf(x) === key);
    if (!item) return;
    // 发送中再按 Ctrl+Enter 或再点一次，不重复发（审查建议）。
    if (results.get(key)?.state === 'sending') return;
    const pk = picks.get(key), opt = pk ? item.options.find(o => optionKey(o) === pk) : null, text = (drafts.get(key) || '').trim();
    if (!opt && !text) { results.set(key, { state: 'need', text: '先选一个选项，或写一句话。' }); paint(); root.querySelector(`[data-ov-draft="${CSS.escape(key)}"]`)?.focus(); return; }
    results.set(key, { state: 'sending', text: '发送中…' }); notices.delete(item.id); paint();
    try {
      const r = await ipcRenderer.invoke('assistant:overview-reply', { id: item.id, ver: item.ver, action: opt ? opt.action : 'free', pick: opt?.pick, text });
      if (!r || (r.ok === false && !r.state)) throw new Error(r?.error || '没有送出');
      const res = { state: r.state || (r.ok ? 'sent' : 'failed'), text: r.text || r.error || '' };
      if (res.state === 'superseded') { results.delete(key); notices.set(item.id, res.text); }
      else results.set(key, res);
      if (r.ok !== false) { drafts.delete(key); picks.delete(key); }
      if (r.code) { results.set(r.code, res); if (r.ok !== false) curD = r.code; }
    } catch (error) { results.set(key, { state: 'failed', text: `没送出：${error.message}。这条还开着，可以再发一次。` }); }
    await refresh();
  }

  // ---------- 待我决策 ----------
  function listItem(x, cls = '') {
    const u = URG[x.urgency] || URG.blocking, on = x.id === curD;
    return `<button type="button" class="ov-li ${cls}${on ? ' on' : ''}${x.stale ? ' stale' : ''}" data-ov-d="${esc(x.id)}">
      <span class="ov-li-top"><b>${esc(x.title)}</b>${x.stale ? '<span class="ov-chip mute">等待较久，待确认</span>' : `<span class="ov-chip ${u[1]}">${u[0]}</span>`}</span>
      <span class="ov-li-q">${esc(x.question)}</span>
      <span class="ov-li-meta"><span>${esc(x.isMember ? `${x.project} 的成员` : x.project)}</span><span>已等 ${esc(x.waited)}</span></span></button>`;
  }
  function skippedItem(x) {
    return `<button type="button" class="ov-li done${x.id === curD ? ' on' : ''}" data-ov-d="${esc(x.id)}"><span class="ov-li-top"><b>${esc(x.title)}</b><span class="ov-chip mute">${x.skipKind === 'manual' ? '你跳过的' : '自动过期'}</span></span><span class="ov-li-q">${esc(x.question)}</span><span class="ov-li-meta"><span>${esc(x.skipKind === 'manual' ? x.project : x.reason)}</span><span>已等 ${esc(x.waited)}</span></span></button>`;
  }
  function repliedItem(x) {
    const s = REPLY[x.state] || REPLY.delivered;
    return `<button type="button" class="ov-li done${x.id === curD ? ' on' : ''}" data-ov-d="${esc(x.id)}"><span class="ov-li-top"><b>${esc(x.title)}</b><span class="ov-chip ${s[1]}">${s[0]}</span></span><span class="ov-li-q">你回：${esc(x.answerLabel)}</span></button>`;
  }
  // 左栏一次只看一类（待你定 / 待核实 / 已回复），每类按屏分页，不出滚动条（审查第 5 项）。
  function paintDecisions() {
    const d = data.decisions, pending = [...d.main, ...d.more];
    const skippedList = d.skipped || [];
    const lists = { pending, unverified: d.unverified, replied: d.replied, skipped: skippedList };
    if (!lists[mode]?.length && mode !== 'pending') mode = 'pending';
    const cur = lists[mode], rows = mode === 'replied' ? LEFT_ROWS + 1 : LEFT_ROWS, pages = Math.max(1, Math.ceil(cur.length / rows));
    lp = Math.min(lp, pages - 1);
    const shown = cur.slice(lp * rows, lp * rows + rows);
    const pool = allDecisions();
    const exists = id => (mode === 'skipped' ? skippedList : pool).some(x => x.id === id) || d.replied.some(x => x.id === id);
    if (!curD || !exists(curD)) curD = shown[0]?.id || (mode === 'skipped' ? null : pending[0]?.id) || d.replied[0]?.id || null;
    if (confirmAll && !sameBatch(confirmAll)) { confirmAll = null; skipNote = '列表刚有变化，已取消「全部跳过」，请重新确认。'; }
    const allBtn = cur.length > 1 && ['pending', 'unverified'].includes(mode) ? '<button type="button" class="ov-skipall" data-ov="skipall">全部跳过</button>' : '';
    const head = confirmAll
      ? `<b class="ov-confirm">跳过这 ${confirmAll.list.length} 条？可在「已跳过」撤销</b><span class="ov-confirm-btns"><button type="button" class="ov-skipall yes" data-ov="skipall-yes"${skipping ? ' disabled' : ''}>确定跳过</button><button type="button" class="ov-skipall" data-ov="skipall-no">取消</button></span>`
      : { pending: `<b>${pending.length} 件待你定</b>${allBtn || '<span>停着等你的排前面</span>'}`, unverified: `<b>待核实 ${d.unverified.length} 条</b>${allBtn || '<span>可能不是真要你定</span>'}`, replied: `<b>已回复 ${d.replied.length} 条</b><span>最近 24 小时</span>`,
        skipped: `<b>已跳过 ${skippedList.length} 条</b><span>你跳过的 + 自动过期的</span>` }[mode];
    let left = `<div class="ov-left-head${confirmAll ? ' warn' : ''}">${head}</div>${skipNote ? `<div class="ov-skipnote">${esc(skipNote)}</div>` : ''}<div class="ov-list">`;
    left += shown.map(x => mode === 'replied' ? repliedItem(x) : mode === 'skipped' ? skippedItem(x) : listItem(x, mode === 'unverified' ? 'unv' : '')).join('');
    if (!shown.length) left += mode === 'skipped' ? '<div class="ov-empty">没有跳过的条目。</div>' : '<div class="ov-empty">现在没有要你拍板的事。</div>';
    left += '</div><div class="ov-left-foot">';
    left += pages > 1 ? `<span class="ov-lp"><button type="button" data-ov="lprev"${lp ? '' : ' disabled'}>‹</button>${lp + 1}/${pages}<button type="button" data-ov="lnext"${lp < pages - 1 ? '' : ' disabled'}>›</button></span>` : '';
    if (d.unverified.length) left += `<button type="button" class="ov-mode${mode === 'unverified' ? ' on' : ''}" data-ov-mode="unverified">待核实 ${d.unverified.length}</button>`;
    if (d.replied.length) left += `<button type="button" class="ov-mode${mode === 'replied' ? ' on' : ''}" data-ov-mode="replied">已回复 ${d.replied.length}</button>`;
    if (skippedList.length) left += `<button type="button" class="ov-mode${mode === 'skipped' ? ' on' : ''}" data-ov-mode="skipped">已跳过 ${skippedList.length}</button>`;
    if (mode !== 'pending') left += '<button type="button" class="ov-mode" data-ov-mode="pending">回到待你定</button>';
    left += '</div>';
    const sk = mode === 'skipped' ? skippedList.find(i => i.id === curD) : null;
    const x = sk ? null : pool.find(i => i.id === curD), r = sk ? null : d.replied.find(i => i.id === curD);
    let right = '';
    if (sk) {
      const manual = sk.skipKind === 'manual';
      right = `<div class="ov-crumb"><span class="ov-chip mute">${manual ? '你跳过的' : '自动过期'}</span><span>${esc(sk.project)}</span><span>/</span><button type="button" class="ov-link" data-ov-open="${esc(sk.sessionId)}" title="打开这个会话">${esc(sk.title)} ↗</button>${sk.code ? `<span class="ov-code">${esc(sk.code)}</span>` : ''}</div>
        <h3 class="ov-q">${esc(sk.question)}</h3>
        <div class="ov-meta">已等 ${esc(sk.waited)}${manual ? '' : ` · 自动过期原因：${esc(sk.reason)}`}</div>
        <div class="ov-rec"><small>负责人推荐</small><b>${sk.recommendation ? esc(sk.recommendation) : '负责人没写推荐'}</b></div>
        <div class="ov-nr none"><small>${manual ? '跳过以后' : '为什么没显示'}</small><span>${manual ? '这一问不再出现在「待你定」里，也不算红点；负责人换了问题或推荐，会作为新的一问重新出现。待定编号本身没动，会话里照样能回。' : esc(sk.reason) + '。如果其实还要你定，点「恢复显示」放回「待你定」。'}</span></div>
        <div class="ov-send"><span>只影响这个弹窗，不会通知负责人</span><button type="button" class="ov-go" data-ov="${manual ? 'undo' : 'keep'}" data-ov-for="${esc(sk.id)}"${skipping ? ' disabled' : ''}>${manual ? '撤销跳过' : '恢复显示'}</button></div>`;
    } else if (x) {
      const k = keyOf(x), u = x.stale ? ['等待较久，待确认', 'mute'] : URG[x.urgency] || URG.blocking, pick = picks.get(k), res = results.get(k), draft = drafts.get(k) || '', note = notices.get(x.id);
      right = `<div class="ov-crumb"><span class="ov-chip ${u[1]}">${u[0]}</span><span>${esc(x.project)}</span><span>/</span><button type="button" class="ov-link" data-ov-open="${esc(x.sessionId)}" title="打开这个会话">${esc(x.title)} ↗</button>${x.code ? `<span class="ov-code">${esc(x.code)}</span>` : ''}${x.verified ? '' : '<span class="ov-chip warn">待核实</span>'}</div>
        ${note ? `<div class="ov-changed">${esc(note)}</div>` : ''}
        <h3 class="ov-q">${esc(x.question)}</h3>
        <div class="ov-meta">已等 ${esc(x.waited)} · ${esc(x.stateLabel)}${x.leadTitle && x.isMember ? ` · 负责人「${esc(x.leadTitle)}」` : ''}</div>
        <div class="ov-rec"><small>负责人推荐</small><b>${x.recommendation ? esc(x.recommendation) : '负责人没写推荐'}</b></div>
        <div class="ov-nr${x.ifNoReply ? '' : ' none'}"><small>不回会怎样</small><span>${x.ifNoReply ? esc(x.ifNoReply) : '负责人没写后果（' + esc(x.stateLabel) + '）'}</span></div>
        <div class="ov-sec2">你的决定</div>
        <div class="ov-opts">${x.options.map(o => `<button type="button" class="ov-opt${o.action === 'recommend' ? ' rec' : ''}${pick === optionKey(o) ? ' sel' : ''}" data-ov-opt="${esc(optionKey(o))}" data-ov-for="${esc(k)}">${esc(o.label)}${o.action === 'recommend' && x.recommendation ? `：${esc(x.recommendation.length > 18 ? x.recommendation.slice(0, 18) + '…' : x.recommendation)}` : ''}</button>`).join('')}</div>
        <textarea class="ov-ta" data-ov-draft="${esc(k)}" placeholder="选一个选项，或写下你的决定与补充说明…（选了选项再写字，会一起发过去）">${esc(draft)}</textarea>
        <div class="ov-send"><span>发给：<b>${esc(x.title)}</b> · 对方忙就排队，不打断 · Ctrl + Enter 发送</span>${res ? `<span class="ov-res ${esc(res.state)}">${esc(res.text)}</span>` : ''}<button type="button" class="ov-skip" data-ov="skip" data-ov-for="${esc(k)}" title="已经过时或不用管：从列表拿掉，不通知负责人；之后可在「已跳过」撤销"${skipping ? ' disabled' : ''}>跳过</button><button type="button" class="ov-go" data-ov="send" data-ov-for="${esc(k)}"${res?.state === 'sending' ? ' disabled' : ''}>发送回复</button></div>`;
    } else if (r) {
      const s = REPLY[r.state] || REPLY.delivered, lv = r.state === 'read' ? 2 : r.state === 'delivered' ? 1 : r.state === 'unconfirmed' ? 0 : -1;
      right = `<div class="ov-crumb"><span class="ov-chip ${s[1]}">${s[0]}</span><button type="button" class="ov-link" data-ov-open="${esc(r.sessionId)}">${esc(r.title)} ↗</button><span class="ov-code">${esc(r.code)}</span></div>
        <h3 class="ov-q">${esc(r.question)}</h3>
        <div class="ov-rec"><small>你的回复</small><b>${esc(r.answerLabel)}</b></div>
        <div class="ov-steps">${['已发出', '已送达', '已读（负责人已回应）'].map((n, i) => `<span class="${i <= lv ? 'on' : ''}">${i <= lv ? '✓' : '○'} ${n}</span>`).join('<i>›</i>')}</div>
        ${results.get(r.id) ? `<div class="ov-send"><span class="ov-res ${esc(results.get(r.id).state)}" style="text-align:left">${esc(results.get(r.id).text)}</span></div>` : ''}
        <div class="ov-meta">${{ unconfirmed: '没等到送达确认，Hub 不会自动重发；点上面的会话名去看一眼。', read: '负责人在这条之后已经答完一轮。', queued: '对方正忙，空下来就送到；2 小时还没空会告诉你。', delivered: '已经送进会话，负责人答完这一轮后会变成已读。' }[r.state] || ''}</div>`;
    } else right = '<div class="ov-empty big">没有要你拍板的事。<br><small>负责人在进展卡写「等你拍板」或请示你时，会出现在这里。</small></div>';
    return `<div class="ov-cols"><div class="ov-left">${left}</div><div class="ov-right">${right}</div></div>`;
  }

  // ---------- 续跑 ----------
  // 点「续跑」：主进程发一次续跑语（同样认领、写入前复核，见 core/auto-resume/controller.js resumeByUser），结果记回同一张卡。
  async function resumeOne(id, sessionId) {
    const k = id + '|' + sessionId;
    if (arBusy.has(k)) return;
    arBusy.add(k); paint();
    try {
      const r = await ipcRenderer.invoke('assistant:auto-resume', { id, action: 'resume', sessionId });
      if (r?.ok === false && r.row?.reason) showMessage('没续上：' + r.row.reason);
    } catch (error) { showMessage('续跑没办成：' + error.message); }
    finally { arBusy.delete(k); }
    await refresh();
  }
  // 巡逻提醒的「续跑」「忽略」：主进程处理（续跑走 P0 的按钮路径，同一套认领），结果回来刷新列表。
  async function patrolAct(action, sessionId) {
    const k = 'patrol|' + sessionId;
    if (arBusy.has(k)) return;
    arBusy.add(k); paint();
    try {
      const r = await ipcRenderer.invoke('assistant:auto-resume', { action, sessionId });
      if (r?.stalled) stalled = r.stalled;
      if (r?.ok === false && r.error) showMessage('没续上：' + r.error);
    } catch (error) { showMessage((action === 'patrol-resume' ? '续跑' : '忽略') + '没办成：' + error.message); }
    finally { arBusy.delete(k); }
    await refresh();
  }
  async function toggleAutoResume() {
    try { const r = await ipcRenderer.invoke('assistant:auto-resume', { action: 'set-enabled', enabled: !arEnabled }); arEnabled = r?.enabled !== false; }
    catch (error) { showMessage('开关没改成：' + error.message); }
    await refresh();
  }
  // 三档：关 / 只提醒 / 自动续故障类（P2）。
  async function setPatrolMode(mode) {
    if (!mode || mode === arMode) return;
    try { const r = await ipcRenderer.invoke('assistant:auto-resume', { action: 'set-mode', mode }); arMode = r?.mode || mode; arEnabled = r?.enabled !== false; }
    catch (error) { showMessage('档位没改成：' + error.message); }
    await refresh();
  }
  const arTrig = (t, long = false) => t === 'hub-restart' ? (long ? 'Hub 重启后自动续跑' : 'Hub 重启') : t === 'patrol' ? (long ? '巡逻提醒后续跑' : '巡逻提醒') : (long ? 'CLI 进程重开后自动续跑' : 'CLI 进程重开');
  const arTitle = (c, long = false) => c.trigger === 'patrol' && (c.rows || []).some(r => r.by === 'patrol-auto' || r.by === 'quota-resume') ? (long ? '巡逻自动续' : '自动续') : arTrig(c.trigger, long);
  const arCount = (c, act) => (c.rows || []).filter(r => (act === 'skipped' ? r.action === 'skipped' || r.action === 'failed' : r.action === act)).length;
  const arTime = at => at ? new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const arCan = c => (c.rows || []).filter(r => r.canResume && r.action !== 'resumed').length;
  const arOpen = () => (stalled || []).length + (ar || []).reduce((n, c) => n + arCan(c), 0);
  function paintResume() {
    const cards = ar || [], stops = stalled || [];
    // 左栏一个列表、两组：「现在停着」（巡逻提醒，置顶）+「近 3 天记录」（自动续跑 / 按钮续跑的结果）。按屏分页，不出滚动条。
    const items = [...stops.map(s => ({ kind: 'stall', id: s.id, s })), ...cards.map(c => ({ kind: 'card', id: c.id, c }))];
    if (!items.length) return '<div class="ov-empty big">现在没有停住的会话，近 3 天也没有续跑记录。<br><small>巡逻器每分钟看一遍打开着的会话：报错后停、回复半截、送达没开工、压缩后没接上、等结果没被叫醒，都会出现在这里。</small></div>';
    const pages = Math.max(1, Math.ceil(items.length / LEFT_ROWS)); rp = Math.min(rp, pages - 1);
    const shown = items.slice(rp * LEFT_ROWS, rp * LEFT_ROWS + LEFT_ROWS);
    if (!curR || !items.some(x => x.id === curR)) curR = shown[0]?.id || null;
    let left = `<div class="ov-left-head"><b>现在停着 ${stops.length}</b><span>近 3 天记录 ${cards.length}</span></div>`
      + (breakers || []).map(b => `<div class="ov-ar-breaker" title="${esc(b.text)}">⚠ ${esc(b.text)}</div>`).join('') + '<div class="ov-list">';
    let lastKind = null;
    for (const x of shown) {
      if (x.kind !== lastKind) { if (x.kind === 'card' && lastKind === 'stall') left += '<div class="ov-ar-sec">近 3 天记录</div>'; lastKind = x.kind; }
      if (x.kind === 'stall') {
        const s = x.s, chip = s.action === 'remind' ? ['bad', s.label] : ['warn', s.label];
        left += `<button type="button" class="ov-li${x.id === curR ? ' on' : ''}${s.autoStopped ? ' ov-li-stop' : ''}" data-ov-r="${esc(x.id)}"><span class="ov-li-top"><b>${esc(s.title)}</b><span class="ov-chip ${chip[0]}">${esc(chip[1])}</span>${s.autoStopped ? '<span class="ov-chip bad">已停自动续</span>' : ''}</span>`
          + `<span class="ov-li-q">${esc(s.autoNote || s.evidence)}</span><span class="ov-li-meta"><span>已停 ${esc(s.idleText)}</span>${s.autoCount ? `<span>已自动续 ${s.autoCount} 次</span>` : ''}${s.role === 'member' ? '<span>成员 · 负责人会看到</span>' : ''}</span></button>`;
        continue;
      }
      const c = x.c, can = arCan(c);
      const tags = [['resumed', 'ok', '已续'], ['uncertain', 'warn', '需核对'], ['skipped', 'mute', '未续']].map(([k, cls, label]) => arCount(c, k) ? `<span class="ov-chip ${cls}">${label} ${arCount(c, k)}</span>` : '').join('');
      left += `<button type="button" class="ov-li${c.id === curR ? ' on' : ''}" data-ov-r="${esc(c.id)}"><span class="ov-li-top"><b>${arTitle(c)}</b><span class="ov-tags">${tags}</span></span>`
        + `<span class="ov-li-q">${esc(c.trigger === 'hub-restart' ? `检查了 ${(c.rows || []).length} 个会话` : (c.rows?.[0]?.title || ''))}${can ? ` · ${can} 个等你决定续不续` : ''}</span><span class="ov-li-meta"><span>${esc(arTime(c.startedAt || c.at))}</span>${c.state === 'dismissed' ? '<span>提示条已收起</span>' : ''}</span></button>`;
    }
    left += '</div>';
    if (pages > 1) left += `<div class="ov-left-foot"><span class="ov-lp"><button type="button" data-ov="rprev"${rp ? '' : ' disabled'}>‹</button>${rp + 1}/${pages}<button type="button" data-ov="rnext"${rp < pages - 1 ? '' : ' disabled'}>›</button></span></div>`;
    const sel = items.find(x => x.id === curR);
    let right = '';
    if (sel?.kind === 'stall') {
      const s = sel.s, busy = arBusy.has('patrol|' + s.sessionId);
      const why = s.action === 'login' ? '登录失效：先在账号页重新登录，续跑语现在发不出去。'
        : s.action === 'quota' ? (s.autoNote || '额度用尽：交给额度续跑 / 自动换号，这里不重复发。')
        : s.autoStopped ? `连续 ${s.autoCount || 3} 次自动续都没产出，已停自动续：请打开会话看一眼再决定。`
        : arMode === 'auto' && s.autoNote ? s.autoNote
        : '只提醒、不自动发：点「续跑」由你决定发一次续跑语（带原因和自查步骤）。';
      right = `<div class="ov-g-head"><h3>${esc(s.title)}</h3><span>疑似停住 · 已停 ${esc(s.idleText)}</span></div>`
        + `<div class="ov-row"><div class="ov-row-top"><span class="ov-chip ${s.action === 'remind' ? 'bad' : 'warn'}">${esc(s.label)}</span></div>`
        + `<div class="ov-row-line">${esc(s.evidence)}</div>${s.autoNote ? `<div class="ov-row-line${s.autoStopped ? ' ov-warn-inline' : ''}">自动续：${esc(s.autoNote)}${s.autoCount ? `（已续 ${s.autoCount} 次）` : ''}</div>` : ''}<div class="ov-row-meta">停住时间 ${esc(arTime(s.since))} · 发现时间 ${esc(arTime(s.at))}${s.role === 'lead' ? ' · 负责人' : s.role === 'member' ? ' · 成员（提醒只进这里和账本，负责人看组队心跳）' : ''}</div></div>`
        + `<div class="ov-send"><span>${esc(why)}</span>`
        + `<button type="button" class="ov-skip" data-ov="ar-ignore" data-ov-sid="${esc(s.sessionId)}" title="这一回合不再提醒">忽略</button>`
        + `<button type="button" class="ov-skip" data-ov-open="${esc(s.sessionId)}">打开会话</button>`
        + (s.canResume ? `<button type="button" class="ov-go" data-ov="ar-patrol" data-ov-sid="${esc(s.sessionId)}"${busy ? ' disabled' : ''}>${busy ? '发送中…' : '续跑'}</button>` : '')
        + '</div>';
    } else if (sel?.kind === 'card') {
      const c = sel.c, rows = c.rows || [], pg = Math.max(1, Math.ceil(rows.length / AR_ROWS)); arPage = Math.min(arPage, pg - 1);
      right = `<div class="ov-g-head"><h3>${arTitle(c, true)}</h3><span>${esc(arTime(c.startedAt || c.at))} · 已续 ${arCount(c, 'resumed')}、需核对 ${arCount(c, 'uncertain')}、未续 ${arCount(c, 'skipped')}</span></div>`
        + rows.slice(arPage * AR_ROWS, arPage * AR_ROWS + AR_ROWS).map(r => {
          const s = AR_ACT[r.action] || [r.action, 'mute'], busy = arBusy.has(c.id + '|' + r.id), can = r.canResume && r.action !== 'resumed';
          return `<div class="ov-row"><div class="ov-row-top"><button type="button" class="ov-link" data-ov-open="${esc(r.id)}" title="打开这个会话">${esc(r.title)} ↗</button><span class="ov-chip ${s[1]}">${s[0]}</span>${can ? `<button type="button" class="ov-go" data-ov="ar-go" data-ov-for="${esc(c.id)}" data-ov-sid="${esc(r.id)}" title="给这个会话发一次续跑语"${busy ? ' disabled' : ''}>${busy ? '发送中…' : '续跑'}</button>` : ''}</div>`
            + `<div class="ov-row-line">${esc(r.reason || '')}</div><div class="ov-row-meta">${esc(arTime(r.at))}${r.by === 'user-button' ? ' · 你点的续跑' : ''}</div></div>`;
        }).join('') + (pg > 1 ? `<div class="ov-pager"><button type="button" data-ov="arprev"${arPage ? '' : ' disabled'}>上一页</button><span>${arPage + 1} / ${pg}</span><button type="button" data-ov="arnext"${arPage < pg - 1 ? '' : ' disabled'}>下一页</button></div>` : '');
    }
    return `<div class="ov-cols"><div class="ov-left">${left}</div><div class="ov-right">${right}</div></div>`;
  }

  // 一张表：状态 · 会话名 · 一句话最新进展 · 最后活动。等你、卡住在最上面；已完成折叠，点底下的按钮才看。按屏分页，不出滚动条。
  function paintProgress() {
    const p = data.progress, list = showDone ? p.done : p.rows;
    const per = taskRowsFor(window.innerHeight), pages = Math.max(1, Math.ceil(list.length / per)); page = Math.min(page, pages - 1);
    const rows = list.slice(page * per, page * per + per).map(r => {
      const s = r.closed ? ['已关', 'mute'] : ST[r.status] || ST.done;
      return `<div class="ov-tr${r.status === 'done' ? ' done' : ''}"><span class="ov-chip ${s[1]}">${s[0]}</span><button type="button" class="ov-link ov-tn" data-ov-open="${esc(r.sessionId)}" title="打开这个会话">${esc(r.title)}</button><span class="ov-tl${r.warn ? ' warn' : ''}">${r.warn ? '⚠ ' : ''}${esc(r.line || '还没写进展')}</span><span class="ov-tw">${esc(r.lastActive || '—')}</span></div>`;
    }).join('') || `<div class="ov-empty big">${showDone ? '没有已完成的任务。' : '现在没有在动的任务。'}</div>`;
    const foot = `<div class="ov-tfoot">${pages > 1 ? `<span class="ov-lp"><button type="button" data-ov="prev"${page ? '' : ' disabled'}>‹</button>${page + 1}/${pages}<button type="button" data-ov="next"${page < pages - 1 ? '' : ' disabled'}>›</button></span>` : '<span></span>'}${p.done.length || showDone ? `<button type="button" class="ov-mode${showDone ? ' on' : ''}" data-ov="done">${showDone ? '回到在动的任务' : `已完成 ${p.done.length} 个 ▸`}</button>` : ''}</div>`;
    return `<div class="ov-plain one"><p>${esc(p.summary)}</p></div><div class="ov-table">${rows}</div>${foot}`;
  }

  function paint() {
    if (!root || root.hidden || !data) return;
    const focus = document.activeElement, fid = focus?.dataset?.ovDraft, pos = fid ? focus.selectionStart : 0;
    const d = data.decisions, p = data.progress;
    root.querySelectorAll('[data-ov-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.ovTab === tab)));
    root.querySelector('[data-n="d"]').textContent = d.badge || '';
    root.querySelector('[data-n="p"]').textContent = p.total || '';
    root.querySelector('[data-n="r"]').textContent = arOpen() || '';
    root.querySelector('.ov-at').textContent = '前台 ' + new Date(data.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) + ' 汇总';
    root.querySelector('.ov-body').innerHTML = tab === 'd' ? paintDecisions() : tab === 'r' ? paintResume() : paintProgress();
    const f = d.filtered;
    root.querySelector('.ov-foot').innerHTML = tab === 'd'
      ? `<span>只列负责人一级要你定的事，成员的问题由负责人汇总后再报。${f.skipsIssue ? `<b class="ov-warn-inline">${esc(f.skipsIssue)}</b>` : ''}</span><span>回复以「用户」身份发到对应会话</span>`
      : tab === 'r' ? `<span>${arMode === 'auto' ? '报错、回复半截、送达没开工、压缩后没接上、重启 / 重开这几类，你没在看的会话自动续（最多 3 次，越往后隔得越久）；其余只提醒。' : arMode === 'off' ? '自动续跑已关：不巡逻、不自动续。' : '巡逻只提醒、不自动发；点「续跑」由你决定。'}</span><span class="ov-ar-switch">巡逻：${[['off', '关'], ['remind', '只提醒'], ['auto', '自动续故障类']].map(([m, t]) => `<button type="button" class="ov-mode${arMode === m ? ' on' : ''}" data-ov="ar-mode" data-ov-pmode="${m}" aria-pressed="${arMode === m}">${t}</button>`).join('')}</span>`
      : '<span>每个任务一行：项目只显示负责人，成员不单列；一句话进展取负责人进展卡，没写卡的取最近答复。</span><span>点会话名可直接打开</span>';
    if (fid) { const el = root.querySelector(`[data-ov-draft="${CSS.escape(fid)}"]`); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} } }
  }

  async function refresh(manual = false) {
    try { await load(); paint(); }
    catch (error) { if (manual || (root && !root.hidden)) showMessage(`当前概览没刷新：${error.message}`); }
  }
  async function open(which) {
    build(); root.hidden = false; document.body.classList.add('ov-open');
    if (which) tab = which;
    if (!data) root.querySelector('.ov-body').innerHTML = '<div class="ov-empty big">正在汇总…</div>';
    await refresh(true);
    clearInterval(timer); timer = setInterval(() => { if (!loading && !document.activeElement?.dataset?.ovDraft) void refresh(); }, REFRESH_MS);
  }
  function close() { if (!root) return; root.hidden = true; document.body.classList.remove('ov-open'); clearInterval(timer); timer = null; }
  const badgeTimer = setInterval(() => { if (badges.size && (!root || root.hidden)) void load().catch(() => {}); }, BADGE_MS);
  badgeTimer.unref?.();
  return { open, close, refresh, load, registerBadge, registerStallBadge, isOpen: () => !!root && !root.hidden };
}

let shared = null;
function getAssistantOverview(deps) { if (!shared) shared = createAssistantOverview(deps); return shared; }
module.exports = { createAssistantOverview, getAssistantOverview };
