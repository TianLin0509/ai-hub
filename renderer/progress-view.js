/* 「进展」视图（2026-10-27，取代原「开发」看板入口）。
 *
 *
 * 主进程 main/progress-card-service.js 从普通回答里找可选的「进展概述」，推 progress-cards:changed 过来。
 * 这里只画左侧栏「进展」页；会话正文继续按原回答自然显示，不再在标题或卡片上方插入进展控件。
 */
(function () {
  'use strict';
  const { ipcRenderer, shell } = require('electron');
  const cards = new Map();                 // sessionId → 主进程推来的条目
  let root = null, opened = false, strip = null, stripOpen = new Set(), shownFor = null, lastKey = '';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function ago(ms) {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分前` : `${Math.floor(m / 1440)} 天前`;
  }
  const minutes = ms => Math.max(0, Math.round((Date.now() - ms) / 60000));
  function activeId() { try { return typeof activeSessionId !== 'undefined' ? activeSessionId : null; } catch { return null; } }  // renderer.js 的全局
  // 手动操作（2026-10-28）：「已处理」消掉这条拍板，「收起」把进展条收成小标签。都只对这一版卡有效，
  // 卡一更新（修改时间变了）就自动失效、重新显示。存在本机 localStorage，重启 Hub 仍记得。
  const DISMISS_KEY = 'hub.progress.dismiss.v1';
  let dismissed = {};
  try { dismissed = JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}') || {}; } catch { dismissed = {}; }
  function dismissOf(c) { const d = dismissed[c.cardPath]; return d && d.mtimeMs === c.mtimeMs ? d : {}; }
  function setDismiss(c, patch) {
    dismissed[c.cardPath] = { ...dismissOf(c), ...patch, mtimeMs: c.mtimeMs };
    for (const k of Object.keys(dismissed)) if (!dismissed[k].decision && !dismissed[k].strip) delete dismissed[k];
    const keys = Object.keys(dismissed); if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete dismissed[k];
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed)); } catch {}
    refreshAll();
  }
  // 还在等你拍板：卡上有拍板，你在卡更新后没回复过（主进程按对话记录判断），也没手动标记处理。
  const pending = c => Boolean(c.plain && c.plain.decision && !c.decisionAnsweredAt && !dismissOf(c).decision);
  function handledNote(c) {
    if (!c.plain || !c.plain.decision || pending(c)) return '';
    return c.decisionAnsweredAt ? `你 ${ago(c.decisionAnsweredAt)}已在对话里回复，等 AI 更新进展卡` : '你已标记为处理过';
  }
  function statusOf(c) {
    if (pending(c)) return { cls: 'decide', label: '待拍板' };
    if (c.stale) return { cls: 'stale', label: '久未更新' };
    const s = c.plain && c.plain.status;
    return s ? { cls: { 顺利: 'ok', 有风险: 'risk', 卡住: 'stuck', 已完成: 'done' }[s], label: s } : { cls: 'unknown', label: '未写白话' };
  }
  // 一句话现状：Agent 写的优先；久未更新或没写白话块时用代写，并标出来。
  function lineOf(c) {
    const own = c.plain && c.plain.line;
    if (c.ghost && (c.stale || !own)) return { text: c.ghost.line, ghost: true };
    return { text: own || c.cardTitle || '这张进展卡还没有「给用户看」白话块', ghost: false };
  }
  const countText = c => (c.total ? `${c.done ?? 0}/${c.total}` : '');
  const whenText = c => c.stale ? `已 ${minutes(c.mtimeMs)} 分钟没更新` : `更新于 ${ago(c.mtimeMs)}`;

  // ③ 会话行：标题前一个状态点；待拍板时换成橙色小标签。悬停标题能看到白话现状。
  // 进展不再占用会话标题。标题保持干净，主动写了「进展概述」的回答
  // 只在左侧「进展」页聚合展示。
  window.__progressBadgeFor = () => null;

  // ② 顶部进展条
  function ensureStrip() { return null; }
  function syncStripHeight() {
    const panel = document.getElementById('terminal-panel');
    if (panel && strip) panel.style.setProperty('--progress-strip-h', `${strip.hidden ? 0 : strip.offsetHeight}px`);
  }
  function stripHtml(c) {
    const st = statusOf(c), line = lineOf(c), open = stripOpen.has(c.sessionId), d = pending(c) ? c.plain.decision : null;
    if (dismissOf(c).strip) {
      return `<button type="button" class="pg-mini" data-pg-action="unmini" title="展开进展条">${st.cls === 'decide' ? '<span class="pg-ask">待拍板</span>' : `<i class="pg-dot pg-${st.cls}"></i>`}进展 ▸</button>`;
    }
    const pct = c.total ? Math.round(100 * (c.done || 0) / c.total) : 0;
    const head = `<div class="pg-bar" data-pg-action="toggle" role="button" tabindex="0" aria-expanded="${open}">
        <span class="pg-caret">${open ? '▾' : '▸'}</span>
        ${st.cls === 'decide' ? '<span class="pg-ask">待你拍板</span>' : `<span class="pg-chip"><i class="pg-dot pg-${st.cls}"></i>${esc(st.label)}</span>`}
        <span class="pg-line">${line.ghost ? '<b class="pg-ghost-tag">［系统代写］</b>' : ''}${esc(d ? d.question : line.text)}</span>
        ${c.total ? `<span class="pg-prog"><span class="pg-track"><span class="pg-fill" style="width:${pct}%"></span></span>${esc(countText(c))}</span>` : ''}
        <span class="pg-when${c.stale ? ' pg-late' : ''}">${esc(whenText(c))}</span>
        ${d ? '<button type="button" class="pg-tool" data-pg-action="dismiss-decision" title="这条拍板已经处理过了，不再标橙；卡更新后若还有拍板会重新出现">已处理</button>' : ''}
        <button type="button" class="pg-tool" data-pg-action="mini" title="收起进展条；卡更新后自动重新展开" aria-label="收起进展条">收起</button></div>`;
    if (!open) return head;
    const rows = [['目标', c.goal], ['现状', c.plain && c.plain.line], ['进度', c.plain && c.plain.progress], ['新发现', c.plain && c.plain.finding]]
      .filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
    const ghost = line.ghost ? `<div class="pg-ghost">Agent 已 ${minutes(c.mtimeMs)} 分钟没更新进展卡。上面这句是 Hub 用低档模型读进展卡和最近的对话代写的，可能不准；Agent 下次更新卡后自动换回它写的版本。</div>` : '';
    const handled = handledNote(c);
    const decideDone = handled ? `<div class="pg-decide-box pg-handled"><div>拍板：${esc(c.plain.decision.question)}</div><div class="pg-handled-note">✓ ${esc(handled)}</div></div>` : '';
    const decide = d ? `<div class="pg-decide-box"><div class="pg-q">等你拍板：${esc(d.question)}</div>${d.recommendation ? `<div>推荐：${esc(d.recommendation)}</div>` : ''}
        <div class="pg-acts">${d.recommendation ? '<button type="button" class="pg-btn pg-pri" data-pg-action="reply-rec">按推荐回复</button>' : ''}<button type="button" class="pg-btn" data-pg-action="reply-own">我自己回复</button></div></div>` : '';
    return `${head}<div class="pg-detail">${ghost}<dl>${rows || '<dt>现状</dt><dd>这张进展卡还没有「给用户看」白话块。</dd>'}</dl>${decide}${decideDone}
      <div class="pg-links"><button type="button" class="pg-link" data-pg-action="open-card">打开进展卡</button><button type="button" class="pg-link" data-pg-action="open-folder">打开所在文件夹</button><span class="pg-path">${esc(c.cardPath)}</span></div></div>`;
  }
  function renderStrip() {
    // 旧版顶部进展条保留空函数，避免历史调用点影响卡片布局。
    if (strip) { strip.hidden = true; strip.innerHTML = ''; }
  }
  function fillComposer(sessionId, text) {
    const box = document.querySelector(`.floating-input-bar[data-session-id="${CSS.escape(sessionId)}"] .floating-input-box`);
    if (!box) return false;
    box.textContent = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
    const sel = window.getSelection(), range = document.createRange();
    range.selectNodeContents(box); range.collapse(false); sel.removeAllRanges(); sel.addRange(range);
    return true;
  }
  function onStripClick(e) {
    const btn = e.target.closest('[data-pg-action]');
    const id = shownFor, c = id && cards.get(id);
    if (!btn || !c) return;
    const a = btn.dataset.pgAction, d = c.plain && c.plain.decision;
    if (a === 'toggle') { stripOpen.has(id) ? stripOpen.delete(id) : stripOpen.add(id); renderStrip(true); }
    else if (a === 'dismiss-decision') setDismiss(c, { decision: true });
    else if (a === 'mini') setDismiss(c, { strip: true });
    else if (a === 'unmini') setDismiss(c, { strip: false });
    else if (a === 'reply-rec' && d) fillComposer(id, `按推荐：${d.recommendation}`);
    else if (a === 'reply-own') fillComposer(id, d ? `关于「${d.question}」：` : '');
    else if (a === 'open-card') void shell.openPath(c.cardPath);
    else if (a === 'open-folder') shell.showItemInFolder(c.cardPath);
  }

  // ① 「进展」页
  const GROUPS = [{ key: 'overview', title: '\u8fdb\u5c55\u6982\u8ff0', cls: 'ok' }];
  function groupOf(c) { return c.overview ? 'overview' : null; }
  // Older optional overviews are kept below the active list.
  const OLDER_MS = 24 * 3600 * 1000;
  const isOlder = c => !c.running && Date.now() - c.mtimeMs > OLDER_MS;
  let olderOpen = false;
  function build() {
    if (root) return true;
    root = document.getElementById('progress-panel');
    if (!root) return false;
    root.innerHTML = `<header class="pg-head"><h2>\u8fdb\u5c55</h2><p id="pg-subtitle"></p></header><div class="pg-cols" id="pg-cols"></div>`;
    root.addEventListener('toggle', e => { if (e.target.matches && e.target.matches('.pg-older')) olderOpen = e.target.open; }, true);
    root.addEventListener('click', e => {
      const card = e.target.closest('[data-pg-session]');
      if (!card) return;
      const id = card.dataset.pgSession;
      setPanelVisible(false);
      if (typeof selectSession === 'function') void Promise.resolve(selectSession(id, { forceScrollBottom: true })).then(() => renderStrip(true));
    });
    return true;
  }
  function boardCard(c) {
    const overview = c.overview || '';
    return `<div class="pg-card" data-pg-session="${esc(c.sessionId)}" role="button" tabindex="0">
      <div class="pg-ct">${esc(c.title || '\u672a\u547d\u540d\u4f1a\u8bdd')}</div>
      <div class="pg-cl pg-overview-text">${esc(overview)}</div>
      <div class="pg-cm"><span>${esc(c.running ? '\u8fd0\u884c\u4e2d' : '\u5df2\u6682\u505c')}</span><span>${esc(ago(c.mtimeMs))}</span></div></div>`;
  }
  function renderBoard() {
    if (!opened || !build()) return;
    const every = [...cards.values()].filter(c => c.overview).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const older = every.filter(isOlder), all = every.filter(c => !isOlder(c));
    const by = k => all.filter(c => groupOf(c) === k);
    root.querySelector('#pg-subtitle').textContent = all.length
      ? `${all.length} \u4e2a\u4f1a\u8bdd\u4e3b\u52a8\u5199\u4e86\u8fdb\u5c55\u6982\u8ff0${older.length ? ` \u00b7 \u53e6\u6709 ${older.length} \u6761\u8f83\u65e9\u6982\u8ff0\u6536\u5728\u4e0b\u9762` : ''}\u3002\u70b9\u5361\u7247\u56de\u5230\u539f\u4f1a\u8bdd\u3002`
      : older.length ? `\u773c\u4e0b\u6ca1\u6709\u8f83\u65b0\u7684\u8fdb\u5c55\u6982\u8ff0\uff0c${older.length} \u6761\u8f83\u65e9\u6982\u8ff0\u6536\u5728\u4e0b\u9762\u3002` : '\u8fd8\u6ca1\u6709\u4f1a\u8bdd\u4e3b\u52a8\u5199\u8fdb\u5c55\u6982\u8ff0\u3002\u5b83\u662f\u53ef\u9009\u7684\uff0c\u4e0d\u5f71\u54cd\u666e\u901a\u56de\u7b54\u3002';
    root.querySelector('#pg-cols').innerHTML = GROUPS.map(g => {
      const xs = by(g.key);
      return `<section class="pg-col" data-pg-group="${g.key}"><h3><i class="pg-dot pg-${g.cls}"></i>${esc(g.title)} (${xs.length})</h3>${xs.map(boardCard).join('') || '<div class="pg-empty">\u6682\u65e0</div>'}</section>`;
    }).join('') + (older.length ? `<details class="pg-older"${olderOpen ? ' open' : ''}><summary>\u8f83\u65e9\u7684\u8fdb\u5c55\u6982\u8ff0 (${older.length})</summary><div class="pg-older-list">${older.map(boardCard).join('')}</div></details>` : '');
  }
  function setNavCount() {
    const nav = document.getElementById('btn-progress');
    if (!nav) return;
    const n = [...cards.values()].filter(c => c.overview).length;
    let b = nav.querySelector('.pg-nav-count');
    if (!b) { b = document.createElement('b'); b.className = 'pg-nav-count'; nav.appendChild(b); }
    b.textContent = n ? String(n) : ''; b.hidden = !n;
    nav.title = n ? `\u8fdb\u5c55 \u00b7 ${n} \u6761\u4e3b\u52a8\u5199\u4e0b\u7684\u6982\u8ff0` : '\u8fdb\u5c55 \u00b7 \u53ea\u663e\u793a AI \u4e3b\u52a8\u5199\u4e0b\u7684\u8fdb\u5c55\u6982\u8ff0';
  }
  function setPanelVisible(visible) {
    if (!build()) return;
    opened = visible;
    root.style.display = visible ? 'flex' : 'none';
    const nav = document.getElementById('btn-progress');
    nav?.classList.toggle('active', visible);
    if (nav) { if (visible) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current'); }
    if (visible) {
      const home = document.getElementById('btn-home'); home?.classList.remove('active'); home?.removeAttribute('aria-current');
      window.__xresearchHide?.(); window.__studyHide?.(); window.__writingHide?.(); window.__rulesHide?.();
      for (const id of ['terminal-panel', 'meeting-room-panel']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
      void refresh();
      renderBoard();
    }
  }

  function refreshAll() {
    if (typeof scheduleSessionListRender === 'function') scheduleSessionListRender();
    setNavCount(); renderStrip(true); renderBoard();
  }
  function accept(list) {
    const next = new Map();
    for (const c of Array.isArray(list) ? list : []) if (c && typeof c.sessionId === 'string') next.set(c.sessionId, c);
    cards.clear(); for (const [k, v] of next) cards.set(k, v);
    const key = JSON.stringify([...cards.values()].map(c => [c.sessionId, c.mtimeMs, c.group, c.overview, c.title]));
    if (key !== lastKey) { lastKey = key; if (typeof scheduleSessionListRender === 'function') scheduleSessionListRender(); }
    setNavCount(); renderStrip(); renderBoard();
  }
  async function refresh() {
    try { const r = await ipcRenderer.invoke('progress-cards:get'); if (r && r.ok) accept(r.cards); } catch (e) { console.warn('[progress-view] 读取失败：', e && e.message); }
  }

  ipcRenderer.on('progress-cards:changed', (_e, p) => accept(p && p.cards));
  // 其他页面靠这几个名字互相关闭；「开发」页撤掉后，旧名字指向「进展」页，调用方不用逐个改。
  window.__progressHide = () => { if (opened) setPanelVisible(false); };
  window.__progressShow = () => setPanelVisible(true);
  window.__ranHide = window.__progressHide; window.__devBoardHide = window.__progressHide;
  window.__ranShow = window.__progressShow; window.__devBoardShow = window.__progressShow;

  function init() {
    build();
    document.querySelectorAll('#btn-progress,[data-progress-entry]').forEach(b => b.addEventListener('click', () => setPanelVisible(true)));
    void refresh();
    setInterval(() => renderBoard(), 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
