'use strict';
// 从 Claude 原生会话记录（transcript jsonl）读出「停在哪一步」（自动续跑 P1 巡逻器）。
//
// 输出（summarize）：
//   lastKind   最后一条有意义记录的类型：
//              turn-end 回合正常结束 / api-error 报错后停 / partial-reply 回复写到一半没有回合结束 / tool-pending 工具调用没返回 /
//              tool-result-unanswered 工具结果回来了没下文 / notification-unanswered 后台通知来了没回应 /
//   lastAt     那条记录的时间（毫秒）；errorText / errorClass（quota 额度 / auth 登录 / network 网络或服务端）
//   lastAssistantText  最近一条助手文字（判「在等拍板」「说了等结果」用）
//   bgPending  还挂着的后台任务数（run_in_background 启动、没等到完成通知的）；orphanExit 通知里写着「上个 Claude 进程退出了」
const SKIP_TYPES = new Set(['file-history-snapshot', 'cost-state', 'tools-used', 'last-prompt', 'ai-title', 'mode', 'permission-mode',
  'session-owner', 'atis-latch', 'queue-operation', 'attachment', 'summary', 'custom-title', 'tag']);
const SKIP_SYSTEM = new Set(['stop_hook_summary', 'away_summary', 'local_command', 'bridge_status']);
const ERR_RE = /^API Error|hit your (?:session |5-hour |weekly )?limit|You've hit your|reached your .{0,20}limit|limit · resets|OAuth token|Please run \/login/i;
const QUOTA_RE = /limit|resets|usage-credits|额度/i;
const AUTH_RE = /\b401\b|\b403\b|\/login|OAuth|Verification|authenticat|token (?:revoked|expired)|account .{0,20}(?:disabled|suspended)/i;
const DONE_STATUS = /<status>\s*(completed|failed|killed|stopped|error|cancelled|canceled)\s*<\/status>/i;
const ORPHAN_RE = /previous Claude Code process exited/i;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => part && part.type === 'text' ? String(part.text || '') : '').filter(Boolean).join('\n');
}
function toolResultText(part) {
  const c = part && part.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (x && x.type === 'text' ? x.text : '')).join('\n');
  return '';
}
const timeOf = entry => { const t = Date.parse(entry && entry.timestamp); return Number.isFinite(t) ? t : null; };

function parseLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line || line[0] !== '{' || line.startsWith('{"type":"api-request')) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function classifyError(text) {
  const s = String(text || '');
  if (AUTH_RE.test(s)) return 'auth';
  if (QUOTA_RE.test(s)) return 'quota';
  return 'network';
}

