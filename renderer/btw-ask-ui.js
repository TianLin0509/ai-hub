'use strict';
// Adapted from feat/side-ask-20261101-claude1:renderer/side-ask-ui.js.
// 2026-11-10 外观向 AI HUB-H 的问一下抽屉（renderer/ask-aside-ui.js）和卡片视图看齐：浮起的圆角面板、
// 问题在右侧浅蓝气泡、回答在左侧白底描边气泡并按 markdown 排版、思考中三点加计时、琥珀色失败块、内嵌「提问」的输入框。
// 行为不变：发 /btw、排队、只用按钮发送（Enter 换行）。
const { renderAnswerHtml } = require('./btw-ask-format');

const ICONS = {
  ask: '<path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 21l1.4-4.5A8.5 8.5 0 1 1 20.5 12z"/><path d="M9.9 9.6a2.2 2.2 0 0 1 4.3.7c0 1.5-2.2 1.9-2.2 3.1"/><path d="M12 16.4h.01"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  warn: '<path d="M12 3.5l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const pad2 = n => String(n).padStart(2, '0');
const elapsed = (since, now = Date.now()) => { const s = Math.max(0, Math.floor((now - since) / 1000)); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; };
const clock = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const WAIT = {
  codex: ['正在等 Codex 的简短回答', '通常 10–20 秒，最多 5 分钟 · 主控照常工作'],
  dsh: ['正在等 DSH 的简短回答', '通常几秒，最多 3 分钟 · 主控照常工作'],
  claude: ['正在等主控的简短回答', '通常几秒，最多约 90 秒 · 主控照常工作'],
};
const DEFAULT_HINT = 'Enter 换行 · 点「提问」发送';
const SUGGESTIONS = ['现在卡在哪？', '为什么这么做？', '还要多久？'];

function createBtwAskUi({ document, ipcRenderer, getSession, getTitle = session => session?.title || '' }) {
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'btw-ask-ui.css'; document.head.appendChild(link);
  const button = document.createElement('button'); button.className = 'btn-zoom btw-ask-open'; button.hidden = true;
  button.innerHTML = svg('ask') + '<span>问一下</span>'; button.setAttribute('aria-pressed', 'false');
  document.getElementById('toolbar-actions').appendChild(button);
  const drawer = document.createElement('aside'); drawer.className = 'btw-ask-drawer'; drawer.hidden = true; drawer.setAttribute('aria-label', '问一下');
  drawer.innerHTML = '<header class="btw-ask-head"><span class="btw-ask-ic">' + svg('ask') + '</span>' +
    '<div class="btw-ask-ttl"><h3>问一下</h3><p data-btw-subtitle></p></div>' +
    '<button type="button" class="btw-ask-icon-btn" data-btw-close aria-label="关闭问一下" title="关闭（Esc）">' + svg('x') + '</button></header>' +
    '<div class="btw-ask-body" data-btw-history></div>' +
    '<form class="btw-ask-foot"><div class="btw-ask-in">' +
    '<textarea aria-label="问一下的问题" placeholder="问进展、原因或当前判断…" maxlength="32000" rows="2" required></textarea>' +
    '<div class="btw-ask-row"><span data-btw-message role="status"></span><button type="submit" class="btw-ask-send">提问</button></div>' +
    '</div></form>';
  document.body.appendChild(drawer);
  const history = drawer.querySelector('[data-btw-history]'), message = drawer.querySelector('[data-btw-message]');
  const subtitle = drawer.querySelector('[data-btw-subtitle]'), inputBox = drawer.querySelector('.btw-ask-in');
  const input = drawer.querySelector('textarea'), sendButton = drawer.querySelector('[type=submit]');
  let sessionId = null, requestVersion = 0, sending = false, capabilityVersion = 0, lastSupport = null, blocked = '', stick = true;
  const text = (tag, value, parent, className) => { const el = document.createElement(tag); el.textContent = value; if (className) el.className = className; parent.appendChild(el); return el; };
  const call = async (method, args) => { const r = await ipcRenderer.invoke('btw-ask:' + method, args); if (!r.ok) throw Error(r.error); return r.result; };
  // 底部提示行：有错误或不能问的原因就标琥珀色，否则显示操作提示。
  const setMessage = value => {
    message.textContent = value || blocked || DEFAULT_HINT;
    message.classList.toggle('warn', !!(value || blocked)); message.title = message.textContent;
  };
  // 看到底部时保持贴底；用户往上翻旧问答时不打扰。
  history.addEventListener('scroll', () => { stick = history.scrollHeight - history.scrollTop - history.clientHeight < 40; });
  // 浮在会话区上：上沿对齐会话区，右、下各留 10px，状态栏不被盖住。拿不到会话区时用样式里的默认位置。
  function place() {
    const panel = document.getElementById('terminal-panel'), win = document.defaultView;
    if (!panel || !win) return;
    const r = panel.getBoundingClientRect(); if (!r.width || !r.height) return;
    drawer.style.setProperty('--btw-top', `${Math.round(r.top + 8)}px`);
    drawer.style.setProperty('--btw-right', `${Math.round(win.innerWidth - r.right + 10)}px`);
    drawer.style.setProperty('--btw-bottom', `${Math.round(win.innerHeight - r.bottom + 10)}px`);
  }
  function waitBlock(row, { thinking, title, small, since }) {
    const box = document.createElement('div'); box.className = 'btw-ask-answer btw-ask-wait' + (thinking ? ' is-thinking' : ''); row.appendChild(box);
    if (thinking) { const dots = document.createElement('span'); dots.className = 'btw-ask-dots'; dots.innerHTML = '<i></i><i></i><i></i>'; box.appendChild(dots); }
    const t = text('div', title, box, 't'); text('small', small, t);
    if (since) { const time = text('time', elapsed(since), box); time.dataset.waitSince = String(since); }
  }
  function paint(data) {
    history.replaceChildren();
    const session = getSession();
    subtitle.textContent = (session && session.id === sessionId && getTitle(session)) || '当前会话';
    subtitle.title = subtitle.textContent;
    let position = 0;
    for (const item of data.items) {
      const row = document.createElement('article'); row.className = 'btw-ask-qa'; row.dataset.status = item.status; history.appendChild(row);
      const q = document.createElement('div'); q.className = 'btw-ask-q'; row.appendChild(q); text('p', item.q, q, 'btw-ask-question');
      const codex = item.engine === 'codex';
      if (item.status === 'queued') {
        position++;
        waitBlock(row, { thinking: false, title: position > 1 ? `正在排队，前面还有 ${position - 1} 个问题` : '正在排队，马上开始', small: '前面的提问结束后自动开始' });
        continue;
      }
      if (item.status === 'running' && !item.a) {
        position++;
        const [title, small] = WAIT[codex ? 'codex' : item.engine === 'dsh' ? 'dsh' : 'claude'];
        waitBlock(row, { thinking: true, title, small, since: Date.parse(item.at) || Date.now() });
        continue;
      }
      if (item.a) {
        const answer = document.createElement('div'); answer.className = 'btw-ask-answer btw-ask-md'; row.appendChild(answer);
        try { answer.innerHTML = renderAnswerHtml(item.a, { engine: item.engine }); } catch { answer.textContent = item.a; answer.classList.add('is-plain'); }
      }
      if (item.error) {
        const err = document.createElement('div'); err.className = 'btw-ask-error'; err.innerHTML = svg('warn'); row.appendChild(err);
        text('div', item.a ? item.error : `没问成：${item.error}`, err, 't');
      } else if (!item.a) text('div', '暂无回答', row, 'btw-ask-answer btw-ask-empty');
      if (item.a) {
        const bits = [`用时 ${item.wall_s} 秒`, clock(item.at), codex ? 'Codex 临时分叉作答（低推理档、标准速度）' : '复用主控缓存', '未进入主控对话'];
        text('p', bits.filter(Boolean).join(' · '), row, 'btw-ask-meta');
      }
      if (item.truncated) text('p', codex ? '答案较长，只保留了前 2 万字' : '答案较长被截断，可到后台终端滚动查看', row, 'btw-ask-meta');
    }
    if (!data.items.length) {
      const intro = document.createElement('div'); intro.className = 'btw-ask-intro'; history.appendChild(intro);
      text('p', '随时问主控一句，主控继续工作。回答基于这个会话到现在的上下文，问答只留在这里，不进入主控对话。', intro, 'btw-ask-note');
      const chips = document.createElement('div'); chips.className = 'btw-ask-chips'; chips.dataset.btwSuggestions = ''; intro.appendChild(chips);
      for (const question of SUGGESTIONS) {
        const chip = text('button', question, chips, 'btw-ask-chip'); chip.type = 'button';
        chip.onclick = () => { input.value = question; input.focus(); };
      }
    }
    if (stick) history.scrollTop = history.scrollHeight;
    blocked = data.supported === false ? (data.reason || '这个会话暂时不能问') : '';
    sendButton.disabled = sending || data.supported === false;
    if (!message.classList.contains('warn') || blocked) setMessage('');
  }
  async function refresh() {
    const id = sessionId, version = ++requestVersion;
    const data = await call('list', { sessionId: id });
    if (id === sessionId && version === requestVersion) paint(data);
  }
  async function send() {
    if (sending) return;
    const question = input.value.trim(); if (!question) return;
    sending = true; sendButton.disabled = true; setMessage('');
    const id = sessionId;
    try {
      await call('ask', { sessionId: id, question });
      if (id !== sessionId) return;
      input.value = ''; stick = true; await refresh();
    } catch (e) { if (id === sessionId) setMessage(e.message); }
    finally { sending = false; sendButton.disabled = !!blocked; }
  }
  setInterval(() => {
    if (drawer.hidden) return;
    for (const el of history.querySelectorAll('[data-wait-since]')) el.textContent = elapsed(Number(el.dataset.waitSince));
  }, 1000);
  function open() {
    const session = getSession(); if (!session || button.disabled) return;
    if (sessionId !== session.id) { sessionId = session.id; input.value = ''; history.replaceChildren(); stick = true; }
    place();
    drawer.hidden = false; button.classList.add('on'); button.setAttribute('aria-pressed', 'true'); setMessage('');
    refresh().then(() => input.focus()).catch(e => setMessage(e.message));
  }
  function hide() { drawer.hidden = true; button.classList.remove('on'); button.setAttribute('aria-pressed', 'false'); }
  button.onclick = () => (drawer.hidden ? open() : hide());
  drawer.querySelector('form').onsubmit = event => { event.preventDefault(); void send(); };
  drawer.querySelector('[data-btw-close]').onclick = hide;
  drawer.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); hide(); } });
  input.addEventListener('focus', () => inputBox.classList.add('is-focus'));
  input.addEventListener('blur', () => inputBox.classList.remove('is-focus'));
  document.defaultView?.addEventListener?.('resize', () => { if (!drawer.hidden) place(); });
  ipcRenderer.on('btw-ask:changed', (_event, data) => {
    if (data.sessionId !== sessionId) return;
    requestVersion++; // A newer push wins over an older list request.
    if (!drawer.hidden) paint(data);
  });
  return { sync(visible) {
    const session = getSession(); button.hidden = !visible || !session;
    if (visible && !button.isConnected) document.getElementById('toolbar-actions').appendChild(button);
    if (sessionId && session?.id !== sessionId) hide();
    if (!session || !visible) return;
    const version = ++capabilityVersion;
    const codex = /^codex(?:-resume)?$/.test(session.kind || ''), dsh = /^deepseek-acp(?:-resume)?$/.test(session.kind || '');
    const readyTitle = codex ? '在 Codex 临时分叉里只读作答，问答不进入主控对话'
      : dsh ? '使用 DSH 自带的 /btw 旁问，问答不进入主控对话' : '使用 Claude /btw，问答不进入主控对话';
    const unsupported = !(codex || dsh || /^claude(?:-resume)?$/.test(session.kind || '')) || session.agentRuntime !== 'pty' || !!session.runtimeBackend;
    // 工具栏每次重绘都会重新核对；同一会话先沿用上次结果，免得按钮在核对期间闪灰、吞掉点击。
    if (unsupported) { button.disabled = true; button.title = '问一下支持 Claude、Codex 和 DSH 终端会话，原生后端和其他 CLI 暂不支持'; }
    else if (lastSupport?.id === session.id) { button.disabled = !lastSupport.supported; button.title = lastSupport.title; }
    else { button.disabled = false; button.title = readyTitle; }
    void call('support', { sessionId: session.id }).then(result => {
      if (version !== capabilityVersion || getSession()?.id !== session.id) return;
      lastSupport = { id: session.id, supported: !!result.supported, title: result.reason || readyTitle };
      button.disabled = !result.supported; button.title = lastSupport.title;
    }).catch(error => { if (version === capabilityVersion) { button.disabled = true; button.title = error.message; } });
  } };
}

