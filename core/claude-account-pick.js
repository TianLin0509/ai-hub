'use strict';
// 只使用本机被动额度读数，不发网络请求，不调整账号环境或出口。
const { rankClaudeAccounts } = require('./claude-launch-recommend');
const STALE_MS = 30 * 60 * 1000;
const LOW_7D = 20;
const known = row => row.spare5h !== null && row.spare7d !== null;
const plenty = row => row.planMultiplier === 1 && row.spare5h > 50 && row.spare7d > 30;
const tier = row => plenty(row) ? 0 : row.planMultiplier > 1 && known(row) ? 1 : known(row) ? 2 : 3;
function resetAt(value) {
  if (value === null || value === undefined || value === '') return null;
  const at = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(at) && at > 0 ? at : null;
}
// flagged 可以是 Set（旧调用）或 Map(id → 原因)：Map 时写出具体状态，如「会员到期（11-24 标记）」（2026-11-24）。
function excludedReason(row, account, flagReason) {
  if (row.flagged) return typeof flagReason === 'string' && flagReason ? flagReason : '风控观察中';
  if (account?.error) return '账号异常：' + String(account.error).slice(0, 60);
  if ([row.spare5h, row.spare7d].some(v => v !== null && v <= 0)) return '额度用完';
  return null;
}
function compare(a, b) {
  return tier(a) - tier(b) || a.activeSessions - b.activeSessions
    || (a.resets7dAt ?? Infinity) - (b.resets7dAt ?? Infinity)
    || String(a.id).localeCompare(String(b.id));
}
function reason(row, explicit = false) {
  return `${row.label || row.id}：${explicit ? '点名账号，' : ''}${plenty(row) ? 'Pro 充足' : row.planMultiplier > 1 ? row.planMultiplier + 'X 可用' : known(row) ? 'Pro 可用' : '额度未知'}，${row.activeSessions} 个会话`;
}
function accountStatus({ accounts = [], sessions = [], flagged = new Set(), now = Date.now(), account } = {}) {
  const byId = new Map(accounts.map(a => [a.profileId, a]));
  const normalized=accounts.map(a=>({...a,usage5h:a.usage5h?{...a.usage5h,resetsAt:resetAt(a.usage5h.resetsAt)}:null,
    usage7d:a.usage7d?{...a.usage7d,resetsAt:resetAt(a.usage7d.resetsAt)}:null}));
  const ranking = rankClaudeAccounts({ accounts:normalized, sessions, flagged, now });
  const rows = ranking.rows.map(r => {
    const source = byId.get(r.id) || {}, readAt = Number(source.lastSeen) || 0;
    const row = { id: r.id, label: source.profileLabel || r.id, planMultiplier: r.planMultiplier || 1,
      spare5h: r.spare5h, spare7d: r.spare7d, readAt, stale: !readAt || now - readAt > STALE_MS,
      activeSessions: r.running + r.idle, running: r.running, resets7dAt: resetAt(source.usage7d?.resetsAt),
      excluded: excludedReason(r, source, flagged.get?.(r.id)) };
    row.reason = reason(row); return row;
  });
  const eligible = rows.filter(r => !r.excluded).sort(compare);
  eligible.forEach((r, i) => { r.rank = i + 1; });
  const named = account ? rows.find(r => r.id === account) : null;
  if (account && (!named || named.excluded)) throw new Error(named ? `点名账号不可用：${named.excluded}` : '点名账号不在 Hub 账号列表里');
  const chosen = named || eligible.find(known) || null;
  const lowQuota = !eligible.length || (!eligible.some(plenty) && eligible.filter(known).length > 0 && eligible.filter(known).every(r => r.spare7d < LOW_7D));
  return { recommendedId: chosen?.id || null, reason: chosen ? reason(chosen, !!named) : '没有可确认额度的账号，沿用 Hub 默认账号',
    order: eligible.map(r => r.id), lowQuota, rows: [...eligible, ...rows.filter(r => r.excluded)] };
}
function assignAccounts(status, n) {
  if (!status?.recommendedId) return [];
  const pool = status.rows.filter(r => !r.excluded && known(r)).map(r => ({ ...r })), out = [];
  for (let i = 0; i < n && pool.length; i++) {
    pool.sort(compare); const pick = pool[0]; out.push(pick.id); pick.activeSessions++; pick.running++;
  }
  return out;
}
function describeStatus(status) {
  const clock = at => at ? new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '没有读数';
  return { recommendedId: status.recommendedId, reason: status.reason, order: status.order, lowQuota: status.lowQuota,
    accounts: status.rows.map(r => ({ id: r.id, label: r.label, plan: r.planMultiplier > 1 ? r.planMultiplier + 'X' : 'Pro',
      spare5h: r.spare5h, spare7d: r.spare7d, reading: (r.stale && r.readAt ? '上次读数 ' : '读数 ') + clock(r.readAt),
      resets7dAt: r.resets7dAt, activeSessions: r.activeSessions, rank: r.rank || null, reason: r.reason,
      ...(r.excluded ? { excluded: r.excluded } : {}) })),
    note: '排除风控、异常、耗尽账号；Pro 充足（5h >50%、7d >30%）优先，其次 5X；同等先会话少，再 7d 重置近。未知重置时间排在已知之后。点名可用账号优先。' };
}
module.exports = { STALE_MS, LOW_7D, accountStatus, assignAccounts, describeStatus, compare, reason, resetAt };
