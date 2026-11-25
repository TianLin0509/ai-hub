'use strict';
// 存在 config.json 的 providers.codex.peerReservePct：{ "<profileId>": 整数 0–50 }。
const MAX_RESERVE = 50;
const defaultReserve = profileId => (profileId === 'default' ? 5 : 10);

// 合法值是 0–50 的整数；不是数字返回 null，超出范围收到边界。
function normalizeReserve(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_RESERVE, Math.max(0, Math.round(n)));
}

function reserveFor(map, profileId) {
  const own = map && Object.prototype.hasOwnProperty.call(map, profileId) ? normalizeReserve(map[profileId]) : null;
  return own === null ? defaultReserve(profileId) : own;
}

const readReserveMap = raw => {
  const map = raw?.providers?.codex?.peerReservePct;
  return map && typeof map === 'object' && !Array.isArray(map) ? { ...map } : {};
};

// 返回新的配置对象：只改 providers.codex.peerReservePct 里这一个号，其余字段原样保留。
function withReserve(raw, profileId, value) {
  const id = String(profileId || '');
  const pct = normalizeReserve(value);
  if (!id) throw new Error('缺少 Codex 账号');
  if (pct === null) throw new Error('保留线要填 0–' + MAX_RESERVE + ' 的整数');
  const base = raw && typeof raw === 'object' ? raw : {};
  return { ...base, providers: { ...base.providers, codex: { ...base.providers?.codex, peerReservePct: { ...readReserveMap(base), [id]: pct } } } };
}

module.exports = { MAX_RESERVE, defaultReserve, normalizeReserve, reserveFor, readReserveMap, withReserve };
