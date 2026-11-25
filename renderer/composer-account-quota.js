'use strict';
//   - 按钮直接显示「账号 N」+ 这个号的 5h / 7d 剩余，样式同右侧栏细线表，一眼看到当前号还剩多少；
//   - 下拉每项只写「账号 N」，当前项打 ✓；不可选的原因、风控说明放悬停。
// N 与右侧栏编号一致（account-quota-panel 的共享读数）；读数来自看板，不另取额度。
const panel = require('./account-quota-panel.js');
const { formatResetCountdown } = require('./sidebar-account-usage.js');

const PROVIDER = { claude: 'claude', codex: 'codex', gemini: 'antigravity' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shortName(kind, profileId, label) {
  return panel.accountShortName(PROVIDER[kind], profileId, label);
}

// 按钮内容：账号 N · [5h 细线格] [7d 细线格] · 风控/自动换号小标 · ▾。Codex 没有 5h 窗口时只显示 7d。
function chipHtml(kind, profileId, label, { risk = false, auto = false, caret = true, now = Date.now() } = {}) {
  const row = panel.accountQuota(PROVIDER[kind], profileId);
  const cells = !row || row.apiKey || (row.remain5h === null && row.remain7d === null) ? ''
    : (row.has5h ? panel.quotaCell(row, '5h', now, { reset: false }) : '') + panel.quotaCell(row, '7d', now, { reset: false });
  return `<span class="cac-name">${risk ? '⚠ ' : ''}${esc(shortName(kind, profileId, label))}</span>`
    + (cells ? `<span class="cac-quota">${cells}</span>` : '')
    + (auto ? '<span class="cac-auto">自动换号</span>' : '') + (caret ? '<span class="cac-caret" aria-hidden="true">▾</span>' : '');
}

// 悬停文字：账号 N（原名）+ 两个窗口的剩余与重置倒计时。
function chipTitle(kind, profileId, label, extra = '', now = Date.now(), { interactive = true } = {}) {
  const row = panel.accountQuota(PROVIDER[kind], profileId);
  const lines = [shortName(kind, profileId, label) + (label ? '（' + label + '）' : '')];
  if (row?.email) lines.push('邮箱：' + row.email);
  const win = (name, pct, at) => name + ' 剩余：' + (pct === null || pct === undefined ? '未知' : pct + '%')
    + (Number.isFinite(at) && at > now && pct < 100 ? ' · ' + formatResetCountdown(at, now) + ' 后重置' : '');
  if (row && !row.apiKey) { if (row.has5h) lines.push(win('5h', row.remain5h, row.reset5h)); lines.push(win('7d', row.remain7d, row.reset7d)); }
  if (extra) lines.push(extra);
  if (interactive) lines.push('点击切换这个会话使用的账号');
  return lines.join('\n');
}

// 下拉项文字：只写「账号 N」，当前项前面打 ✓；待切换的项加「待切换」（只在排队时出现）。
function optionText(kind, account, { current, pending, risk }) {
  return `${current ? '✓ ' : ''}${risk ? '⚠ ' : ''}${shortName(kind, account.id, account.label)}${pending ? ' · 待切换' : ''}`;
}

module.exports = { chipHtml, chipTitle, optionText, shortName, subscribe: panel.subscribeAccountQuota };