function mountBtwAskUi(win = typeof window !== 'undefined' ? window : null) {
  if (!win || win.__btwAskUi) return win && win.__btwAskUi;
  const doc = win.document, area = doc && doc.getElementById && doc.getElementById('toolbar-actions');
  if (!area || typeof win.MutationObserver !== 'function') return null;
  if (!require('../core/distribution').featureEnabled('btwAsk')) return null;
  /* global sessions, sessionSplit, activeSessionId, currentAppToolbarView */
  const current = () => { try { return sessions.get((typeof sessionSplit !== 'undefined' && sessionSplit?.focusedId()) || activeSessionId) || null; } catch { return null; } };
  const visible = () => { try { return !!activeSessionId && !(typeof currentAppToolbarView === 'function' && currentAppToolbarView()); } catch { return false; } };
  const { sessionDisplayTitle } = require('../core/session-title-guards.js');
  const ui = createBtwAskUi({ document: doc, ipcRenderer: require('electron').ipcRenderer, getSession: current,
    getTitle: session => { try { return sessionDisplayTitle(session); } catch { return session?.title || ''; } } });
  let queued = false;
  new win.MutationObserver(() => {
    if (queued) return; queued = true;
    win.requestAnimationFrame(() => { queued = false; ui.sync(visible()); });
  }).observe(area, { childList: true });
  // Codex 要等首轮绑定原生记录后才能问；能否提问随会话状态变化，不只随工具栏重绘。
  let lastKey = '';
  require('electron').ipcRenderer.on('session-updated', (_event, payload) => {
    const session = payload && payload.session, focused = current();
    if (!session || !focused || session.id !== focused.id) return;
    const key = [session.id, session.kind, session.codexSid, session.agentRuntime, session.runtimeBackend].join('|');
    if (key === lastKey) return;
    lastKey = key; ui.sync(visible());
  });
  ui.sync(visible()); win.__btwAskUi = ui; return ui;
}
module.exports = { createBtwAskUi, mountBtwAskUi };
