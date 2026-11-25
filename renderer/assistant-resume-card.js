'use strict';
// Hub 重启后一键续跑的提示条（数据见 core/hub-assistant/restart-resume.js）。
// 助理页不再画对话流（style-31 返工），卡片改成窗口顶部居中的一条提示条，哪个页面都看得到：
// 还没处理时「全部继续 / 不用了」两个按钮；发送中显示进度；发完写明给谁发了、谁没发出去和原因，点 × 收起。会话名点了打开那个会话。
const CARD = 'restart-resume';
// 自动续跑卡（core/hub-assistant/auto-resume-card.js）同用这条提示条：一次重启一张，写明每个会话已续 / 需核对 / 未续及原因。
const AUTO = 'auto-resume';
const AUTO_LABEL = { resumed: '已续', uncertain: '需核对', skipped: '未续', failed: '未续', retrying: '重试中' };
const AUTO_SHOW_MS = 12 * 3600_000;

// 提示条用（「当前概览」的「续跑」Tab 在 assistant-overview.js 里自己画）。
function autoResumeRowHtml(card, r, { esc, time }) {
  const btn = r.canResume ? `<button type="button" class="ap-auto-go" data-auto-resume="${esc(card.id)}" data-auto-sid="${esc(r.id)}" title="给这个会话发一次续跑语">续跑</button>` : '';
  return `<p class="ap-auto-row" data-action="${esc(r.action)}"><span class="ap-auto-tag">${esc(AUTO_LABEL[r.action] || r.action)}</span>`
    + `<button type="button" class="ap-resume-open" data-resume-open="${esc(r.id)}" title="打开这个会话">${esc(r.title)}</button>`
    + `${r.action === 'resumed' ? '' : `<span class="ap-auto-why" title="${esc(r.reason)}">：${esc(r.reason)}</span>`}${btn}<span class="ap-auto-time">${esc(time(r.at))}</span></p>`;
}

function autoResumeHtml(card, { esc, time }) {
  const rows = card.rows || [];
  const count = k => rows.filter(r => (r.action === 'failed' ? 'skipped' : r.action) === k).length;
  const head = card.trigger === 'hub-restart'
    ? `Hub 重启后自动续跑：检查了 ${rows.length} 个会话，已续 ${count('resumed')}、需核对 ${count('uncertain')}、未续 ${count('skipped')}${count('retrying') ? `、重试中 ${count('retrying')}` : ''}`
    : card.trigger === 'patrol' ? '巡逻提醒后续跑' : 'CLI 进程重开后自动续跑';
  const shown = rows.slice(0, 6);
  const line = r => autoResumeRowHtml(card, r, { esc, time });
  const more = rows.length > shown.length ? `<p class="ap-auto-more">还有 ${rows.length - shown.length} 个会话，在「当前概览」的「续跑」Tab 看全部</p>` : '';
  return `<div class="ap-resume ap-auto" data-resume-card="${esc(card.id)}" data-card="${AUTO}" data-state="${esc(card.state)}">`
    + `<div class="ap-resume-body"><p class="ap-resume-text"><strong>${esc(head)}</strong></p>${shown.map(line).join('')}${more}</div>`
    + `<div class="ap-resume-acts"><button type="button" class="ap-resume-x" data-auto-close="${esc(card.id)}" aria-label="收起">×</button></div></div>`;
}

function resumeCardHtml(card, { esc, time }) {
  if (card.card === AUTO) return autoResumeHtml(card, { esc, time });
  const sessions = card.sessions || [], results = card.results || [], when = esc(time(card.restartAt));
  const link = row => `<button type="button" class="ap-resume-open" data-resume-open="${esc(row.id)}" title="打开这个会话">${esc(row.title)}</button>`;
  const links = rows => rows.map(link).join('、');
  let body, acts;
  if (card.state === 'resumed') {
    const sent = results.filter(r => r.ok), failed = results.filter(r => !r.ok);
    body = `<p class="ap-resume-text">${sent.length ? `已给 ${sent.length} 个会话发了继续：${links(sent)}` : '继续没有发出去'}</p>`
      + failed.map(r => `<p class="ap-resume-fail">${link(r)} 没发出去：${esc(r.message)}</p>`).join('');
    acts = `<button type="button" class="ap-resume-x" data-resume-close aria-label="收起">×</button>`;
  } else if (card.state === 'resuming') {
    body = `<p class="ap-resume-text">正在给 ${sessions.length} 个会话发继续（${results.length}/${sessions.length}）：${links(sessions)}</p>`;
    acts = `<button type="button" class="primary" disabled>正在发…</button>`;
  } else {
    body = `<p class="ap-resume-text">Hub ${when} 重启，打断了 ${sessions.length} 个正在干活的会话：${links(sessions)}</p>`;
    acts = `<button type="button" class="primary" data-resume-act="resume" data-resume-id="${esc(card.id)}">全部继续</button>`
      + `<button type="button" data-resume-act="dismiss" data-resume-id="${esc(card.id)}">不用了</button>`;
  }
  return `<div class="ap-resume" data-resume-card="${esc(card.id)}" data-state="${esc(card.state)}"><div class="ap-resume-body">${body}</div><div class="ap-resume-acts">${acts}</div></div>`;
}

