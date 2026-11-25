'use strict';
//   - 有多账号的 AI（Claude、Codex、Antigravity）左栏竖排用量账号，每行带 5h / 7d 剩余条与会话数，右栏放参数；
// 原来的 <select> 都留在页面里、只是藏起来：取值、change 事件、默认值保存等现有逻辑一行不改，
// 点账号行或分段按钮就是替你选中对应的那一项并发出 change。
const panel = require('./account-quota-panel.js');
const { viewRows } = panel;

const SEGMENTED = [
  { id: 'new-session-deepseek-route', max: 4 },
  { id: 'new-session-model', max: 5 },
  { id: 'new-session-effort', max: 7 },
  { id: 'new-session-codex-tier', max: 4 },
  { id: 'new-session-mcp', max: 6 },
];
const QUOTA_PROVIDER = { claude: 'claude', codex: 'codex', gemini: 'antigravity' };
const QUOTA_TTL = 30000;

function createLaunchConfigLayout({ document, ipcRenderer, escapeHtml: esc }) {
  const section = document.getElementById('new-session-config-section');
  if (!section) return { paint() {} };
  // 一次性改结构：标题行之下分左右两栏；原有字段全部挪进右栏，顺序不变。
  if (section.querySelector(':scope > .lcc-body')) throw new Error('启动配置布局已初始化过');
  const heading = section.querySelector('.session-config-heading');
  const body = document.createElement('div'); body.className = 'lcc-body';
  const left = document.createElement('div'); left.className = 'lcc-accounts'; left.id = 'new-session-account-list'; left.setAttribute('role', 'listbox'); left.setAttribute('aria-label', '用量账号');
  const right = document.createElement('div'); right.className = 'lcc-params';
  for (const node of [...section.childNodes]) if (node !== heading) right.appendChild(node);
  body.append(left, right); section.appendChild(body);
  section.classList.add('lcc');

  let quota = {}, quotaAt = 0, quotaFlight = null, lastCtx = null;
  function loadQuota() {
    if (quotaFlight || Date.now() - quotaAt < QUOTA_TTL) return;
    quotaFlight = Promise.resolve(ipcRenderer.invoke('account-profile-usage')).then(cached => {
      const next = {};
      for (const provider of Object.values(QUOTA_PROVIDER)) {
        const rows = viewRows(provider, { accounts: { [provider]: cached?.[provider] || [] } }, '', Date.now());
        next[provider] = Object.fromEntries(rows.map(r => [r.profileId || 'default', r]));
      }
      quota = next; quotaAt = Date.now();
    }).catch(() => { quotaAt = Date.now(); }).finally(() => { quotaFlight = null; if (lastCtx) paintAccounts(lastCtx); });
  }

  // 名称只写「账号 N」（N 同右侧栏编号），原名、邮箱、推荐理由放悬停；推荐号绿色小框，当前选中蓝色编号 + 浅蓝底。
  function paintAccounts(ctx) {
    const { kind, showAccount, accounts = [], selectedId, disabled, ranking } = ctx;
    const on = !!showAccount && accounts.length > 0;
    body.classList.toggle('has-accounts', on);
    left.hidden = !on;
    // 清空时连同缓存一起清：否则 Claude → DeepSeek → Claude 回来时内容与缓存相同、跳过重画，左栏就是空的。
    if (!on) { left.innerHTML = ''; delete left.dataset.html; return; }
    const provider = QUOTA_PROVIDER[kind], now = Date.now();
    const rows = new Map((ranking?.rows || []).map(r => [r.id, r]));
    const withSessions = provider === 'claude' || provider === 'antigravity';
    const views = accounts.map((a, index) => ({ a, index })).filter(({ a }) => !a.risk || a.id === selectedId).map(({ a, index }) => {
      const r = rows.get(a.id), q = panel.accountQuota(provider, a.id) || quota[provider]?.[a.id] || null;
      const v = { remain5h: q ? q.remain5h : r ? r.spare5h : null, remain7d: q ? q.remain7d : r ? r.spare7d : null,
        reset5h: q?.reset5h, reset7d: q?.reset7d, assumed5h: !!q?.assumed5h, assumed7d: !!q?.assumed7d,
        has5h: q ? q.has5h : kind !== 'codex', apiKey: !!q?.apiKey };
      // Codex 与 Antigravity 按看板档位排序和分组（Ultra / Pro 20X 在前），小标写档位名；Claude 照旧按 5X / 20X。
      if (provider === 'codex' || provider === 'antigravity') return { a, r, q, v, no: q?.no || index + 1, plan: Number(q?.tierRank) || 0, tag: q?.tierShort || '' };
      const plan = Number(r?.planMultiplier || q?.planMultiplier) || 1;
      return { a, r, q, v, no: q?.no || index + 1, plan, tag: plan > 1 ? plan + 'X' : '' };
    }).sort((x, y) => y.plan - x.plan || x.no - y.no); // 和右侧栏同一顺序：高档位在前，同档按编号 1→N；推荐靠绿框标出、默认选中。
    // Codex / Antigravity 有两种以上档位时按档位名分段、各加一行小标题（与右侧看板同样归段），Claude 照旧不分段。
    const sections = (provider === 'codex' || provider === 'antigravity') ? new Map() : null;
    if (sections) { for (const x of views) { const k = x.q?.tierLabel || '档位未知'; if (!sections.has(k)) sections.set(k, []); sections.get(k).push(x); } views.splice(0, views.length, ...[...sections.values()].flat()); }
    const sectionAt = new Map();
    if (sections && sections.size > 1) for (const [label, list] of sections) sectionAt.set(list[0], label);
    if (sectionAt.size) for (const x of views) x.tag = '';
    const any5h = views.some(x => x.v.has5h);
    const cols = `lcc-row${withSessions ? '' : ' no-sessions'}`;
    const head = `<div class="lcc-h ${cols}"><span>用量账号</span>${any5h ? '<span>5h 剩余</span><span>7d 剩余</span>' : '<span class="cq-wide">7d 剩余</span>'}${withSessions ? '<span>会话</span>' : ''}</div>`;
    const html = head + views.map(x => (sectionAt.has(x) ? `<div class="lcc-section">${esc(sectionAt.get(x))}</div>` : '') + accountHtml(x)).join('');
    function accountHtml({ a, r, q, v, no, tag }) {
      const sessions = r ? r.running + r.idle : Number.isFinite(q?.sessions) ? q.sessions : null;
      const soft = a.recommended && ranking && !ranking.plenty && !ranking.preferred;
      const why = a.risk ? '⚠ ' + a.risk
        : a.recommended && ranking?.preferred && r ? `★ 推荐 ${r.planMultiplier}X 号（5X 号优先用）：会话 ${r.running + r.idle} 个 · 5h 剩 ${r.spare5h}% · 7d 剩 ${r.spare7d}%`
        : a.recommended ? (soft ? '较优：没有号同时满足会话 ≤ 1、5h > 70%、7d 高于节奏，按综合余量排第一'
          : r ? `★ 推荐：会话 ${r.running + r.idle} 个 · 5h 剩 ${r.spare5h}% · 7d 剩 ${r.spare7d}%，按节奏此时该剩 ${r.expected7d}%，余量 +${r.margin}%` : '★ 推荐') : '';
      const title = ['账号 ' + no + (a.label ? '（' + a.label + '）' : ''), a.email || '账号未确认', why,
        sessions !== null && withSessions ? `活跃会话 ${sessions} 个${r?.running ? `（${r.running} 在跑）` : ''}` : ''].filter(Boolean).join('\n');
      const cells = v.apiKey ? '<span class="cq-cell cq-wide cq-nodata">API Key 登录</span>'
        : v.remain5h === null && v.remain7d === null ? '<span class="cq-cell cq-wide cq-nodata">待读取</span>'
          : v.has5h ? panel.quotaCell(v, '5h', now) + panel.quotaCell(v, '7d', now) : panel.quotaCell(v, '7d', now, { wide: any5h });
      const cls = `lcc-acct ${cols}${a.recommended ? soft ? ' is-soft' : ' is-recommended' : ''}${a.risk ? ' has-account-risk' : ''}`;
      return `<button type="button" class="${cls}" role="option" data-lcc-account="${esc(a.id)}" aria-selected="${a.id === selectedId}" ${disabled ? 'disabled' : ''} title="${esc(title)}" aria-label="${esc(title)}">`
        + `<b class="lcc-no">${a.risk ? '⚠ ' : ''}账号 ${no}${tag ? `<i class="acct-plan-tag">${esc(tag)}</i>` : ''}</b>${cells}`
        + (withSessions ? `<span class="cq-sessions${sessions ? '' : ' is-zero'}">${sessions ?? ''}</span>` : '') + '</button>';
    }
    if (left.dataset.html !== html) { left.innerHTML = html; left.dataset.html = html; }
  }

  // 分段按钮：跟着 <select> 的选项和取值重画；选项太多或字段藏着时照旧用下拉框。
  function paintSegments() {
    for (const { id, max } of SEGMENTED) {
      const select = document.getElementById(id);
      if (!select) continue;
      const field = select.closest('.session-tuning-field');
      let seg = select.parentElement.querySelector(`.lcc-seg[data-for="${id}"]`);
      const options = [...select.options].filter(o => !o.hidden);
      // CodeAgent 的模型下拉里带每个模型的今日用量（launch-select-popover 读 data-usage），保持下拉框。
      const keepDropdown = id === 'new-session-model' && lastCtx?.kind === 'codeagent';
      const use = !keepDropdown && !(field && field.hidden) && options.length >= 2 && options.length <= max;
      select.classList.toggle('lcc-hidden', use);
      if (!use) { if (seg) seg.hidden = true; continue; }
      if (!seg) { seg = document.createElement('div'); seg.className = 'lcc-seg'; seg.dataset.for = id; seg.setAttribute('role', 'radiogroup'); select.insertAdjacentElement('afterend', seg); }
      seg.hidden = false;
      seg.setAttribute('aria-label', field?.querySelector('span')?.textContent || '');
      const html = options.map(o => {
        // 只写名称；「最强」「省额度」「不加载工具」等说明放在悬停提示里，免得一行放不下。
        const main = o.textContent.split(' · ')[0].replace(/\s+(最强|深入思考|省额度|最省|默认)$/, '');
        const off = /不可用$/.test(o.textContent) ? '<small>不可用</small>' : '';
        return `<button type="button" role="radio" data-lcc-value="${esc(o.value)}" aria-checked="${o.value === select.value}" ${select.disabled || o.disabled ? 'disabled' : ''} title="${esc(o.textContent)}">${esc(main)}${off}</button>`;
      }).join('');
      if (seg.dataset.html !== html) { seg.innerHTML = html; seg.dataset.html = html; }
    }
  }

  function choose(select, value) {
    if (!select || select.disabled || select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  section.addEventListener('click', event => {
    const acct = event.target.closest('[data-lcc-account]');
    if (acct && !acct.disabled) { choose(document.getElementById('new-session-account'), acct.dataset.lccAccount); return; }
    const b = event.target.closest('.lcc-seg [data-lcc-value]');
    if (b && !b.disabled) choose(document.getElementById(b.closest('.lcc-seg').dataset.for), b.dataset.lccValue);
  });

  // 右侧栏读到新额度时同步重画账号列表（与右侧栏同一份读数）。
  panel.subscribeAccountQuota(() => { if (lastCtx) paintAccounts(lastCtx); });

  return {
    paint(ctx) {
      lastCtx = ctx;
      if (ctx.showAccount && QUOTA_PROVIDER[ctx.kind]) loadQuota();
      paintAccounts(ctx);
      paintSegments();
    },
  };
}

module.exports = { createLaunchConfigLayout };
