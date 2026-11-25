'use strict';
// 负责人模式的赛马（2026-11-22）：负责人用一张 race 计划招 N 位成员做同一道题；成员交付先由 Hub 收着，
// 全部交齐（或建失败、离队）后 Hub 复用群聊赛马的成绩单逻辑核对候选、跑测试，只叫醒负责人一次，
// 送一条带成绩单路径的汇总消息——不让 N 份交付轮流叫醒负责人、占它上下文。
const fs = require('node:fs'), path = require('node:path');
const Race = require('../groupchat/race-scorecard');

const DONE_STATES = ['failed', 'dismissed', 'interrupted'];
// 掉队兜底（2026-11-22 实测：一位参赛者不交付，赛马无限等下去）：首位交付后再等这么久，其余人还没交就先出成绩单。
// 晚交的照常作为普通交付转给负责人。
const STRAGGLER_MS = 45 * 60 * 1000;

function kickoffLines({ worktreeReady = false } = {}) {
  return [
    '这是一场赛马：几位成员同时做同一道题，互不参考、互不等待，最后由负责人对照 Hub 实测的成绩单选一份采用。',
    ...(worktreeReady ? ['- 代码任务：就在上面 Hub 建好的独立 worktree 里实现；按项目规则准备依赖，不在仓库主目录改文件。'] : [
    '- 代码任务：在任务项目的独立 git worktree 实现，目录建在项目 .agents/project.json 的 worktreeRoot（没有就放项目同级目录），目录和分支都命名为「日期-时分-race-你的成员编号」（如 20261122-0130-race-m2），已存在就加后缀；按项目规则准备依赖，不在 worktree 里装包。',
    ]),
    '- 完成后提交全部改动、保持 worktree 干净，交付消息单独一行写 `CANDIDATE: <worktree 绝对路径> <完整 40 位提交 SHA>`，再写做法要点（3 行内）、实际验证与结果、已知风险。不合并、不推送、不改版本号。',
    '- 不改代码的任务（方案、分析、文稿）把成品写进文件，交付消息给路径和结论，省略 CANDIDATE 行。',
    '- 用 `send --to lead --deliver` 交付一次即可：Hub 等所有参赛者交齐后统一交给负责人，中途不要发进度汇报。',
    '',
  ];
}
function planMembers(team, plan) { return (team.members || []).filter(m => m.planId === plan.id); }
// 全员要么已交付，要么已经不可能交付（建失败、被请离、被打断）；且至少一人交付。
function ready(team, plan, { now = Date.now(), stragglerMs = STRAGGLER_MS } = {}) {
  const ms = planMembers(team, plan), done = ms.filter(m => m.raceDeliveryPath);
  if (!ms.length || !done.length) return false;
  if (ms.every(m => m.raceDeliveryPath || DONE_STATES.includes(m.status))) return true;
  const first = Math.min(...done.map(m => Number(m.raceDeliveredAt) || now));
  return now - first >= stragglerMs;
}
function stragglers(team, plan) { return planMembers(team, plan).filter(m => !m.raceDeliveryPath && !DONE_STATES.includes(m.status)); }
function recordDelivery(dir, member, text, id = Date.now().toString(36)) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${member.memberId}-交付-${id}.md`); // 每次交付单独存，返工重交不覆盖旧文件
  fs.writeFileSync(file, text, 'utf8');
  return file;
}
async function score({ team, plan, dir }) {
  const ms = planMembers(team, plan);
  const entries = ms.map(m => ({ memberId: m.memberId, name: `${m.memberId} ${m.title || ''}（${m.kind}）`.replace(/\s+（/, '（'),
    deliveryPath: m.raceDeliveryPath || '', elapsedMs: m.raceDeliveryPath ? Math.max(0, (m.raceDeliveredAt || 0) - (m.joinedAt || m.queuedAt || 0)) : 0 }));
  const file = path.join(dir, '赛马成绩单.md');
  let rows = [];
  try {
    const result = await Race.scorecard({ goal: plan.task || plan.goal, entries, dir });
    rows = result.rows || [];
    fs.writeFileSync(file, result.markdown, 'utf8');
  } catch (error) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, ['# 赛马成绩单（Hub 生成失败）', '', `Hub 没能完成候选核对与测试：${error.message}`, '', ...entries.map(e => `- ${e.name}：${e.deliveryPath || '没有交付'}`), ''].join('\n'), 'utf8');
    rows = entries.map(e => ({ ...e, gate: { state: 'skipped', reason: 'Hub 成绩单生成失败' } }));
  }
  return { file, rows };
}
function gateWord(g) {
  if (!g) return '—';
  if (g.state === 'passed') return '测试通过';
  if (g.state === 'failed') return '测试未通过';
  return `未测（${String(g.reason || '').slice(0, 40)}）`;
}
function leadMessage({ plan, file, rows, cmd, late = [], stragglerMin = STRAGGLER_MS / 60000 }) {
  const delivered = rows.filter(r => r.deliveryPath).length;
  return [
    `【赛马结果 · 计划 ${plan.id}】${delivered}/${rows.length} 位参赛者已交付。Hub 已逐个核对候选提交并亲自跑了项目测试，成绩单：${file}`,
    ...(late.length ? [`${late.join('、')} 在首位交付 ${Math.round(stragglerMin)} 分钟后仍未交付，先按已交的出成绩单；它们之后交的会作为普通交付转给你，也可以 status 看它是否卡住、send 催它。`] : []),
    ...rows.map(r => `- ${r.label || ''} ${r.name}：${gateWord(r.gate)}${r.stat ? `，${r.stat.files.length} 个文件 +${r.stat.insertions}/-${r.stat.deletions}` : ''}${r.deliveryPath ? `；交付 ${r.deliveryPath}` : '；没有交付'}`),
    '下一步：派一个不参赛的原生子 Agent 当裁判，读成绩单和各候选后只回结论（推荐哪份、评分理由、值得从落选方案嫁接的点）；你抽查 1–2 处后选定。',
    `选定后给胜者发合入指令（\`"${cmd}" send --to <编号> --message "按项目合入入口合入你的候选…"\`，Hub 会叫回它的原会话）；落选者 Hub 稍后自动离队休眠，它们的 worktree 按项目规则清理。都不满意就说明原因，可以带着裁判意见让其中一位返工。`,
  ].join('\n');
}

module.exports = { STRAGGLER_MS, kickoffLines, ready, stragglers, recordDelivery, score, leadMessage, planMembers };
