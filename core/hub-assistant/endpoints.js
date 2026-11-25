'use strict';
// 入口适配层的端配置（2026-11-21，合同 contract/20261121-入口适配层接口-m1.md）：
const HOUR = 3600000;
const PROFILES = Object.freeze({
  desktop: { label: '电脑', maxChars: 0, push: true, hint: '' },
  phone: { label: '手机', maxChars: 200, push: true, hint: '（来自手机。回复约 200 字以内，先说结论；细节留给电脑。）' },
});
const MORE = '…详情在电脑';
const DESKTOP_ACTIVE_MS = 10 * 60000;
const WECHAT_WINDOW_MS = 0;

const normalizeEndpoint = value => (Object.hasOwn(PROFILES, value) ? value : 'desktop');
const profileOf = value => PROFILES[normalizeEndpoint(value)];

// 超限时优先在句子边界截断；前半段找不到句子边界就硬截。
function format(endpoint, text) {
  const body = String(text || '').trim(), max = profileOf(endpoint).maxChars, chars = [...body];
  if (!max || chars.length <= max) return body;
  const room = Math.max(1, max - [...MORE].length), head = chars.slice(0, room).join('');
  let cut = -1;
  for (const mark of ['。', '！', '？', '；', '\n']) cut = Math.max(cut, head.lastIndexOf(mark));
  const kept = cut >= Math.floor(head.length / 2) ? head.slice(0, cut + 1) : head;
  return kept.trim() + MORE;
}

function route(activity = {}, { now = Date.now(), kind = 'handoff' } = {}) {
  if (kind === 'health') return ['desktop', 'phone'];
  if (now - (Number(activity.desktop) || 0) < DESKTOP_ACTIVE_MS) return ['desktop'];
  let latest = null, at = 0;
  for (const name of Object.keys(PROFILES)) {
    const t = Number(activity[name]) || 0;
    if (t > at) { at = t; latest = name; }
  }
  return ['phone'];
}

module.exports = { PROFILES, MORE, DESKTOP_ACTIVE_MS, WECHAT_WINDOW_MS, normalizeEndpoint, profileOf, format, route };
