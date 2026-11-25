'use strict';
// rank 越大越靠前；label 是看板小标题；note 写在悬停里说明档位从哪来。
//   Claude：官方凭证 rateLimitTier（max_5x / max_20x），见 claude-plan-tier.js。
//   Codex：OpenAI 官方 planType。2026-04 起 Pro 分两档：prolite = $100（Plus 的 5 倍），pro = $200（20 倍）；
//          promax 在 codex 0.171 的枚举里出现、没有公开说明，只标「Pro Max」不写倍数。
//   Gemini：Antigravity 不回档位。/credits 对还能升级的号会附升级链接，没有链接就是已在最高档（Ultra），属推测。

const CODEX = {
  promax: { rank: 40, label: 'Pro Max' },
  pro: { rank: 20, label: 'Pro 20X' },
  prolite: { rank: 5, label: 'Pro 5X' },
  plus: { rank: 1, label: 'Plus' },
  team: { rank: 0.5, label: 'Team' },
  business: { rank: 0.5, label: 'Business' },
  self_serve_business_prolite: { rank: 0.5, label: 'Business' },
  self_serve_business_usage_based: { rank: 0.5, label: 'Business' },
  enterprise: { rank: 0.5, label: 'Enterprise' },
  edu: { rank: 0.5, label: 'Edu' },
  edu_plus: { rank: 1, label: 'Edu Plus' },
  edu_pro: { rank: 20, label: 'Edu Pro' },
  go: { rank: 0.2, label: 'Go' },
  free: { rank: 0.1, label: 'Free' },
};

function claudeTier(multiplier) {
  const m = Number(multiplier) || 1;
  return m > 1 ? { rank: m, label: 'Max ' + m + 'X · 优先使用', short: 'Max ' + m + 'X', note: '' }
    : { rank: 1, label: 'Pro', short: '', note: '' };
}

function codexTier(planType) {
  const key = String(planType || '').trim().toLowerCase();
  const hit = CODEX[key];
  if (hit) return { ...hit, short: hit.label, note: '套餐：' + hit.label + '（OpenAI 官方接口）' };
  return key ? { rank: 0, label: key, short: key, note: '套餐：' + key } : { rank: 0, label: '', short: '', note: '' };
}

function geminiTier(upgradeOffered) {
  if (upgradeOffered === false) return { rank: 2, label: 'Ultra', short: 'Ultra', note: '档位：Ultra（推测：Antigravity 没给这个号升级入口）' };
  if (upgradeOffered === true) return { rank: 1, label: 'Pro', short: 'Pro', note: '档位：Pro（推测：Antigravity 给了升级入口）' };
  return { rank: 0, label: '', short: '', note: '' };
}

function planTier(provider, row = {}) {
  if (provider === 'claude') return claudeTier(row.planMultiplier);
  if (provider === 'codex') return row.apiKey ? { rank: 0, label: '', short: '', note: '' } : codexTier(row.plan);
  if (provider === 'antigravity') return geminiTier(row.upgradeOffered);
  return { rank: 0, label: '', short: '', note: '' };
}

module.exports = { planTier, codexTier, geminiTier, claudeTier };
