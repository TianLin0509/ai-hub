'use strict';
const {accountStatus,resetAt}=require('./claude-account-pick');

// 组队 CLI 和批准弹窗共用现有账号列表与看板额度，不触发登录或额度刷新。
function teamAccountOptions({ usage = {}, ranking = {}, codexProfiles = [], antigravityProfiles, antigravityDefault = 'default', sessions = [], isFlagged = () => false, backends = {} } = {}) {
  // isFlagged 可以返回原因文字（2026-11-24 账号状态）：组队与点名时写清「会员到期」等，而不是笼统的风控。
  const flaggedClaude=new Map();
  for(const a of usage.claude||[]){const why=isFlagged('claude',a.profileId);if(why)flaggedClaude.set(a.profileId,typeof why==='string'?why:'风控观察中');}
  const pick=accountStatus({accounts:usage.claude||[],sessions,flagged:flaggedClaude});
  const claude = { recommendedId: pick.recommendedId, order:pick.order, reason:pick.reason, rows:pick.rows.map(r=>({...r,
    plenty:r.planMultiplier===1&&r.spare5h>50&&r.spare7d>30,usable:!r.excluded,
    flagged:flaggedClaude.get(r.id)||false})) };
  const spare = window => {
    if(!Number.isFinite(window?.pct))return null;
    const reset=resetAt(window.resetsAt);
    return reset!==null&&reset<=Date.now()?100:Math.max(0,Math.min(100,100-window.pct));
  };
  const codexUsage = new Map((usage.codex || []).map(a => [a.profileId, a]));
  const codex = { rows: codexProfiles.map(p => {
    const row = codexUsage.get(p.id);
    return { id: p.id, label: p.label || row?.profileLabel || p.id,
      spare5h: spare(row?.usage5h), spare7d: spare(row?.usage7d),
      activeSessions: sessions.filter(s => /^codex(?:-resume)?$/.test(s.kind) && s.codexProfile === p.id
        && !['dormant', 'exited', 'closed'].includes(s.status)).length,
      flagged: isFlagged('codex', p.id), error: row?.error || '' };
  }) };
  let gemini = { rows: [] };
  try {
    const agyUsage = new Map((usage.antigravity || []).map(a => [a.profileId, a]));
    gemini = { defaultId: antigravityDefault || 'default', rows: require('./antigravity-subscription-profiles').normalizeProfiles(antigravityProfiles).map((p, i) => {
      const row = agyUsage.get(p.id);
      const gemGroup = (row?.groups || []).find(g => g.id === 'gemini') || null;
      const tpGroup = (row?.groups || []).find(g => g.id === 'thirdParty') || null;
      const w5h = gemGroup?.usage5h || row?.usage5h || null;
      const w7d = gemGroup?.usage7d || row?.usage7d || null;
      return {
        id: p.id, label: p.label || row?.profileLabel || p.id, no: i + 1,
        spare5h: spare(w5h), spare7d: spare(w7d),
        thirdPartySpare5h: spare(tpGroup?.usage5h), thirdPartySpare7d: spare(tpGroup?.usage7d),
        activeSessions: sessions.filter(s => /^gemini(?:-resume)?$/.test(s.kind) && (s.antigravityProfile || 'default') === p.id
          && !['dormant', 'exited', 'closed'].includes(s.status)).length,
        flagged: isFlagged('gemini', p.id), error: row?.error || '',
      };
    }) };
  } catch {}
  return { ...claude, claude, codex, gemini, backends };
}

module.exports = { teamAccountOptions };
