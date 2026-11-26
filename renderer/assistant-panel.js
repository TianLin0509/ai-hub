'use strict';

// An entry into the ordinary session surface. No composer, transcript reader,
// model controls or terminal writer is owned by the assistant navigation.
function createAssistantPanel({ document, ipcRenderer, getSession, getActiveSessionId, listSessions = () => [],
  openSession, closeOtherPanels = () => {}, showMessage }) {
  // 记忆、手机连接、新开助理）、通知和「打开前台」；旧入口按钮不存在时用一个不挂到页面上的占位，省得处处判空。
  const nav = document.getElementById('btn-assistant') || Object.assign(document.createElement('button'), { innerHTML: '<span class="btn-label">助理</span>' });
  let epoch = 0, opening = null, overview = null, sequence = 0, switching = false;
  const resumeBar = require('./assistant-resume-card').mountResumeBar({ document, ipcRenderer, showMessage,
    openSession: async id => { closeOtherPanels(); await openSession(id); } });
  void resumeBar.load();
  // 背后的通知照旧：交卷与请拍板仍记进前台对话记录、推到手机，请拍板仍计入概览「待你定」红点；只是不再挂顶部浮条。
  // 模块保留（单测与以后想恢复时用）。
  const setClass = (element, name, value) => { if (element.classList.contains(name) !== value) element.classList.toggle(name, value); };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isOpen = () => document.body.classList.contains('assistant-session-active')
    && getSession(getActiveSessionId())?.purpose === 'hub-assistant';
  async function call(channel, args) {
    const result = await ipcRenderer.invoke(channel, args);
    if (!result || result.ok === false) throw new Error(result?.error || '助理暂未连接');
    return result;
  }
  function badge() {
    nav.classList.toggle('assistant-has-unread', !!overview?.unreadCount);
    nav.title = overview?.unreadCount ? `助理 · ${overview.unreadCount} 条关注任务新回复` : '助理 · 进展与下一步';
  }
  function paintNotices() {
    const host = document.querySelector('.assistant-notifications');
    if (!host) return;
    const summary = host.querySelector('summary');
    if (summary) summary.textContent = overview?.unreadCount ? `新回复 ${overview.unreadCount}` : '关注回复';
    host.querySelector('.assistant-notice-list').innerHTML = (overview?.notifications || []).map(n =>
      `<article><strong>${esc(n.title)}</strong><p>${esc(n.text)}</p><small>${esc(n.source?.ref)}</small>${n.readAt ? '' : `<button type="button" data-assistant-read="${esc(n.id)}">标为已读</button>`}</article>`).join('') || '<p>明确说“有新回复时提醒我”，助理会关注对应任务。</p>';
  }
  async function refresh() {
    const ticket = ++sequence;
    try {
      const result = await call('assistant:get-overview');
      if (ticket !== sequence) return;
      overview = result; badge(); paintNotices();
    } catch (error) { if (isOpen()) showMessage?.(`助理动态暂未同步：${error.message}`); }
  }
  function syncSession(session) {
    const active = session?.purpose === 'hub-assistant';
    setClass(document.body, 'assistant-session-active', active);
    setClass(document.getElementById('terminal-panel'), 'assistant-session', active);
    // 助理页开着时「助理」保持选中（后台预热助理会话会触发这里）。
    const selected = active;
    setClass(nav, 'active', selected);
    if (selected) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
    // 换成「当前概览」一个按钮（待我决策 + 任务进展弹窗，renderer/assistant-overview.js）和「⋯」，低频功能都收进「⋯」，一项不丢。
    const tools = document.getElementById('toolbar-actions');
    if (!tools) return;
    if (!active) { tools.querySelectorAll(':scope > .assistant-overview-btn, :scope > .assistant-more').forEach(el => el.remove()); document.querySelector('.assistant-more-menu')?.remove(); return; }
    const more = tools.querySelector('.assistant-more');
    if (more) { more.dataset.kind = session.kind; more.disabled = switching; return; }
    const ov = document.createElement('button'); ov.type = 'button'; ov.className = 'btn-zoom assistant-overview-btn';
    ov.innerHTML = '当前概览<span class="ov-badge" hidden></span><span class="ov-badge ov-badge-stall" hidden></span>'; ov.title = '待我决策：真要你拍板的事，可以直接回复；任务进展：各任务一句话进展；续跑：疑似停住的会话';
    overviewModal().registerBadge(ov.querySelector('.ov-badge:not(.ov-badge-stall)'));
    overviewModal().registerStallBadge?.(ov.querySelector('.ov-badge-stall'));
    ov.addEventListener('click', () => { void overviewModal().open(); });
    const dots = document.createElement('button'); dots.type = 'button'; dots.className = 'btn-zoom assistant-more'; dots.textContent = '⋯';
    dots.title = '前台的低频功能：切换后端、关注回复记录、工作档案、助理记忆、手机连接、新开助理'; dots.dataset.kind = session.kind;
    dots.addEventListener('click', event => { event.stopPropagation(); toggleMore(dots); });
    tools.prepend(ov, dots);
    void overviewModal().load().catch(() => {});
  }
  function overviewModal() {
    return require('./assistant-overview').getAssistantOverview({ document, window, ipcRenderer, showMessage,
      openSession: async id => { if (window.__hubOpenSession) return window.__hubOpenSession(id); closeOtherPanels(); return openSession(id); } });
  }
  function toggleMore(anchor) {
    const old = document.querySelector('.assistant-more-menu'); if (old) { old.remove(); return; }
    const { SELECTABLE_BACKENDS: BACKENDS, getKindLabel } = require('../core/hub-assistant/backends');
    const kind = anchor.dataset.kind, label = require('../core/ai-kinds').getKindLabel(kind);
    const menu = document.createElement('div'); menu.className = 'assistant-more-menu assistant-backend-menu'; menu.setAttribute('role', 'menu');
    const unread = overview?.unreadCount || 0;
    menu.innerHTML = `<button type="button" data-assistant-more="notices">关注回复记录${unread ? `（${unread} 条未读）` : ''}<small>你说过「有新回复时提醒我」的任务</small></button><div class="assistant-notifications" hidden><div class="assistant-notice-list"></div></div>`
      + '<button type="button" data-assistant-more="workbench">工作档案<small>助理的 Markdown 工作档案</small></button>'
      + '<button type="button" data-assistant-more="memory">助理记忆<small>助理积累的偏好（USER.md），可直接编辑</small></button>'
      + '<button type="button" data-assistant-more="rotate">新开助理<small>写好交接后换一个新会话，旧会话保留</small></button>'
      + `<hr><small style="padding:2px 10px">前台后端（当前 ${esc(label)}）</small>`
      + BACKENDS.map(k => `<button type="button" data-assistant-backend="${esc(k)}"${k === kind ? ' aria-current="true"' : ''}>${k === kind ? '✓ ' : ''}${esc(getKindLabel(k))}</button>`).join('');
    const rect = anchor.getBoundingClientRect();
    menu.style.top = rect.bottom + 6 + 'px'; menu.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
    menu.addEventListener('click', event => {
      event.stopPropagation();
      const b = event.target.closest('[data-assistant-backend]');
      if (b) { menu.remove(); if (b.dataset.assistantBackend !== kind) void switchBackend(b.dataset.assistantBackend); return; }
      const read = event.target.closest('[data-assistant-read]');
      if (read) { void call('assistant:mark-notification-read', { id: read.dataset.assistantRead }).then(refresh).catch(error => showMessage?.(error.message)); return; }
      const m = event.target.closest('[data-assistant-more]')?.dataset.assistantMore;
      if (!m) return;
      if (m === 'notices') { const box = menu.querySelector('.assistant-notifications'); box.hidden = !box.hidden; if (!box.hidden) { paintNotices(); void refresh(); } return; }
      menu.remove();
      if (m === 'workbench') void call('assistant:open-workbench').catch(error => showMessage?.(error.message));
      else if (m === 'memory') void call('assistant:open-memory').catch(error => showMessage?.(error.message));
      else if (m === 'rotate') void rotateNow();
    });
    document.body.append(menu);
    menu.querySelector('button')?.focus();
  }
  // 手动换班：让当前助理写交接，再换一个干净的新会话（平时由 Hub 在你空闲时自动进行）。
  async function rotateNow() {
    if (!window.confirm('让前台写好交接后换一个新会话？旧会话保留为「已换班」，可以随时回看。')) return;
    showMessage?.('前台交接中…');
    try { const r = await call('assistant:rotate-now'); if (r && r.ok === false) throw new Error(r.error || '未能新开'); showMessage?.('已换成新的助理会话，旧会话保留为「已换班」。'); }
    catch (error) { showMessage?.(`新开助理未完成：${error.message}`); }
  }
  function close() {
    epoch++; document.querySelector('.assistant-backend-menu')?.remove();
    setClass(document.body, 'assistant-session-active', false);
    setClass(document.getElementById('terminal-panel'), 'assistant-session', false);
    setClass(nav, 'active', false); nav.removeAttribute('aria-current');
  }
  async function switchBackend(kind) {
    if (opening || switching) return;
    const ticket = ++epoch;
    switching = true;
    const picker = document.querySelector('.assistant-more');
    if (picker) { picker.disabled = true; picker.setAttribute('aria-busy','true'); }
    const label = nav.querySelector('.btn-label'); label.textContent = '切换中…';
    try {
      const result = await call('assistant:switch-backend', {kind});
      if (ticket !== epoch) return;
      closeOtherPanels(); await openSession(result.sessionId, result.session); await refresh();
    } catch (error) { showMessage?.(`助理后端未切换：${error.message}`); }
    finally {
      switching = false; label.textContent = '助理';
      if (picker) picker.removeAttribute('aria-busy');
      const displayed = document.querySelector('.assistant-more');
      if (displayed) { displayed.disabled=false; displayed.removeAttribute('aria-busy'); }
      // Native selectSession also advances the navigation epoch. Refresh only
      // when the assistant surface is still visible, using the new toolbar.
      if (isOpen()) syncSession(getSession(getActiveSessionId()));
    }
  }
  async function open() {
    if (switching) return;
    if (opening) return opening;
    const ticket = ++epoch;
    nav.disabled = true; nav.setAttribute('aria-busy', 'true');
    const label = nav.querySelector('.btn-label'); label.textContent = '连接中…';
    opening = (async () => {
      try {
        const result = await call('assistant:ensure-session');
        if (ticket !== epoch) return;
        closeOtherPanels();
        await openSession(result.sessionId, result.session);
        void refresh();
      } catch (error) { if (ticket === epoch) showMessage?.(`助理尚未打开：${error.message}`); }
      finally { nav.disabled = false; nav.removeAttribute('aria-busy'); label.textContent = '助理'; opening = null; }
    })();
    return opening;
  }
  document.addEventListener('click', event => { if(!event.target.closest('.assistant-backend-menu,.assistant-more'))document.querySelector('.assistant-backend-menu')?.remove();if (event.target.closest('#scene-rail button:not(#btn-assistant)')) close(); });
  document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelector('.assistant-backend-menu')?.remove();});
  // 助理换班后（上下文用满后新开会话接续），若正停在助理页就切到新会话。
  ipcRenderer.on('assistant:rotated', () => { if (isOpen()) void open(); else void refresh(); });
  ipcRenderer.on('assistant:notification', (_event, notice) => {
    // 会话进展来得勤：助理页开着时那一行就在眼前，不再点亮红点；页关着才亮，提示去看。
    if (notice?.kind === 'session-progress') { if (!isOpen()) { nav.classList.add('assistant-has-unread'); nav.title = '助理 · 有会话停下来了，进展在助理对话里'; } }
    else { nav.classList.add('assistant-has-unread'); nav.title = '助理 · 关注任务有新回复'; }
    if (notice?.kind === 'reminder') showMessage?.(notice.text);
    // 重启后续跑：窗口顶部出提示条，「全部继续」一键给被打断的会话各发一句继续（assistant-resume-card.js）。
    else if (notice?.kind === 'restart-resume') { if (!resumeBar.current()) void resumeBar.load(); }
    // 自动续跑：卡片随助理对话记录推到顶部提示条（assistant-resume-card.js），不再弹一句提示。
    else if (notice?.kind === 'auto-resume') { if (!resumeBar.current()) void resumeBar.load(); }
    // 会话进展：那一行已经在助理对话里，会话答完时 Hub 另有完成通知，这里不再弹提示条。
    else if (notice?.kind === 'session-progress') {}
    else if (notice?.kind === 'lead-handoff' || notice?.kind === 'lead-decide') {}
    else if (notice?.text) showMessage?.(`${notice.title || '关注任务'}有新回复，可在前台查看。`);
    if (isOpen()) void refresh();
    // 负责人请拍板 / 交卷：当前概览的红点和弹窗跟着刷新。
    if (notice?.kind === 'lead-decide' || notice?.kind === 'lead-handoff') void overviewModal().refresh().catch(() => {});
  });
  return { open, close, refresh, syncSession, isOpen, switchBackend, openPage: open, isPageOpen: isOpen };
}
module.exports = { createAssistantPanel };
