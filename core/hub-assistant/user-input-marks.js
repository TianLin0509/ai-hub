'use strict';
// 只在内存里：Hub 重启后清零（重启本身已打断了手上操作，不需要延续保护）。
// 订阅者（自动续跑）另收到操作种类：'input' 打字/改草稿，'submit' 亲手发出一条消息，'esc' 按停止键；
// 自动续跑把它们记到落盘的快照上，扛住 Hub 重启。
const { isHumanInput } = require('./session-control');
const last = new Map();
const typing = new Map();
const listeners = new Set();
function notify(sessionId, at, kind) { for (const fn of listeners) { try { fn(sessionId, at, kind); } catch {} } }
function mark(sessionId, at = Date.now(), kind = 'input') {
  if (!sessionId) return;
  last.set(sessionId, at); if (last.size > 500) last.delete(last.keys().next().value);
  if (kind === 'input') { typing.set(sessionId, at); if (typing.size > 500) typing.delete(typing.keys().next().value); }
  notify(sessionId, at, kind);
}
function onMark(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// 终端里敲回车 = 亲手发出一条消息。
function markTerminal(sessionId, data) {
  if (!sessionId) return;
  if (isHumanInput(data)) mark(sessionId, Date.now(), /[\r\n]/.test(String(data)) ? 'submit' : 'input');
  else if (data === '\x1b') notify(sessionId, Date.now(), 'esc');
}
function lastAt(sessionId) { return last.get(sessionId) || 0; }
function lastTypingAt(sessionId) { return typing.get(sessionId) || 0; }
module.exports = { mark, markTerminal, lastAt, lastTypingAt, onMark };
