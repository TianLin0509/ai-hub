'use strict';
// 原话由程序直接送进那个会话，不经前台模型（省一轮推理，原话不被转述）。
//   - 打 @ 弹出会话名单（最近活动在前），↑↓ 选、回车或 Tab 确认，插入「@「会话名」 」；
//   - 也可以手打 @名字 正文：名字按会话标题精确 → 开头 → 包含依次匹配，唯一命中才直连；
//   - 没命中或命中多个：整句照常交给前台，由前台判断交给谁（提示一句原因）。
// 只在前台会话的输入框里生效；其他会话的输入框不变。

const EXCLUDED_PURPOSES = new Set(['hub-assistant', 'hub-assistant-desk']);
const RETIRED = /（已换班）\s*$/;

function parse(text) {
  const raw = String(text || '').replace(/^\s+/, '');
  if (!raw.startsWith('@')) return null;
  let m = raw.match(/^@「([^」\n]+)」\s*([\s\S]*)$/);
  if (m) return { name: m[1].trim(), body: m[2].trim(), quoted: true };
  m = raw.match(/^@(\S+)\s+([\s\S]+)$/);
  return m ? { name: m[1].trim(), body: m[2].trim(), quoted: false } : null;
}

function activity(s) { return Number(s.lastMessageTime || s.updatedAt || s.createdAt || 0); }

function targets(sessionMap, frontId) {
  const out = [];
  for (const s of sessionMap.values()) {
    if (!s || s.id === frontId || s.hiddenFromSidebar || EXCLUDED_PURPOSES.has(s.purpose) || RETIRED.test(String(s.title || ''))) continue;
    if (s.kind === 'xresearch-run' || s.kind === 'powershell') continue;
    if (!String(s.title || '').trim()) continue;
    out.push(s);
  }
  return out.sort((a, b) => activity(b) - activity(a));
}

function resolve(text, sessionMap, frontId) {
  const p = parse(text);
  if (!p) return { parsed: false };
  if (!p.body) return { parsed: true, ok: false, empty: true, message: `点了「${p.name}」，还没写要对它说的话` };
  const list = targets(sessionMap, frontId);
  const name = p.name.toLowerCase();
  const title = s => String(s.title || '').trim().toLowerCase();
  for (const rule of [s => title(s) === name, s => title(s).startsWith(name), s => title(s).includes(name), s => String(s.id).startsWith(p.name)]) {
    const hits = list.filter(rule);
    if (hits.length === 1) return { parsed: true, ok: true, session: hits[0], body: p.body };
    if (hits.length > 1) return { parsed: true, ok: false, message: `「${p.name}」对上了 ${hits.length} 个会话，交给前台判断` };
  }
  return { parsed: true, ok: false, message: `没找到叫「${p.name}」的会话，交给前台判断` };
}

// 输入框的 @ 名单。getText/setText 由调用方提供（输入框是 contenteditable）。
const CSS = `.front-direct-menu{position:absolute;left:12px;bottom:calc(100% + 6px);z-index:80;min-width:260px;max-width:420px;background:#fff;border:1px solid var(--border,#d5dbe3);border-radius:8px;box-shadow:0 6px 20px rgba(20,30,50,.12);padding:4px 0;font-size:13px}
.front-direct-head{padding:4px 12px 6px;color:var(--text-secondary,#5f6b7a);font-size:12px}
.front-direct-item{padding:6px 12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary,#1f2933)}
.front-direct-item.active,.front-direct-item:hover{background:#eaf2ff;color:#1f5fd1}`;
function ensureStyle(doc) {
  if (doc.getElementById('front-direct-style')) return;
  const st = doc.createElement('style'); st.id = 'front-direct-style'; st.textContent = CSS; doc.head.appendChild(st);
}

function attachMenu(inputBox, { isFront, sessionMap, frontId, getText, setText, doc = document }) {
  let menu = null, items = [], active = 0;
  ensureStyle(doc);
  const close = () => { menu?.remove(); menu = null; items = []; };
  const pick = i => {
    const s = items[i]; if (!s) return;
    const rest = (parse(getText()) || {}).body || '';
    setText(`@「${s.title}」 ${rest}`);
    close();
  };
  const paint = () => {
    if (!menu) {
      menu = doc.createElement('div');
      menu.className = 'front-direct-menu';
      menu.setAttribute('role', 'listbox');
      menu.addEventListener('mousedown', e => {
        const el = e.target.closest?.('[data-fd-index]'); if (!el) return;
        e.preventDefault(); pick(Number(el.dataset.fdIndex));
      });
      const host = inputBox.closest?.('.floating-input-bar') || inputBox.parentElement || doc.body;
      if (host !== doc.body && doc.defaultView?.getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.appendChild(menu);
    }
    const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    menu.innerHTML = '<div class="front-direct-head">直接发给（不经前台）</div>' + items.map((s, i) =>
      `<div class="front-direct-item${i === active ? ' active' : ''}" role="option" aria-selected="${i === active}" data-fd-index="${i}">${esc(s.title)}</div>`).join('');
  };
  const refresh = () => {
    if (!isFront()) return close();
    const text = getText();
    const m = text.match(/^\s*@([^\s「」]*)$/);
    if (!m) return close();
    const q = m[1].toLowerCase();
    items = targets(sessionMap(), frontId()).filter(s => !q || String(s.title).toLowerCase().includes(q)).slice(0, 8);
    if (!items.length) return close();
    active = Math.min(active, items.length - 1);
    paint();
  };
  inputBox.addEventListener('input', refresh);
  inputBox.addEventListener('blur', () => setTimeout(close, 150));
  // 捕获阶段：名单开着时，回车 / Tab / 方向键 / Esc 给名单用，不触发发送。
  inputBox.addEventListener('keydown', e => {
    if (!menu || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; paint(); }
    else if (e.key === 'Enter' || e.key === 'Tab') pick(active);
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  return { close, refresh, isOpen: () => !!menu };
}

module.exports = { parse, resolve, targets, attachMenu };