// 提示条：启动时从助理对话记录找还没处理的卡（通知可能在界面加载前就发了）；之后跟着主进程推来的卡片状态走。
function mountResumeBar({ document, ipcRenderer, openSession = async () => {}, showMessage }) {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = at => new Date(at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
  let card = null, bar = null, closed = new Set();
  function paint() {
    const show = card && card.state !== 'dismissed' && !closed.has(card.id);
    if (!show) { bar?.remove(); bar = null; return; }
    if (!bar) { bar = document.createElement('div'); bar.className = 'ap-resume-bar'; bar.setAttribute('role', 'status'); bar.addEventListener('click', onClick); document.body.append(bar); }
    bar.innerHTML = resumeCardHtml(card, { esc, time });
  }
  // 同一张卡后到的状态覆盖先到的；换了一张新卡（又重启了一次）就显示新的。
  function take(entry) {
    if (!entry || (entry.card !== CARD && entry.card !== AUTO)) return;
    // 收起过的自动续跑卡又来了新结果（同一次重启后面的会话续上了）：重新显示。
    if (entry.card === AUTO && entry.state !== 'dismissed') closed.delete(entry.id);
    if (card && card.id === entry.id && card.state === 'resumed' && entry.state !== 'resumed') return;
    card = entry; paint();
  }
  async function onClick(event) {
    const jump = event.target.closest('[data-resume-open]');
    if (jump) { try { await openSession(jump.dataset.resumeOpen); } catch (e) { showMessage?.(e.message); } return; }
    if (event.target.closest('[data-resume-close]')) { closed.add(card?.id); paint(); return; }
    const go = event.target.closest('[data-auto-resume]');
    if (go) {
      go.disabled = true;
      try {
        const r = await ipcRenderer.invoke('assistant:auto-resume', { id: go.dataset.autoResume, action: 'resume', sessionId: go.dataset.autoSid });
        if (r?.ok === false && r.error) throw new Error(r.error);
        if (r?.card) { card = r.card; paint(); }
      } catch (error) { showMessage?.('续跑没办成：' + error.message); go.disabled = false; }
      return;
    }
    const autoClose = event.target.closest('[data-auto-close]');
    if (autoClose) {
      closed.add(card?.id); paint();
      try { await ipcRenderer.invoke('assistant:auto-resume', { id: autoClose.dataset.autoClose, action: 'dismiss' }); } catch {}
      return;
    }
    const b = event.target.closest('[data-resume-act]');
    if (!b) return;
    for (const x of bar.querySelectorAll('[data-resume-act]')) x.disabled = true;
    try {
      const r = await ipcRenderer.invoke('assistant:restart-resume', { id: b.dataset.resumeId, action: b.dataset.resumeAct });
      if (r?.ok === false) throw new Error(r.error || '没办成');
      if (r?.card) { card = r.card; paint(); }
    } catch (error) { showMessage?.('续跑没办成：' + error.message); paint(); }
  }
  async function load() {
    try {
      const r = await ipcRenderer.invoke('assistant:dialog-log', { limit: 300 });
      const now = Date.now();
      const cards = (r?.entries || []).filter(e => (e.card === CARD && (e.state === 'pending' || e.state === 'resuming'))
        || (e.card === AUTO && e.state !== 'dismissed' && now - (e.updatedAt || e.at || 0) < AUTO_SHOW_MS));
      if (cards.length) take(cards[cards.length - 1]);
    } catch {}
  }
  ipcRenderer.on('assistant:dialog', (_e, entry) => take(entry));
  return { load, take, current: () => card };
}

module.exports = { resumeCardHtml, autoResumeHtml, autoResumeRowHtml, mountResumeBar, AUTO_LABEL };
