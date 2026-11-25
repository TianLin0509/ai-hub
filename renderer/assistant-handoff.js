'use strict';
// 主页和启动中心最上面各放一个「交给助理」输入框，回车就交给前台并打开助理页；Hub 启动后默认停在助理页。
// 自己开会话的入口原样保留在下面，多一步也能走。
function createAssistantHandoff({ document, ipcRenderer, openAssistantPage, closeLaunchCenter, showMessage }) {
  const HINT = '说一句要做什么，前台能答就答，要动手会自己新开会话去办（Enter 发送）';
  function composer(id, compact) {
    const form = document.createElement('form');
    form.className = 'assistant-handoff' + (compact ? ' compact' : ''); form.id = id;
    form.innerHTML = `<img src="assets/assistant/penguin.png" alt="" aria-hidden="true"><input type="text" autocomplete="off" aria-label="交给助理" placeholder="${HINT}"><button type="submit">交给助理</button>`;
    const input = form.querySelector('input'), button = form.querySelector('button');
    form.addEventListener('submit', async event => {
      event.preventDefault(); const text = input.value.trim(); if (!text || button.disabled) return;
      button.disabled = true;
      try {
        const result = await ipcRenderer.invoke('assistant:ask', { text, to: 'auto' });
        if (result && result.ok === false) throw new Error(result.error || '助理暂未连接');
        input.value = ''; closeLaunchCenter?.(); await openAssistantPage();
      } catch (error) { showMessage?.('没有交给助理：' + error.message); }
      finally { button.disabled = false; }
    });
    return form;
  }
  // 主页：标题改成问句，输入框放在两张「自己开会话」卡片上面。
  const intro = document.querySelector('.home-welcome-intro');
  if (intro && !document.getElementById('home-assistant-handoff')) {
    const title = document.getElementById('home-welcome-title'), eyebrow = intro.querySelector('.home-welcome-eyebrow');
    if (title) title.textContent = '今天交给助理什么？';
    if (eyebrow) eyebrow.textContent = 'ASSISTANT FIRST';
    intro.after(composer('home-assistant-handoff', false));
    const note = document.createElement('p'); note.className = 'assistant-handoff-note'; note.textContent = '要自己开会话或群聊，用下面两个入口：';
    document.getElementById('home-assistant-handoff').after(note);
  }
  // 启动中心：放在标题栏中间（不挤占下面的配置区），打开时光标先落在这里；直接点下面的 AI 和「创建会话」照旧。
  const head = document.querySelector('#new-session-menu .session-create-head'), closeButton = document.getElementById('new-session-close');
  if (head && closeButton && !document.getElementById('launch-assistant-handoff')) head.insertBefore(composer('launch-assistant-handoff', true), closeButton);
  return {
    focusLaunch() { const input = document.querySelector('#launch-assistant-handoff input'); if (input && input.offsetParent) input.focus({ preventScroll: true }); },
  };
}
module.exports = { createAssistantHandoff };
