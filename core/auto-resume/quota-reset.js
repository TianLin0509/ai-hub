'use strict';
// 从 Claude 终端里的限额报错读出「几点重置」（自动续跑 P2：额度重置后续跑扩到普通终端会话）。
// 真实样本（评估数据，近 30 天）：
//   You've hit your 5-hour limit · resets 2:40pm (America/Tijuana)
//   You've hit your session limit · resets 4:40am (America/Tijuana)
//   You've hit your 5-hour limit · resets 3pm (Asia/Shanghai)
//   You've hit your weekly limit · resets 9pm (America/Tijuana)
// 也兼容带日期的写法（resets Nov 26, 3pm (…)）。没写时区按本机时区。
// 返回报错时刻之后第一次到达这个钟点的时间（毫秒）；读不出来返回 null（「You've reached your Fable limit」这类没写时间的）。
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const RESET_RE = /resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i;

// 某时区在某一刻相对 UTC 的偏移（分钟）。
function offsetMinutes(timeZone, at) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(at)).reduce((o, x) => (o[x.type] = x.value, o), {});
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60000);
}
function partsIn(timeZone, at) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at)).reduce((o, x) => (o[x.type] = x.value, o), {});
  return { y: +p.year, m: +p.month, d: +p.day };
}
// 时区里的「年月日 时分」→ 毫秒（处理夏令时：按那一刻的偏移再校一次）。
function zonedToUtc(timeZone, y, m, d, hh, mm) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let at = guess - offsetMinutes(timeZone, guess) * 60000;
  at = guess - offsetMinutes(timeZone, at) * 60000;
  return at;
}

function parseResetAt(text, messageAt = Date.now()) {
  const m = RESET_RE.exec(String(text || ''));
  if (!m) return null;
  let tz = (m[6] || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; }
  let hh = Number(m[3]) % 12; if (/pm/i.test(m[5])) hh += 12;
  const mm = Number(m[4] || 0);
  if (m[1] && MONTHS[m[1].toLowerCase()]) {
    const base = partsIn(tz, messageAt);
    let at = zonedToUtc(tz, base.y, MONTHS[m[1].toLowerCase()], Number(m[2]), hh, mm);
    if (at <= messageAt) at = zonedToUtc(tz, base.y + 1, MONTHS[m[1].toLowerCase()], Number(m[2]), hh, mm);
    return at;
  }
  const base = partsIn(tz, messageAt);
  for (let k = 0; k < 9; k++) {
    const day = new Date(Date.UTC(base.y, base.m - 1, base.d + k));
    const at = zonedToUtc(tz, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm);
    if (at > messageAt) return at;
  }
  return null;
}

module.exports = { parseResetAt, offsetMinutes };
