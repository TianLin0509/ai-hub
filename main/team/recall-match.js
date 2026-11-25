'use strict';
// 起因：22 个团队共招 242 名成员，交付后被叫回干活的只有 18 次；「返工、接手原分支」这类活也在新招人，原作者的上下文白白丢掉。
// 业界做法（Anthropic 多智能体研究系统、Claude Code 子代理 resume）一致：同一领域接着干的叫回原来的，换领域或做审查用新的。
//
//   1. 审查类（审查 / 复审 / 审核 / 验收 / review）→ 一律新人：审查要的是没看过作者思路的新眼光。
//   2. 计划里写 fresh: true → 新人（负责人明确要新人）。
//   3. 返工类（返工 / 接手 / 原分支 / 原作者 / 继续…）→ 叫回原作者：正文里点名了 m 编号就叫它，否则叫岗位最像的那位。
//   4. 其他 → 只在岗位很像时提示负责人可以叫回谁，不自动改（岗位相似判断不准时代价是叫回了不合适的人）。
// 能叫回的老成员：本队、交付后离队、会话还在且没加入别的团队、后端相同、工作目录相同、离队不超过 48 小时、上下文不到七成满。

const RECALL_WINDOW_MS = 48 * 3600_000;
const MAX_CONTEXT_PCT = 70;
const REVIEW = /审查|复审|审核|验收|评审|review/i;
const REWORK = /返工|接手|原分支|原作者|接着做|继续做|继续修|按审查意见|根据审查意见|修审查/;
const HINT_SIMILARITY = 0.6, REWORK_SIMILARITY = 0.3;

// 岗位名去掉「（选 Codex：…）」这类选型理由，只比分工本身。
const roleCore = s => String(s || '').replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
function bigrams(s) { const t = roleCore(s).replace(/\s/g, ''); const out = new Set(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); if (t.length === 1) out.add(t); return out; }
function similarity(a, b) {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let inter = 0; for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}
const normDir = d => String(d || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// members：本队成员记录；sessionInfo(sid) -> { exists, cwd, contextPct, inOtherTeam } | null
function candidates(members, spec, { now, leadCwd, sessionInfo }) {
  const want = normDir(spec.cwd || leadCwd);
  return (members || []).filter(m => {
    if (m.status !== 'dismissed' || m.dismissReason !== 'delivered' || !m.sid || m.kind !== spec.kind) return false;
    if (!m.dismissedAt || now - m.dismissedAt > RECALL_WINDOW_MS) return false;
    const s = sessionInfo(m.sid);
    if (!s || !s.exists || s.inOtherTeam) return false;
    // Hub 自动建 worktree 的成员，会话目录是 worktree：按它来自的仓库主目录比对（2026-11-23）。
    if (want && normDir(s.cwd) !== want && normDir(m.worktree?.repo) !== want) return false;
    return !(Number(s.contextPct) >= MAX_CONTEXT_PCT);
  });
}

// 审查识别（Codex 复审 2026-11-19）：
//   - 岗位名先去掉「（选 Codex：……审查由 Claude 异构做）」这类选型说明再判，免得把修错岗位当成审查；
//   - 任务正文只认明确要它去审的说法（独立复审、做一轮审查、只读审查…）：「接手 m1 分支，独立复审」必须用新人，不能叫回作者自审；
//   - 「按审查意见修」「审查结论」说的是返工依据，不算审查。
const REVIEW_INPUT = /(按|根据|依据|针对|落实)?(审查|复审|评审|review)(意见|结论|发现|指出的?|反馈|报告)/gi;
const REVIEW_TASK = /(独立|异构|换模型|只读)\s*(审查|复审|评审|审核|review)|(做|负责|进行|来)\s*(一次|一轮|一遍)?\s*(审查|复审|评审|审核)|^\s*(审查|复审|评审|review)/i;
function classify(spec) {
  if (spec.fresh === true) return 'fresh';
  const role = roleCore(`${spec.role} ${spec.title || ''}`).replace(REVIEW_INPUT, ' ');
  const task = String(spec.task || '').replace(REVIEW_INPUT, ' ');
  if (REVIEW.test(role) || REVIEW_TASK.test(task)) return 'review';
  if (REWORK.test(`${spec.role} ${spec.title || ''} ${spec.task || ''}`)) return 'rework';
  return 'other';
}

// 返回每个计划成员的决定：{ index, action: 'new'|'recall'|'hint', memberId?, score?, reason }
function planRecalls(planMembers, team, ctx) {
  const used = new Set();
  return planMembers.map((spec, index) => {
    const kind = classify(spec);
    if (kind === 'fresh') return { index, action: 'new', reason: '计划要求新人' };
    if (kind === 'review') return { index, action: 'new', reason: '审查类一律用新人，保证独立' };
    const pool = candidates(team?.members, spec, ctx).filter(m => !used.has(m.memberId));
    if (!pool.length) return { index, action: 'new', reason: '本队没有能叫回的老成员' };
    const scored = pool.map(m => ({ m, score: similarity(`${spec.role} ${spec.title || ''}`, `${m.role} ${m.title || ''}`) })).sort((a, b) => b.score - a.score);
    if (kind === 'rework') {
      const named = [...`${spec.role} ${spec.title || ''} ${spec.task}`.matchAll(/\bm(\d+)\b/g)].map(x => 'm' + x[1]);
      const hit = pool.find(m => named.includes(m.memberId)) || (scored[0].score >= REWORK_SIMILARITY ? scored[0].m : null);
      if (hit) { used.add(hit.memberId); return { index, action: 'recall', memberId: hit.memberId, score: +(scored.find(x => x.m === hit)?.score || 0).toFixed(2), reason: named.includes(hit.memberId) ? `返工点名了 ${hit.memberId}，叫回原作者` : `返工叫回岗位最像的原成员 ${hit.memberId}` }; }
      return { index, action: 'new', reason: '返工但找不到对应的原成员' };
    }
    if (scored[0].score >= HINT_SIMILARITY) return { index, action: 'hint', memberId: scored[0].m.memberId, score: +scored[0].score.toFixed(2), reason: `${scored[0].m.memberId}（${scored[0].m.title || scored[0].m.role}）做过很像的活` };
    return { index, action: 'new', reason: '没有岗位相近的老成员' };
  });
}

// 叫回时发给老成员的开工消息：按「读者是新人」来写（任务完整，不依赖它记得旧上下文）。
function recallText(spec, member) {
  return [`【回到队里 · 新任务】你之前在本队做过「${member.title || member.role}」，现在请接着做下面这件事（上下文你应该还有印象，但以下面写的为准）。`,
    `分工：${spec.role}`, `任务：${spec.task}`,
    '完成后照旧用 send --to lead --deliver 交付；卡住、失败、要拍板加 --wake。'].join('\n');
}

module.exports = { planRecalls, recallText, similarity, classify, RECALL_WINDOW_MS, MAX_CONTEXT_PCT };
