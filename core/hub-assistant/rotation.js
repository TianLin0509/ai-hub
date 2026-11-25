'use strict';
// 助理会话的去留（纯函数，便于测试与调参）。
// 上下文变长交给 CLI 自带的压缩（Claude Code、Codex 快满时都会自动 compact，Claude 窗口可到 1M）。
// 保留每天一次的「交接记录」：同一会话空闲满 2 小时或跨过凌晨 4 点后，让它复盘并写交接，存进交接文件，
const IDLE_MS = 2 * 3600 * 1000;
const DAILY_HOUR = 4;
const MIN_TOKENS = 30000;

const BEIJING_MS = 8 * 3600000, DAY_MS = 86400000;
function dailyBoundary(now, hour = DAILY_HOUR) {
  const offset = BEIJING_MS - hour * 3600000;
  return Math.floor((now + offset) / DAY_MS) * DAY_MS - offset;
}
// 返回写交接记录的原因：idle（空闲满 2 小时）、daily（跨过每天 4 点）；对话太少、上次记录后没再用过、今天已写过则为 null。
function checkpointReason({ tokens, lastActiveAt, lastCheckpointAt = 0, now = Date.now() }) {
  if (!tokens || tokens < MIN_TOKENS || !lastActiveAt || lastActiveAt <= lastCheckpointAt) return null;
  if (lastCheckpointAt >= dailyBoundary(now)) return null;
  if (now - lastActiveAt >= IDLE_MS) return 'idle';
  if (lastActiveAt < dailyBoundary(now)) return 'daily';
  return null;
}
const REASON_LABELS = { idle: '空闲超过 2 小时', daily: '跨过每天 4 点', manual: '手动新开', lean: '前台换成精简启动' };
module.exports = { IDLE_MS, DAILY_HOUR, MIN_TOKENS, dailyBoundary, checkpointReason, REASON_LABELS };
