'use strict';

// 「上轮未完成」：会话的 CLI 进程已经不在（Hub 重启、CLI 被杀、崩溃），而原生记录
// 显示最后一轮开了头却没有收尾。这类会话以前在侧栏和普通空闲一模一样，负责人与
// 用户都会把它当成"做完了"。2026-11-05 生产对照：52 个近期会话里 2 个属于此类，
// 均为旧 Hub 结束时正在执行工具或刚收到后台任务通知。
//
// 只读原生记录尾部，只给出标记，不续跑、不重发（未知提交不自动重发）。
// 有进程在跑的会话由运行时状态机负责，这里不判。

const fs = require('fs');

const TAIL_BYTES = 512 * 1024;
// 记录最后一次写入距今不足这个时长时不下结论：进程可能刚退出、记录还在落盘。
const MIN_QUIET_MS = 3 * 60 * 1000;

const CLAUDE_KINDS = new Set(['claude', 'claude-resume', 'deepseek-claude']);
const CODEX_KINDS = new Set(['codex', 'codex-resume']);

function familyOf(kind) {
  const k = String(kind || '');
  if (CLAUDE_KINDS.has(k)) return 'claude';
  if (CODEX_KINDS.has(k)) return 'codex';
  return null;
}

function parseLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 尾部截断的半行 */ }
  }
  return out;
}

function timeOf(entry) {
  const t = Date.parse(entry && entry.timestamp);
  return Number.isFinite(t) ? t : 0;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const first = content.find(part => part && typeof part.text === 'string');
  return first ? first.text : '';
}

// 本地斜杠命令的回显不触发模型，不算开了一轮。
const LOCAL_COMMAND_RE = /^\s*<(command-name|command-message|local-command-stdout|local-command-stderr|local-command-caveat)>/;

function claudeEntryEffect(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type === 'system') {
    if (entry.subtype === 'turn_duration' || entry.subtype === 'stop_hook_summary') return { close: 'turn-end' };
    // 手动 /compact 结束后 CLI 等用户输入；自动压缩可能发生在一轮中间，之后会接着干。
    if (entry.subtype === 'compact_boundary' && (entry.compactMetadata && entry.compactMetadata.trigger) !== 'auto') return { close: 'manual-compact' };
    return null;
  }
  if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return null;
  const message = entry.message || {};
  const content = message.content;
  if (entry.type === 'assistant') {
    if (entry.isApiErrorMessage) return { close: 'api-error' };
    const stop = message.stop_reason;
    if (stop === 'tool_use') return { open: 'tool-pending' };
    if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens' || stop === 'refusal') return { close: 'assistant-end' };
    return null;
  }
  if (entry.type === 'user') {
    if (Array.isArray(content) && content.some(part => part && part.type === 'tool_result')) {
      return { open: 'tool-result-unanswered', evidence: textOf(content.map(p => ({ text: typeof p.content === 'string' ? p.content : textOf(p.content) }))) };
    }
    const text = textOf(content);
    if (text.trimStart().startsWith('[Request interrupted by user')) return { close: 'user-interrupt' };
    if (LOCAL_COMMAND_RE.test(text)) return null;
    if (!text.trim()) return null;
    const notice = entry.origin && entry.origin.kind === 'task-notification' || text.trimStart().startsWith('<task-notification>');
    // 恢复会话时 CLI 补写的「上个进程留下的后台命令没收尾」通知（单条或 orphan 汇总）：
    // 说的是旧进程，之前那一轮已经收尾，本身不是交给 AI 的新任务。2026-11-05 生产样本里
    // 两个会话的上一轮都正常收尾、在等用户点头，只因为这条补写通知而像是"没回复"。
    if (notice && (text.includes('__orphan_summary__') || text.includes('before the previous session ended'))) return null;
    return { open: notice ? 'notification-unanswered' : 'prompt-unanswered', evidence: text };
  }
  return null;
}

