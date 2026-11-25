'use strict';
// 布局：标题行 → 账号表（编号 + 档位小标 | 5h 剩余 | 7d 剩余 | 会话数 | 状态）→ 底栏（自动换号开关 + 状态说明）。
//   - 额度格子与右侧「账号额度」看板同一写法（account-quota-panel.quotaCell），颜色、细线一致；
//   - Claude 的 5X / 20X 号排在最前，并按档位分段（「Max 5X · 优先使用」「Pro」）；同档按看板编号；
//   - 当前账号左侧蓝色竖条 + ✓；推荐号写「推荐」；不可选的行变浅，原因在悬停里；
//   - 说明文字只在有事要说时（排队中、失败、不能换号）才用彩色框，平时是一行浅灰小字。
// 这里只负责画；选择、排队、自动换号的逻辑仍在 composer-claude-account / composer-codex-account。
const panel = require('./account-quota-panel.js');
const accountRisk = require('./account-risk-state');

const PROVIDER = { claude: 'claude', codex: 'codex' };

function el(doc, tag, cls, text) {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function planOf(account, quota) {
  return Number(account?.planMultiplier || quota?.planMultiplier) || 1;
}

function tierOf(kind, account, quota) {
  if (kind === 'codex') return { rank: Number(quota?.tierRank) || 0, label: quota?.tierLabel || '档位未知', tag: quota?.tierShort || '' };
  const plan = planOf(account, quota);
  return { rank: plan, label: plan > 1 ? `Max ${plan}X · 优先使用` : 'Pro', tag: plan > 1 ? plan + 'X' : '' };
}

// 行顺序：档位高的在前，同档按看板编号（没有编号的按原顺序排在后面）；
// 再按档位名归段（同 rank 的 Team、Business 交错时各成一段），和看板 tierRowsHtml 一致。
function orderAccounts(kind, accounts) {
  const sorted = (accounts || []).map((account, index) => {
    const quota = panel.accountQuota(PROVIDER[kind], account.id);
    const tier = tierOf(kind, account, quota);
    return { account, quota, index, tier, plan: tier.rank, no: quota?.no ?? Infinity };
  }).sort((a, b) => b.plan - a.plan || a.no - b.no || a.index - b.index);
  const buckets = new Map();
  for (const row of sorted) { if (!buckets.has(row.tier.label)) buckets.set(row.tier.label, []); buckets.get(row.tier.label).push(row); }
  return [...buckets.values()].flat();
}

function quotaCells(row, now) {
  if (!row || row.apiKey) return '<span class="cam-cell cam-wide cam-nodata">' + (row?.apiKey ? 'API Key' : '额度待读取') + '</span>';
  if (row.remain5h === null && row.remain7d === null) return '<span class="cam-cell cam-wide cam-nodata">额度待读取</span>';
  return row.has5h ? panel.quotaCell(row, '5h', now, { reset: false }) + panel.quotaCell(row, '7d', now, { reset: false })
    : panel.quotaCell(row, '7d', now, { wide: true, reset: false });
}

// 画整个菜单。state: { accounts, currentId, pendingId, canSwitch, disabledAll, note: {text, state}, autoItem, onSelect, titles }
// 根因：会话每次状态更新都会调到这里，原来每次都把整张表拆掉重画，滚动位置归零，按到一半的点击也会丢。
// 现在先画到内存里，和上一次画出来的内容一样就不动页面；确实变了才替换，并把滚动位置放回去。
function paintAccountMenu({ document: doc, menu, kind, state, now = Date.now() }) {
  const head = el(doc, 'div', 'cam-head');
  head.append(el(doc, 'strong', 'cam-title', kind === 'codex' ? '切换 Codex 账号' : '切换 Claude 账号'));
  head.append(el(doc, 'span', 'cam-sub', '工作中会等本轮结束再换'));

  const rows = orderAccounts(kind, state.accounts);
  const withSessions = kind === 'claude';
  const list = el(doc, 'div', 'cam-list' + (withSessions ? '' : ' no-sessions'));
  list.setAttribute('role', 'group');
  if (!state.accounts) list.append(el(doc, 'div', 'cam-empty', '正在读取账号…'));
  const labels = new Set(rows.map(r => r.tier.label));
  let lastLabel = null;
  for (const { account, quota, plan, tier } of rows) {
    if (labels.size > 1 && tier.label !== lastLabel) {
      const sec = el(doc, 'div', 'cam-section', tier.label);
      sec.dataset.plan = String(plan);
      list.append(sec);
      lastLabel = tier.label;
    }
    const current = account.id === state.currentId;
    const pending = account.id === state.pendingId;
    const risk = !!accountRisk.optionNote(PROVIDER[kind], account.id);
    const button = el(doc, 'button', `claude-account-option${kind === 'codex' ? ' codex-account-option' : ''} cam-row${current ? ' current' : ''}${pending ? ' is-pending' : ''}${quota?.recommended ? ' is-recommended' : ''}${risk ? ' has-account-risk' : ''}${!current && account.available !== true ? ' is-unavailable' : ''}`);
    button.type = 'button';
    button.dataset.profileId = account.id;
    button.dataset.plan = String(plan);
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(current));
    button.disabled = !!state.disabledAll || !state.canSwitch || (!current && account.available !== true);
    const name = panel.accountShortName(PROVIDER[kind], account.id, account.label);
    const sessions = withSessions && Number.isFinite(quota?.sessions) ? quota.sessions : null;
    const shared = !!accountRisk.sharedTo(PROVIDER[kind], account.id);
    const status = current ? '✓ 当前' : pending ? '待切换' : account.available !== true ? '不可用' : quota?.recommended ? '推荐' : shared ? '已共享' : '';
    const statusKey = current ? 'current' : pending ? 'pending' : account.available !== true ? 'off' : quota?.recommended ? 'recommended' : shared ? 'shared' : '';
    if (shared) button.classList.add('is-shared');
    button.innerHTML = `<span class="cam-name">${risk ? '<i class="cam-risk" aria-hidden="true">⚠</i>' : ''}${esc(name)}`
      + `${tier.tag ? `<i class="acct-plan-tag">${esc(tier.tag)}</i>` : ''}${shared ? panel.SHARE_MARK : ''}</span>`
      + `<span class="cam-quota">${quotaCells(quota, now)}</span>`
      + (withSessions ? `<span class="cam-sessions${sessions ? '' : ' is-zero'}" title="活跃会话">${sessions ?? ''}</span>` : '')
      + `<span class="cam-status" data-status="${statusKey}">${status}</span>`;
    // 无障碍与旧测试：按钮文字里保留 ✓ / ⚠ / 待切换。
    button.setAttribute('aria-label', `${current ? '✓ ' : ''}${risk ? '⚠ ' : ''}${name}${tier.tag ? ' ' + tier.tag : ''}${pending ? ' · 待切换' : ''}`);
    button.title = [state.titles?.(account, { current }) || '', accountRisk.shareNote(PROVIDER[kind], account.id)].filter(Boolean).join('\n');
    button.addEventListener('click', () => state.onSelect(account.id));
    list.append(button);
  }

  const foot = el(doc, 'div', 'cam-foot');
  if (state.autoItem) foot.append(state.autoItem);
  const note = el(doc, 'div', `model-picker-note ${kind}-account-note cam-note`);
  note.setAttribute('role', 'status');
  note.dataset.state = state.note?.state || 'hint';
  note.textContent = state.note?.text || '';
  note.hidden = !note.textContent;
  foot.append(note);

  const parts = [head, list, foot];
  const key = parts.every(p => typeof p.outerHTML === 'string') ? parts.map(p => p.outerHTML).join('') : null;
  const shown = menu._camShown;
  if (key !== null && shown && shown.key === key && shown.list.parentNode === menu) return { list: shown.list, note: shown.note };
  const scrollTop = shown?.list?.scrollTop || 0;
  menu.replaceChildren(...parts);
  if (scrollTop) list.scrollTop = scrollTop;
  menu._camShown = { key, list, note };
  return { list, note };
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { paintAccountMenu, orderAccounts };
