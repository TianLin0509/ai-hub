'use strict';
// 数据：主进程通知 kind=lead-handoff / lead-decide，带 jump（会话号）、brief（两行）、code（Dn）。
const KINDS = new Set(['lead-handoff', 'lead-decide']);
const SHOW = 3;
const MAX_AGE_MS = 24 * 3600_000;
const STORE_KEY = 'ap-brief-dismissed';

function briefCardHtml(item, { esc, time }) {
  const decide = item.kind === 'lead-decide';
  const tag = decide ? `请拍板${item.code ? ' ' + esc(item.code) : ''}` : '交卷';
  const [a = '', b0 = ''] = item.brief || [];
  const b = decide ? b0 : '';
  return `<div class="ap-brief" data-brief-id="${esc(item.id)}" data-kind="${esc(item.kind)}">`
    + `<div class="ap-brief-body"><p class="ap-brief-head"><span class="ap-brief-tag">${tag}</span><span class="ap-brief-title">${esc(item.title)}</span><span class="ap-brief-time">${esc(time(item.at))}</span></p>`
    + `<p class="ap-brief-line" title="${esc(a)}">${esc(a)}</p>${b ? `<p class="ap-brief-line sub" title="${esc(b)}">${esc(b)}</p>` : ''}</div>`
    + `<div class="ap-brief-acts"><button type="button" class="primary" data-brief-open="${esc(item.jump)}">打开会话</button>`
    + `<button type="button" class="ap-brief-x" data-brief-close="${esc(item.id)}" aria-label="收起" title="收起">×</button></div></div>`;
}

// 通知或对话记录 → 简述条目；不是简述卡返回 null。
function toItem(x) {
  if (!x || !KINDS.has(x.kind) || !x.jump) return null;
  const brief = Array.isArray(x.brief) && x.brief.length ? x.brief : String(x.text || '').split('\n').slice(0, 2);
  return { id: String(x.id || '').replace(/^notice:/, ''), kind: x.kind, jump: x.jump, code: x.code || null, title: x.title || x.by || '负责人', brief, at: Number(x.at || x.createdAt) || Date.now() };
}

function mountBriefBar({ document, window, ipcRenderer, openSession = async () => {}, getActiveSessionId = () => null, showMessage }) {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = at => new Date(at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
  let items = [], bar = null, expanded = false;
  let dismissed = [];
  try { dismissed = JSON.parse(window.localStorage.getItem(STORE_KEY) || '[]'); } catch {}
  const isDismissed = id => dismissed.includes(id);
  function dismiss(ids) {
    dismissed = dismissed.concat(ids.filter(id => !isDismissed(id))).slice(-300);
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(dismissed)); } catch {}
    items = items.filter(x => !ids.includes(x.id)); paint();
  }
  function take(raw) {
    const item = toItem(raw);
    if (!item || isDismissed(item.id) || Date.now() - item.at > MAX_AGE_MS) return;
    if (item.jump === getActiveSessionId()) { dismiss([item.id]); return; }
    items = items.filter(x => x.jump !== item.jump && x.id !== item.id).concat(item).sort((p, q) => q.at - p.at);
    paint();
  }
  function paint() {
    if (!items.length) { bar?.remove(); bar = null; return; }
    if (!bar) { bar = document.createElement('div'); bar.className = 'ap-brief-bar'; bar.setAttribute('role', 'status'); bar.addEventListener('click', onClick); document.body.append(bar); }
    const resume = document.querySelector('.ap-resume-bar');
    bar.style.top = (52 + (resume ? resume.offsetHeight + 8 : 0)) + 'px';
    const shown = expanded ? items : items.slice(0, SHOW), more = items.length - shown.length;
    bar.innerHTML = shown.map(x => briefCardHtml(x, { esc, time })).join('')
      + (items.length > 1 || more ? `<div class="ap-brief-foot">${more ? `<button type="button" data-brief-more>还有 ${more} 条</button>` : ''}<button type="button" data-brief-all>全部收起</button></div>` : '');
  }
  async function onClick(event) {
    const open = event.target.closest('[data-brief-open]');
    if (open) {
      const card = open.closest('[data-brief-id]');
      try { await openSession(open.dataset.briefOpen); dismiss([card.dataset.briefId]); } catch (e) { showMessage?.(e.message); }
      return;
    }
    const x = event.target.closest('[data-brief-close]');
    if (x) { dismiss([x.dataset.briefClose]); return; }
    if (event.target.closest('[data-brief-more]')) { expanded = true; paint(); return; }
    if (event.target.closest('[data-brief-all]')) { expanded = false; dismiss(items.map(i => i.id)); }
  }
  function syncActive() {
    const sid = getActiveSessionId();
    const hit = sid ? items.filter(x => x.jump === sid).map(x => x.id) : [];
    if (hit.length) dismiss(hit);
  }
  async function load() {
    try {
      const r = await ipcRenderer.invoke('assistant:dialog-log', { limit: 300 });
      for (const e of r?.entries || []) if (e.card === 'lead-brief') take(e);
    } catch {}
  }
  ipcRenderer.on('assistant:notification', (_e, notice) => take(notice));
  document.addEventListener('hub-session-surfaces-rendered', syncActive);
  return { load, take, items: () => items.slice() };
}

module.exports = { mountBriefBar, briefCardHtml, toItem };