function classifyClaudeEntries(entries) {
  let open = null;
  let lastAt = 0;
  let sawTurn = false;
  for (const entry of entries) {
    lastAt = Math.max(lastAt, timeOf(entry));
    const effect = claudeEntryEffect(entry);
    if (!effect) continue;
    sawTurn = true;
    if (effect.close) open = null;
    else if (effect.open) open = { reason: effect.open, at: timeOf(entry), evidence: effect.evidence || '' };
  }
  if (!sawTurn) return { state: 'unknown', lastAt };
  if (!open) return { state: 'finished', lastAt };
  return { state: 'unfinished', lastAt, reason: open.reason, openedAt: open.at, evidence: cleanEvidence(open.evidence) };
}

function classifyCodexEntries(entries) {
  let open = null;
  let lastAt = 0;
  let sawTurn = false;
  for (const entry of entries) {
    lastAt = Math.max(lastAt, timeOf(entry));
    if (!entry || entry.type !== 'event_msg') continue;
    const type = entry.payload && entry.payload.type;
    if (type === 'task_started') { sawTurn = true; open = { at: timeOf(entry) }; }
    else if (type === 'task_complete' || type === 'turn_aborted') { sawTurn = true; open = null; }
  }
  if (!sawTurn) return { state: 'unknown', lastAt };
  if (!open) return { state: 'finished', lastAt };
  return { state: 'unfinished', lastAt, reason: 'task-not-complete', openedAt: open.at, evidence: '' };
}

function cleanEvidence(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

const REASON_TEXT = {
  'tool-pending': '工具调用发出后没有结果',
  'tool-result-unanswered': '工具已返回结果，AI 没有接着回复',
  'notification-unanswered': '收到后台任务通知，AI 没有处理',
  'prompt-unanswered': '收到消息，AI 没有回复',
  'task-not-complete': '本轮开始后没有完成记录',
};

function describeUnfinished(result) {
  return `上轮没做完进程就停了：${REASON_TEXT[result.reason] || '本轮没有收尾'}。打开会话发「继续」即可接着做。`;
}

const TAIL_CACHE_LIMIT = 600;
const tailCache = new Map(); // path -> { size, mtimeMs, result }

async function readTail(filePath, bytes = TAIL_BYTES) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    let text = buffer.toString('utf8');
    if (length < stat.size) text = text.slice(text.indexOf('\n') + 1);
    return { text, mtimeMs: stat.mtimeMs, size: stat.size };
  } finally { await handle.close(); }
}

async function classifyTranscript({ kind, transcriptPath }, { now = Date.now(), minQuietMs = MIN_QUIET_MS } = {}) {
  const family = familyOf(kind);
  if (!family) return { state: 'unsupported' };
  const file = String(transcriptPath || '');
  if (!file || !/\.jsonl$/i.test(file)) return { state: 'unknown' };
  let base;
  try {
    const stat = await fs.promises.stat(file);
    const cached = tailCache.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.family === family) base = cached.result;
    else {
      const tail = await readTail(file);
      const entries = parseLines(tail.text);
      const parsed = family === 'claude' ? classifyClaudeEntries(entries) : classifyCodexEntries(entries);
      base = { ...parsed, lastAt: Math.max(parsed.lastAt || 0, tail.mtimeMs || 0) };
      tailCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, family, result: base });
      if (tailCache.size > TAIL_CACHE_LIMIT) tailCache.delete(tailCache.keys().next().value);
    }
  } catch { return { state: 'unknown' }; }
  if (base.state === 'unfinished' && now - base.lastAt < minQuietMs) return { state: 'settling', lastAt: base.lastAt };
  if (base.state !== 'unfinished') return { state: base.state, lastAt: base.lastAt };
  return { ...base, message: describeUnfinished(base) };
}

// isLive(id) 为真表示 Hub 里有这个会话的进程，交给运行时状态机。
async function scanUnfinishedTurns(items, { isLive = () => false, now = Date.now(), minQuietMs = MIN_QUIET_MS } = {}) {
  const out = {};
  for (const item of Array.isArray(items) ? items.slice(0, 400) : []) {
    const id = item && String(item.id || '');
    if (!id) continue;
    if (isLive(id)) { out[id] = { state: 'live' }; continue; }
    out[id] = await classifyTranscript(item, { now, minQuietMs });
  }
  return out;
}

module.exports = {
  MIN_QUIET_MS,
  classifyClaudeEntries,
  classifyCodexEntries,
  classifyTranscript,
  describeUnfinished,
  familyOf,
  parseLines,
  scanUnfinishedTurns,
};