// 判一条记录是不是「有意义」的，以及是什么。返回 null 表示跳过。
function kindOf(entry) {
  if (!entry || SKIP_TYPES.has(entry.type) || String(entry.type || '').startsWith('api-request')) return null;
  const msg = entry.message && typeof entry.message === 'object' ? entry.message : null;
  if (entry.type === 'system') {
    const sub = entry.subtype;
    if (SKIP_SYSTEM.has(sub)) return null;
    if (sub === 'turn_duration') return { kind: 'turn-end-marker' };
    if (sub === 'compact_boundary') return { kind: 'compact' };
    if (sub === 'api_error') return { kind: 'api-error', text: String(entry.content || JSON.stringify(entry.error || '')).slice(0, 300) };
    if (sub === 'informational' && /limit/i.test(String(entry.content || ''))) return { kind: 'api-error', text: String(entry.content || '').slice(0, 300) };
    return null;
  }
  if (entry.type === 'assistant') {
    const content = msg && msg.content;
    const text = textOf(content);
    if (entry.isApiErrorMessage || ERR_RE.test(text.trim())) return { kind: 'api-error', text: text.slice(0, 300) };
    const parts = Array.isArray(content) ? content : [];
    if (parts.some(p => p && p.type === 'tool_use')) return { kind: 'tool-pending', text };
    if (!text.trim()) return { kind: 'assistant-thinking' };
    return { kind: 'partial-reply', text };
  }
  if (entry.type === 'user') {
    if (entry.isMeta) return null;
    const content = msg && msg.content;
    const parts = Array.isArray(content) ? content : [];
    if (parts.some(p => p && p.type === 'tool_result')) return { kind: 'tool-result-unanswered', text: parts.map(toolResultText).join('\n').slice(0, 400) };
    const text = textOf(content).trim();
    if (!text) return null;
    if (text.startsWith('<local-command-caveat>') || /^<local-command-stdout><\/local-command-stdout>$/.test(text)) return null;
    if (text.startsWith('<task-notification>')) return { kind: 'notification-unanswered', text: text.slice(0, 600) };
    if (/<command-name>\/compact|Compacted \(ctrl\+o/.test(text) || text.startsWith('This session is being continued from a previous conversation')) return { kind: 'compact', text: text.slice(0, 200) };
    if (text.startsWith('<command-name>') || text.startsWith('<local-command-stdout>')) return { kind: 'local-command', text: text.slice(0, 200) };
    if (/^\[Request interrupted by user/.test(text)) return { kind: 'interrupted', text };
    if (text.startsWith('<system-reminder>')) return null;
    return { kind: 'message-unanswered', text: text.slice(0, 200), prompt: true };
  }
  return null;
}

// until：只看这个时刻之前的记录（离线回放用）；不传 = 全部。
function summarize(entries, { until = Infinity } = {}) {
  const state = { lastKind: 'none', lastAt: null, lastText: '', errorText: '', errorClass: null, lastAssistantText: '',
    lastAssistantAt: null, bgPending: 0, orphanExit: false, turnEnded: false, lastPromptAt: null, preCompactKind: null };
  const launched = new Map(); // tool_use id → 等结果里的后台任务 id
  const pendingIds = new Set();
  let last = null, prevMeaningful = null;
  for (const entry of entries) {
    const at = timeOf(entry);
    if (at != null && at >= until) break;
    // 后台任务：Bash / Agent 带 run_in_background 的启动；完成通知里带 task-id 和终态。
    const msg = entry && entry.message;
    if (entry && entry.type === 'assistant' && msg && Array.isArray(msg.content)) {
      for (const p of msg.content) if (p && p.type === 'tool_use' && p.input && p.input.run_in_background === true) launched.set(p.id, null);
    }
    if (entry && entry.type === 'user' && msg && Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (p && p.type === 'tool_result' && launched.has(p.tool_use_id)) {
          const m = /background with ID:\s*([A-Za-z0-9_-]+)/.exec(toolResultText(p));
          if (m) { launched.set(p.tool_use_id, m[1]); pendingIds.add(m[1]); }
        }
      }
    }
    const k = kindOf(entry);
    if (!k) continue;
    if (k.kind === 'notification-unanswered') {
      const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(k.text);
      if (id && DONE_STATUS.test(k.text)) pendingIds.delete(id[1]);
      if (ORPHAN_RE.test(k.text)) pendingIds.clear();
    }
    if (k.kind === 'assistant-thinking') continue;
    if (k.kind === 'partial-reply' || k.kind === 'tool-pending' || k.kind === 'api-error') {
      if (k.text && k.kind !== 'api-error') { state.lastAssistantText = k.text; state.lastAssistantAt = at; }
    }
    if (k.prompt) state.lastPromptAt = at;
    // 压缩前停在哪一步（回合已结束 / 回合中途）：压缩本身不算停住，要看压缩前。
    if (k.kind === 'compact' && last && last.kind !== 'compact') state.preCompactKind = last.kind === 'turn-end-marker' ? 'turn-end' : last.kind;
    else if (k.kind !== 'compact') state.preCompactKind = null;
    prevMeaningful = last;
    last = { ...k, at };
  }
  state.bgPending = pendingIds.size;
  if (!last) return state;
  let kind = last.kind, text = last.text || '';
  if (kind === 'turn-end-marker') {
    // 回合结束标记：看它前面那条——报错结束的仍算报错后停。
    if (prevMeaningful && prevMeaningful.kind === 'api-error') { kind = 'api-error'; text = prevMeaningful.text; }
    else kind = 'turn-end';
    state.turnEnded = true;
  }
  state.lastKind = kind; state.lastAt = last.at; state.lastText = String(text).slice(-400);
  if (kind === 'api-error') { state.errorText = String(text).slice(0, 300); state.errorClass = classifyError(text); }
  if (kind === 'notification-unanswered') state.orphanExit = ORPHAN_RE.test(text);
  return state;
}

// 读记录末尾一段（默认 512 KB，丢掉被截断的首行）。按 size+mtime 缓存。
const tailCache = new Map();
function readTailEntries(file, { bytes = 512 * 1024, fsModule = require('node:fs') } = {}) {
  if (!file) return [];
  let st;
  try { st = fsModule.statSync(file); } catch { tailCache.delete(file); return []; }
  const hit = tailCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.entries;
  let text = '';
  const fd = fsModule.openSync(file, 'r');
  try {
    const start = Math.max(0, st.size - bytes), buf = Buffer.alloc(st.size - start);
    fsModule.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } finally { fsModule.closeSync(fd); }
  const entries = parseLines(text);
  tailCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, entries });
  if (tailCache.size > 64) tailCache.delete(tailCache.keys().next().value); // 只缓存打开着的会话，几十个足够
  return entries;
}

module.exports = { parseLines, summarize, kindOf, classifyError, textOf, readTailEntries };
