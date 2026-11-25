'use strict';
// 赛马成绩单：参赛轮全员交付后，Hub 亲自核对每个候选提交、统计改动规模、
// 依次跑项目声明的测试闸门，写成一份 Markdown，作为裁判轮的固定输入。
// 只给事实，不打分；评分与推荐交给裁判。
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const Gate = require('./delivery-gate');

const LABELS = 'ABCDEFGHIJ';
function git(cwd, args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim(); }
function trunkOf(worktree) {
  try { return JSON.parse(fs.readFileSync(path.join(worktree, '.agents', 'project.json'), 'utf8')).trunk || 'master'; } catch { return 'master'; }
}
// 相对主干分叉点的改动；主干名不存在时退回与父提交比，仍给出可读的规模。
function diffStat(candidate) {
  const { worktree, sha } = candidate;
  for (const base of [`${trunkOf(worktree)}...${sha}`, `${sha}~1..${sha}`]) {
    try {
      const files = git(worktree, ['diff', '--name-only', base]).split(/\r?\n/).filter(Boolean);
      const short = git(worktree, ['diff', '--shortstat', base]);
      const num = re => Number((short.match(re) || [])[1] || 0);
      return { files, insertions: num(/(\d+) insertion/), deletions: num(/(\d+) deletion/), base };
    } catch {}
  }
  return null;
}
function minutes(ms) { return !(ms > 0) ? "—" : ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60000)} 分钟`; }
function gateText(g) {
  if (!g) return '—';
  if (g.state === 'passed') return `通过（${minutes(g.durationMs)}）`;
  if (g.state === 'failed') return `未通过：\`${g.failedCommand}\` 退出码 ${g.exitCode}`;
  if (g.state === 'skipped') return `未跑：${g.reason}`;
  return g.state;
}
/**
 * entries: [{ memberId, name, deliveryPath, elapsedMs }]，按参赛顺序。
 * 依次跑闸门（不并发，避免多份全量测试同时抢 CPU 和端口）。
 * 返回 { state: 'done', rows, markdown } 或 { state: 'cancelled' }。
 */
async function scorecard({ goal = '', entries, dir, signal, runGate = Gate.runGate }) {
  const rows = [];
  for (const [i, e] of entries.entries()) {
    const label = LABELS[i] || String(i + 1);
    let candidate = null;
    try { candidate = e.deliveryPath ? Gate.parseCandidate(fs.readFileSync(e.deliveryPath, 'utf8')) : null; } catch {}
    const row = { ...e, label, candidate, stat: null, gate: null };
    if (!e.deliveryPath) { row.gate = { state: 'skipped', reason: '没有交付' }; rows.push(row); continue; }
    if (!candidate) { row.gate = { state: 'skipped', reason: '交付里没有 CANDIDATE 行（非代码任务或漏写）' }; rows.push(row); continue; }
    const pre = Gate.preflight(candidate);
    if (!pre.skipped) row.stat = diffStat(candidate);
    if (pre.skipped) row.gate = { state: 'skipped', reason: pre.skipped };
    else {
      const result = await runGate({ candidate, commands: pre.commands, logPath: path.join(dir, `race-gate-${label}.log`), signal });
      if (result.state === 'cancelled' || signal?.aborted) return { state: 'cancelled' };
      row.gate = result;
    }
    rows.push(row);
  }
  return { state: 'done', rows, markdown: render(goal, rows) };
}
function render(goal, rows) {
  const counts = new Map();
  for (const r of rows) for (const f of r.stat?.files || []) counts.set(f, (counts.get(f) || 0) + 1);
  const shared = [...counts].filter(([, n]) => n > 1).map(([f]) => f);
  const lines = ['# 赛马成绩单（Hub 实测）', '', `目标：${goal}`, '',
    '下表由 Hub 亲自核对得出：提交是否与交付一致、相对主干的改动规模、在该提交上跑项目测试命令的结果。用时从本轮派发算到 Hub 收到交付。只列事实，不打分。', '',
    '| 编号 | 参赛者 | 用时 | 候选提交 | 改动规模 | Hub 测试闸门 |', '|---|---|---|---|---|---|'];
  for (const r of rows) {
    const scale = r.stat ? `${r.stat.files.length} 个文件 +${r.stat.insertions}/-${r.stat.deletions}` : '—';
    lines.push(`| ${r.label} | ${r.name} | ${minutes(r.elapsedMs)} | ${r.candidate ? r.candidate.sha.slice(0, 10) : '—'} | ${scale} | ${gateText(r.gate)} |`);
  }
  lines.push('', '## 各候选明细', '');
  for (const r of rows) {
    lines.push(`### ${r.label} · ${r.name}`, `- 交付文件：${r.deliveryPath || '无'}`);
    if (r.candidate) lines.push(`- 候选：${r.candidate.worktree} ${r.candidate.sha}`);
    if (r.gate?.logPath) lines.push(`- 测试日志：${r.gate.logPath}`);
    if (r.stat?.files.length) lines.push(`- 改动文件：${r.stat.files.slice(0, 20).join('、')}${r.stat.files.length > 20 ? ` 等 ${r.stat.files.length} 个` : ''}`);
    lines.push('');
  }
  if (shared.length) lines.push('## 多个候选都改了的文件', '', shared.slice(0, 30).join('、'), '', '这些文件是方案分歧最集中的地方，裁判可优先对比。', '');
  return lines.join('\n');
}

module.exports = { scorecard, render, diffStat };
