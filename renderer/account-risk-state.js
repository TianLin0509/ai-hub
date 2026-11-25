'use strict';
// 风控标记在界面侧的唯一副本：账号页、账号标签、启动中心都从这里读。
const { inForce, keyOf, statusLabel, blocksManual } = require('../core/account-risk-flags');

let snapshot = {};
let shares = {};
const listeners = new Set();
const SHARE_REFRESH_MS = 10 * 60_000;

function publish(next) {
  snapshot = next && typeof next === 'object' ? next : {};
  for (const listener of listeners) listener();
}
function publishShares(next) {
  shares = next && typeof next === 'object' ? next : {};
  for (const listener of listeners) listener();
}
function connect(ipcRenderer) {
  ipcRenderer.on?.('account-risk:changed', (_event, next) => publish(next));
  // 共享清单很少变：启动读一次，之后每 10 分钟、以及账号页刷新时再读。
  setInterval(() => void refreshShares(ipcRenderer), SHARE_REFRESH_MS).unref?.();
  return refresh(ipcRenderer);
}
async function refreshShares(ipcRenderer) {
  try {
    const result = await ipcRenderer.invoke('account-shares:list');
    if (result?.ok && JSON.stringify(result.data || {}) !== JSON.stringify(shares)) publishShares(result.data);
  } catch {}
}
async function refresh(ipcRenderer) {
  void refreshShares(ipcRenderer);
  try {
    const result = await ipcRenderer.invoke('account-risk:list');
    if (result?.ok) publish(result.data);
    return result;
  } catch (error) { return { ok: false, error: error.message }; }
}
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }

const entry = (kind, profileId) => snapshot[keyOf(kind, profileId)] || null;
function active(kind, profileId, now = Date.now()) {
  const flag = entry(kind, profileId)?.active;
  return inForce(flag, now) ? flag : null;
}
function shortDate(at) {
  const date = new Date(at);
  return `${date.getMonth() + 1}-${date.getDate()}`;
}
const untilText = flag => flag.until == null ? '手动解除前' : `至 ${shortDate(flag.until)}`;
// 账号标签紧凑后缀 / 下拉菜单与启动中心的一行 / 悬停时的完整说明。
// 2026-11-24 账号状态：写具体状态（会员到期 / 风控封禁 / 风控观察 / 暂停使用），旧记录按风控观察。
const labelOf = flag => (flag?.status === 'risk' || !flag?.status ? '风控' : statusLabel(flag));
const chipSuffix = (kind, profileId) => { const flag = riskShown(kind, profileId); return flag ? ' ⚠ ' + labelOf(flag) : ''; };
// 这三处只管显示：共享占位标记（见文件末尾）不当风控显示。
function optionNote(kind, profileId) {
  const flag = riskShown(kind, profileId);
  if (!flag) return '';
  if (blocksManual(flag)) return `⚠ ${statusLabel(flag)}，不可用（恢复正常前）`;
  return `⚠ ${statusLabel(flag)}中（${untilText(flag)}），不推荐`;
}
function describe(kind, profileId) {
  const flag = riskShown(kind, profileId);
  if (!flag) return '';
  const tail = blocksManual(flag) ? '不推荐、不自动选，手动切换也会拦下' : `${untilText(flag)}不推荐使用，自动换号会跳过`;
  return `${shortDate(flag.updatedAt || flag.flaggedAt)} 标记${statusLabel(flag)}${flag.note ? `（${flag.note}）` : ''}，${tail}；右侧额度栏右键可「恢复正常」`;
}

// 这种标记只是「共享占位」：界面上不再按风控显示或隐藏，但推荐与自动换号照旧避开（规则不变）。
const SHARE_NOTE = /共用|共享|分享/;
const sharedTo = (kind, profileId) => shares[keyOf(kind, profileId)] || null;
function shareHold(kind, profileId, now = Date.now()) {
  const flag = active(kind, profileId, now);
  return !!flag && (flag.status == null || flag.status === 'risk')
    && SHARE_NOTE.test(flag.note || '') && !!sharedTo(kind, profileId);
}
// 界面要不要按「风控」显示（⚠、隐藏、橙色编号）：共享占位不算。
const riskShown = (kind, profileId, now = Date.now()) => (shareHold(kind, profileId, now) ? null : active(kind, profileId, now));
function sinceText(since) {
  const at = Date.parse(since);
  return Number.isFinite(at) ? `${shortDate(at)} 起` : '';
}
// 悬停说明：共享给谁、从哪天起、到期（管家没有到期日，吊销前一直有效）。
function shareNote(kind, profileId) {
  const list = sharedTo(kind, profileId);
  if (!list?.length) return '';
  const devices = list.map(d => d.device + (sinceText(d.since) ? `（${sinceText(d.since)}）` : '')).join('、');
  const hold = shareHold(kind, profileId) ? '；推荐与自动换号会跳过，手动可选' : '';
  return `已共享给：${devices}；到期：长期，吊销前一直有效${hold}`;
}

// 看板号卡里代替额度显示的一小段：「会员到期 · 11-24」。
function statusText(kind, profileId) {
  const flag = riskShown(kind, profileId);
  return flag ? statusLabel(flag) + ' · ' + shortDate(flag.updatedAt || flag.flaggedAt) : '';
}
module.exports = { active, chipSuffix, labelOf, statusText, connect, describe, entry, optionNote, publish, publishShares, refresh, refreshShares,
  riskShown, shareHold, shareNote, sharedTo, shortDate, subscribe, untilText };
