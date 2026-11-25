'use strict';
// 按会话记住关掉的那些；用一张生成的样式表按 data-session-id 生效，分屏和重新渲染的卡片都不用单独处理。
const STORAGE_KEY = 'hub.conciseView.offSessions.v1';

function createConciseView({ document, storage, getSession }) {
  let off;
  try { off = new Set(JSON.parse(storage.getItem(STORAGE_KEY) || '[]')); } catch { off = new Set(); }
  const style = document.createElement('style'); style.id = 'concise-view-rules'; document.head.appendChild(style);
  const button = document.createElement('button');
  button.className = 'btn-zoom concise-toggle'; button.textContent = '简洁'; button.hidden = true;
  button.title = '打开时只看你和 Agent 的对话，隐藏 Agent 之间的消息';
  const quote = id => String(id).replace(/["\\]/g, '\\$&');
  function paint() {
    const except = [...off].map(id => `:not([data-session-id="${quote(id)}"])`).join('');
    style.textContent = `.turn-card.team-notice:not(.relay-notice)${except},.turn-card.no-update${except}{display:none}`
      + '.concise-toggle{white-space:nowrap;flex:none}.concise-toggle[aria-pressed="true"]{color:var(--accent,#3478f6);border-color:var(--accent,#3478f6)}';
  }
  function sync(visible, area) {
    const session = getSession();
    button.hidden = !visible || !session;
    if (session) button.setAttribute('aria-pressed', String(!off.has(session.id)));
    const anchor = area.querySelector('.btw-ask-open');
    if (anchor) { if (anchor.nextSibling !== button) anchor.after(button); }
    else if (!button.isConnected) area.appendChild(button);
  }
  button.onclick = () => {
    const session = getSession(); if (!session) return;
    if (off.has(session.id)) off.delete(session.id); else off.add(session.id);
    storage.setItem(STORAGE_KEY, JSON.stringify([...off]));
    button.setAttribute('aria-pressed', String(!off.has(session.id)));
    paint();
    // 可见的卡片变了，相邻同类消息的分组要重算（renderer/notice-groups.js 监听）。
    try { document.dispatchEvent(new (document.defaultView?.CustomEvent || CustomEvent)('hub:concise-changed')); } catch {}
  };
  paint();
  return { sync, button };
}

function mountConciseView(win = typeof window !== 'undefined' ? window : null) {
  if (!win || win.__conciseView) return win && win.__conciseView;
  const area = win.document?.getElementById?.('toolbar-actions');
  if (!area || typeof win.MutationObserver !== 'function') return null;
  /* global sessions, sessionSplit, activeSessionId, currentAppToolbarView */
  const current = () => { try { return sessions.get((typeof sessionSplit !== 'undefined' && sessionSplit?.focusedId()) || activeSessionId) || null; } catch { return null; } };
  const visible = () => { try { return !!activeSessionId && !(typeof currentAppToolbarView === 'function' && currentAppToolbarView()); } catch { return false; } };
  const ui = createConciseView({ document: win.document, storage: win.localStorage, getSession: current });
  let queued = false;
  new win.MutationObserver(() => {
    if (queued) return; queued = true;
    win.requestAnimationFrame(() => { queued = false; ui.sync(visible(), area); });
  }).observe(area, { childList: true });
  ui.sync(visible(), area); win.__conciseView = ui; return ui;
}
module.exports = { createConciseView, mountConciseView, STORAGE_KEY };
