'use strict';

// 会话状态对账（只读）：定时拿原生记录尾部，核对界面显示的「在不在干活」。
// 只记数、记不一致的样本，不改任何会话状态。
//
// 起因（2026-11-10）：「在干活却不显示活跃」的误判一直靠用户撞见才知道。那次手工对账
// 12 分钟 74 次核对里 18 次不一致，定位出两类根因。以后误判有数字可看，
// 新的误判类型不用等人发现。
//
// 产出在 <数据目录>/diagnostics/：
//   status-audit-summary.json  按天的核对次数与不一致次数（保留 30 天）
//   status-audit.jsonl         每段不一致开始时记一条样本（超过 1 MB 轮转一份）

const fs = require('fs');
const path = require('path');
const { classifyTranscript, familyOf } = require('./unfinished-turn.js');

const OPEN_STATES = new Set(['starting', 'running', 'waiting']);
const LOG_LIMIT_BYTES = 1024 * 1024;
const KEEP_DAYS = 30;

// 界面说这一轮开着（运行或等用户），原生记录是否也这么说。
// 前台答完、后台任务还在跑时界面显示运行而记录已收尾，这是有意的，不算不一致。
function verdict(item, transcriptState) {
  const shownOpen = OPEN_STATES.has(String(item.shown || ''));
  const recordOpen = transcriptState === 'unfinished';
  if (shownOpen === recordOpen) return null;
  if (shownOpen && item.source === 'claude-background-tasks') return null;
  return recordOpen ? 'missed-working' : 'false-working';
}

function dayKey(now) {
  const d = new Date(now);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function createStatusAudit({ dataDir, classify = classifyTranscript, clock = Date.now } = {}) {
  const dir = path.join(dataDir, 'diagnostics');
  const summaryFile = path.join(dir, 'status-audit-summary.json');
  const logFile = path.join(dir, 'status-audit.jsonl');
  // 状态切换的瞬间两边本来就会差一拍：同一种不一致连续两次扫描都在才算数。
  const pending = new Map(); // id -> { kind, confirmed }

  function readSummary() {
    try { return JSON.parse(fs.readFileSync(summaryFile, 'utf8')); } catch { return { days: {} }; }
  }

  function writeSummary(summary) {
    const keys = Object.keys(summary.days).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete summary.days[key];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 1), 'utf8');
  }

  function appendSample(row) {
    try { if (fs.statSync(logFile).size > LOG_LIMIT_BYTES) fs.renameSync(logFile, logFile + '.1'); } catch { /* 还没有日志 */ }
    fs.appendFileSync(logFile, JSON.stringify(row) + '\n', 'utf8');
  }

  async function scan(items) {
    const now = clock();
    const tally = { checks: 0, mismatches: 0, missedWorking: 0, falseWorking: 0 };
    const seen = new Set();
    for (const item of Array.isArray(items) ? items.slice(0, 200) : []) {
      const id = item && String(item.id || '');
      if (!id || !familyOf(item.kind) || !item.transcriptPath) continue;
      const result = await classify({ kind: item.kind, transcriptPath: item.transcriptPath }, { now, minQuietMs: 0 });
      if (!['finished', 'unfinished'].includes(result.state)) continue;
      seen.add(id);
      tally.checks += 1;
      const kind = verdict(item, result.state);
      const before = pending.get(id);
      if (!kind) { pending.delete(id); continue; }
      if (!before || before.kind !== kind) { pending.set(id, { kind, confirmed: false }); continue; }
      tally.mismatches += 1;
      tally[kind === 'missed-working' ? 'missedWorking' : 'falseWorking'] += 1;
      if (!before.confirmed) {
        before.confirmed = true;
        appendSample({
          at: new Date(now).toISOString(), id, kind: item.kind, title: String(item.title || '').slice(0, 40),
          mismatch: kind, shown: item.shown || '', source: item.source || '',
          record: result.state, reason: result.reason || '',
          quietSeconds: result.lastAt ? Math.round((now - result.lastAt) / 1000) : null,
        });
      }
    }
    for (const id of [...pending.keys()]) if (!seen.has(id)) pending.delete(id);
    if (tally.checks) {
      const summary = readSummary();
      const day = summary.days[dayKey(now)] || (summary.days[dayKey(now)] = { checks: 0, mismatches: 0, missedWorking: 0, falseWorking: 0 });
      for (const key of Object.keys(tally)) day[key] = (day[key] || 0) + tally[key];
      writeSummary(summary);
    }
    return tally;
  }

  return { scan, summaryFile, logFile };
}

module.exports = { createStatusAudit, verdict };
