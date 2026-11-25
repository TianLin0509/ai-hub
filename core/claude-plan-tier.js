'use strict';
// 档位来自官方 CLI 写在账号目录 .credentials.json 里的 claudeAiOauth.rateLimitTier，
// 例 default_claude_max_5x / default_claude_max_20x / default_claude_ai（Pro）。只读这一个字段，不碰令牌。
const fs = require('fs');
const path = require('path');

function planMultiplier(rateLimitTier) {
  const m = /max_(\d+)x/i.exec(String(rateLimitTier || ''));
  return m ? Math.max(1, Number(m[1]) || 1) : 1;
}

function planTierLabel(multiplier) {
  return multiplier > 1 ? multiplier + 'X' : '';
}

function readPlanMultiplier(home) {
  if (!home) return 1;
  try {
    const oauth = JSON.parse(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8')).claudeAiOauth || {};
    return planMultiplier(oauth.rateLimitTier);
  } catch { return 1; }
}

// 排序键：档位高的在前（20X → 5X → Pro），同档保持原顺序。
function byPlanDesc(a, b) {
  return (Number(b?.planMultiplier) || 1) - (Number(a?.planMultiplier) || 1);
}

module.exports = { planMultiplier, planTierLabel, readPlanMultiplier, byPlanDesc };
