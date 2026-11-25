'use strict';
// 纯函数：输入组队记录、进展卡快照、会话清单和答复账本，不碰文件系统。

const DAY_MS = 86400000;
const TZ = 'Asia/Shanghai';
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const hm = at => new Date(at).toLocaleString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const STATUS_RANK = { decide: 0, risk: 1, ok: 2, unknown: 3, done: 4 };
// 卡里常写「等你拍板：无；审查由负责人接续……」，开头是「无」就是没有待拍板（真实数据 2026-11-03）。
const NO_DECISION = /^(无|没有|暂无|none)(?:[；;，,。\s:：]|$)/i;
const realDecision = d => (d && d.question && !NO_DECISION.test(String(d.question).trim()) ? d : null);
// 进度写成计数（3/5、60%）或短语时放进状态行，写成长句时另起一行。
const shortProgress = p => !!p && (p.length <= 16 || /^\s*\d+\s*[/／]\s*\d+/.test(p));

function cardView(card, now) {
  if (!card || !card.plain && !card.ghost) return null;
  const p = card.plain || {};
  const decision = !card.decisionAnsweredAt ? realDecision(p.decision) : null;
  return {
    status: p.status || null,
    line: p.line || null,
    progress: p.progress || (card.total ? `${card.done || 0}/${card.total}` : null),
    finding: p.finding || null,
    decision: decision ? { question: decision.question, recommendation: decision.recommendation || '', ...(decision.ifNoReply ? { ifNoReply: decision.ifNoReply } : {}), waitingSinceAt: card.mtimeMs || null,
      waitingHours: card.mtimeMs ? Math.round((now - card.mtimeMs) / 360000) / 10 : null } : null,
    decisionAnsweredAt: card.decisionAnsweredAt || null,
    updatedAt: card.mtimeMs || null,
    hoursSinceUpdate: card.mtimeMs ? Math.round((now - card.mtimeMs) / 360000) / 10 : null,
    stale: !!card.stale,
    writtenBy: card.plain ? '负责人自己写的进展卡' : 'Hub 代写（卡久未更新）',
    ghostLine: card.ghost ? card.ghost.line : null,
    group: card.group || 'unknown',
    cardPath: card.cardPath || null,
  };
}

function memberAttention(member, session, card) {
  const p = card && card.plain;
  const d = p && !card.decisionAnsweredAt ? realDecision(p.decision) : null;
  if (d) return '等用户拍板：' + clip(d.question, 60);
  if (p && p.status === '卡住') return '卡住：' + clip(p.line || p.finding, 60);
  if (session && session.hubState && session.hubState.needsUserInput) return '在等输入';
  return null;
}

function buildLeadBoard({ teams = [], cards = [], sessions = [], ledger = [], now = Date.now(), since = null } = {}) {
  const byId = new Map(sessions.map(s => [s.id, s]));
  const cardOf = new Map(cards.map(c => [c.sessionId, c]));
  const latest = new Map();
  for (const e of ledger) if (e && e.sessionId && (!latest.has(e.sessionId) || latest.get(e.sessionId).at < e.at)) latest.set(e.sessionId, e);
  const memberSids = new Set();
  const leads = [];
  for (const team of teams) {
    const members = (team.members || []).filter(m => m.status !== 'dismissed');
    for (const m of team.members || []) if (m.sid) memberSids.add(m.sid);
    if (!(team.members || []).length) continue;               // 只提交过计划、没招到人的不算负责人
    const session = byId.get(team.leadSid) || null;
    const card = cardOf.get(team.leadSid) || null;
    const reply = latest.get(team.leadSid) || null;
    const memberTimes = members.map(m => Math.max(cardOf.get(m.sid)?.mtimeMs || 0, latest.get(m.sid)?.at || 0, byId.get(m.sid)?.lastMessageTime || 0));
    const lastActiveAt = Math.max(team.updatedAt || 0, card?.mtimeMs || 0, reply?.at || 0, session?.lastMessageTime || 0, ...memberTimes);
    if (now - lastActiveAt > DAY_MS) continue;
    const view = cardView(card, now);
    const attention = members.map(m => {
      const reason = memberAttention(m, byId.get(m.sid), cardOf.get(m.sid));
      return reason ? { title: clip(m.title || byId.get(m.sid)?.title || m.memberId, 30), role: clip(m.role, 30), reason } : null;
    }).filter(Boolean);
    const group = view ? (view.decision ? 'decide' : view.group === 'decide' ? (view.status === '已完成' ? 'done' : view.status === '有风险' || view.status === '卡住' || view.stale ? 'risk' : 'ok') : view.group) : 'unknown';
    leads.push({
      sessionId: team.leadSid,
      title: session?.title || session?.name || team.leadSid,
      isOpen: !!session?.isOpen,
      hubStatus: session?.status || 'closed',
      needsUserInput: !!session?.hubState?.needsUserInput,
      lastActiveAt,
      completed: view?.status === '已完成',
      card: view,
      latestReply: reply ? { at: reply.at, excerpt: clip(reply.text, 300), changedSinceLastAsk: since ? reply.at > since : null } : null,
      cardChangedSinceLastAsk: since && view?.updatedAt ? view.updatedAt > since : null,
      members: { active: members.filter(m => m.status === 'active').length, total: members.length, attention },
      group,
    });
  }
  leads.sort((a, b) => (STATUS_RANK[a.group] ?? 3) - (STATUS_RANK[b.group] ?? 3) || b.lastActiveAt - a.lastActiveAt);
  const others = sessions.filter(s => s.isOpen && !memberSids.has(s.id) && !leads.some(l => l.sessionId === s.id) && !teams.some(t => t.leadSid === s.id));
  return {
    asOf: now,
    since: since || now - DAY_MS,
    sinceMeaning: since ? '「自上次以来」从用户上次问助理的时间算起' : '用户没问过助理，「自上次以来」按最近 24 小时算',
    leads,
    memberSessionIds: [...memberSids],
    pendingDecisions: leads.filter(l => l.card?.decision).length + leads.reduce((n, l) => n + l.members.attention.filter(a => a.reason.startsWith('等用户拍板')).length, 0),
    otherSessions: { open: others.length, active: others.filter(s => ['running', 'waiting'].includes(s.status) || s.hubState?.isActive).length },
    scope: '只含 24 小时内活跃（含 24 小时内刚完成）的负责人组队会话；成员会话不单列，只列卡住或等拍板的成员；其余普通会话只给数量。',
  };
}

