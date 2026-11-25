'use strict';

// Launch-center ranking from what the Hub already knows: the last quota reading
// and its own session list. No request goes out, so opening stays instant.
// Spare quota is the tighter of the 5h and 7d windows; a running session keeps
// spending it, an idle one only might.
const RUNNING_SESSION_COST = 10;
const IDLE_SESSION_COST = 3;

function spare(window, now) {
  if (!window || !Number.isFinite(window.pct)) return null;
  if (Number(window.resetsAt) > 0 && Number(window.resetsAt) <= now) return 100;
  return Math.max(0, Math.min(100, 100 - window.pct));
}

function liveSessionsByProfile(sessions) {
  const counts = new Map();
  for (const session of sessions || []) {
    if (!session?.claudeProfile || ['dormant', 'closed'].includes(session.status)) continue;
    const row = counts.get(session.claudeProfile) || { running: 0, idle: 0 };
    row[session.status === 'running' ? 'running' : 'idle']++;
    counts.set(session.claudeProfile, row);
  }
  return counts;
}

//   离重置还有 d 天时该剩 100 - 100/7×(7-d)，例：还有 2 天 → 该剩约 29%；7d 满额直接算满足）。
//   每个号最后 10% 是预留（RESERVE_7D）：7d 剩 ≤ 10% 不推荐，看板上节奏点直接红。
// 满足的号排最前，按 7d 余量（实际 - 该剩）从大到小，余量相同看 5h；都不满足时沿用下面的综合余量打分。
const WEEKLY_PLAN = 100;
const RESERVE_7D = 10;
const DAY = 86400_000;
function expected7d(window, now) {
  const at = new Date(window?.resetsAt || 0).getTime();
  const daysLeft = Number.isFinite(at) && at > now ? Math.min(7, (at - now) / DAY) : 7;
  return Math.round(Math.max(0, 100 - (WEEKLY_PLAN / 7) * (7 - daysLeft)));
}

// flagged: 风控观察中的账号 id。额度再多也不推荐，并排到最后。
//（5h、7d 都没用完、7d 高于 10% 预留、没被风控），就先推荐它，同档里再按上面的余量规则挑。
// 5X 号的 1% 约等于 Pro 号的 5%，所以即使 5X 只剩 30%，也比满额的 Pro 号经用。
function rankClaudeAccounts({ accounts, sessions, flagged = new Set(), now = Date.now() }) {
  const live = liveSessionsByProfile(sessions);
  const rows = (accounts || []).map(account => {
    const spare5h = spare(account.usage5h, now), spare7d = spare(account.usage7d, now);
    const { running = 0, idle = 0 } = live.get(account.profileId) || {};
    const known = spare5h !== null && spare7d !== null;
    const usable = known && !account.error && Math.min(spare5h, spare7d) > 0;
    const isFlagged = flagged.has(account.profileId);
    const planMultiplier = Number(account.planMultiplier) || 1;
    const expected = usable ? expected7d(account.usage7d, now) : null;
    const plenty = usable && !isFlagged && running + idle <= 1 && spare5h > 70 && spare7d > RESERVE_7D && (spare7d > expected || spare7d >= 100);
    const preferred = usable && !isFlagged && planMultiplier > 1 && spare7d > RESERVE_7D;
    return { id: account.profileId, spare5h, spare7d, running, idle, usable, flagged: isFlagged, expected7d: expected, plenty,
      planMultiplier, preferred,
      margin: plenty ? spare7d - expected : null,
      score: usable ? Math.min(spare5h, spare7d) - running * RUNNING_SESSION_COST - idle * IDLE_SESSION_COST : null };
  });
  const tier = row => row.flagged ? 4 : row.plenty ? 0 : row.usable ? 1 : row.spare5h === null || row.spare7d === null ? 2 : 3;
  const byQuota = (a, b) => tier(a) - tier(b)
    || (a.plenty ? (b.margin - a.margin) || (b.spare5h - a.spare5h) : 0)
    || (b.score ?? 0) - (a.score ?? 0) || a.running + a.idle - b.running - b.idle;
  const pick = [...rows].sort((a, b) => (b.preferred ? b.planMultiplier : 0) - (a.preferred ? a.planMultiplier : 0) || byQuota(a, b))[0];
  // 列表顺序：高档位在前（风控号不论档位都在最后），同档按余量。
  const planKey = row => row.flagged ? 0 : row.planMultiplier;
  rows.sort((a, b) => planKey(b) - planKey(a) || byQuota(a, b));
  const recommended = pick?.usable && !pick.flagged ? pick : null;
  return { recommendedId: recommended?.id || null, plenty: !!recommended?.plenty, preferred: !!recommended?.preferred, rows };
}

function accountHint(row) {
  const plan = row.planMultiplier > 1 ? row.planMultiplier + 'X · ' : '';
  const quota = row.spare5h === null || row.spare7d === null ? '额度待读取' : `5h 余 ${row.spare5h}% · 7d 余 ${row.spare7d}%`;
  const count = row.running + row.idle;
  return `${plan}${quota} · ${count ? `${count} 个会话${row.running ? `（${row.running} 个在跑）` : ''}` : '无会话'}`;
}

module.exports = { IDLE_SESSION_COST, RUNNING_SESSION_COST, WEEKLY_PLAN, RESERVE_7D, accountHint, expected7d, liveSessionsByProfile, rankClaudeAccounts };