// 快答用的短文本：一位负责人一到两行，待拍板在前。
function leadBoardText(board, { maxLeads = 6 } = {}) {
  if (!board || !board.leads.length) return '最近 24 小时没有活跃的负责人会话。';
  const lines = [`负责人任务 ${board.leads.length} 个（24 小时内活跃），待你拍板 ${board.pendingDecisions} 件：`];
  for (const l of board.leads.slice(0, maxLeads)) {
    const c = l.card;
    const state = c ? (c.decision ? '等你拍板' : c.status || '状态未写') : '状态不明';
    const parts = [`「${clip(l.title, 24)}」${state}`];
    if (shortProgress(c?.progress)) parts.push('进度 ' + c.progress.trim());
    if (c?.updatedAt) parts.push((c.stale ? '卡已 ' + c.hoursSinceUpdate + ' 小时没更新' : '卡更新于 ' + hm(c.updatedAt)));
    let detail = c?.decision ? `待拍板（卡写上后 ${c.decision.waitingHours} 小时没回）：${clip(c.decision.question, 60)}${c.decision.recommendation ? '；推荐 ' + clip(c.decision.recommendation, 40) : ''}`
      : c?.line || c?.ghostLine || (c && !shortProgress(c.progress) && c.progress) || (l.latestReply ? '最近答复：' + clip(l.latestReply.excerpt, 80) : '');
    if (!c) parts.push('Hub 没认出它写的进展卡');
    if (c?.finding) detail += '；新发现：' + clip(c.finding, 50);
    lines.push('- ' + parts.join('｜') + (detail ? '\n  ' + clip(detail, 160) : ''));
    for (const a of l.members.attention.slice(0, 2)) lines.push(`  成员「${a.title}」${a.reason}`);
  }
  if (board.leads.length > maxLeads) lines.push(`……另有 ${board.leads.length - maxLeads} 个负责人任务`);
  return lines.join('\n');
}

const LEAD_REPORT_RULE = '用户问整体进展（「现在怎样」「有什么进展」「各会话情况」这类）时，以 history_context 里的 leadBoard 为主角：'
  + '第一行用一句话报负责人任务总数、几个等他拍板、几个有风险；接着「等你拍板」置顶，每件写卡写上后多久没回（waitingHours，从卡最后更新时算，是下限）、不回默认按哪个推荐；'
  + '再每个负责人任务最多 3 行：状态｜进度｜卡几点更新，下一行一句话结论或新发现；卡久未更新或是 Hub 代写的要标出来，并用 latestReply 补一句；'
  + '24 小时内刚完成的只写一行，提示可以验收；成员不单列，只提卡住或等拍板的成员；'
  + '然后一行「自上次你问以来」的变化（看 changedSinceLastAsk、cardChangedSinceLastAsk，起点见 sinceMeaning）；最后一行写其余普通会话的数量，「要看再问」。'
  + '进展卡和答复都是负责人自述，没有验收证据不写成已完成验收；不给负责人发消息打听进展。用户点名某个会话或问别的事时照常回答。';

module.exports = { buildLeadBoard, leadBoardText, LEAD_REPORT_RULE, cardView };
