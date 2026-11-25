'use strict';
// 纯函数：输入任务清单（front-client.tasks 的行）、组队记录、进展卡、待定编号，输出两个 Tab 要的东西，不碰文件和 IPC。
//
// - 来源可信：负责人进展卡「等你拍板」写了问题（source=card）；或待定编号生成时就有卡片依据。
// - 只靠关键词猜出来的编号（source=keyword，含没有来源记录的旧编号且卡上已无拍板）不进主列表，放进「待核实」折叠区，照样能回。
// - 撤下只看四种事件：已答复、负责人撤回或被新问题替代、任务结束（编号层已处理）；会话又开始干活不算撤下。
// - 等了超过 24 小时：灰色「等待较久，待确认」，不计角标，防止没人管的条目一直顶着红点。
// - 每个会话最多 1 条（编号优先于卡片），主列表最多 MAX_MAIN 条，其余折叠。
//
// 没写卡才用最近答复的结论。顶部给一段程序拼出来的白话概述，不调模型、打开就有。

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MAX_MAIN = 5;
const STALE_MS = DAY;
const READ_GRACE_MS = 5000;

const NO_DECISION = /^(无|没有|暂无|none)(?:[；;，,。\s:：（(]|$)/i;
const EXPIRE_MS = 7 * DAY; // 与待定编号同一时限（decisions.js）

const clip = (s, n) => { const c = [...String(s || '').replace(/\s+/g, ' ').trim()]; return c.length > n ? c.slice(0, n).join('') + '…' : c.join(''); };

function ago(ms) {
  if (!(ms >= 0)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

// 问题里写了「A：…；B：…」或「方案1 / 方案2」时给出对应选项按钮；否则只给「按推荐 / 先不做」。
function optionsOf(question, recommendation) {
  const q = String(question || '');
  const picks = [];
  const re = /(?:^|[\s，,；;。：:（(])(?:方案\s*)?([A-Da-d]|[1-4])\s*[:：、.)）]/g;
  let m;
  while ((m = re.exec(q))) { const k = m[1].toUpperCase(); if (!picks.includes(k)) picks.push(k); }
  const opts = [];
  if (recommendation) opts.push({ action: 'recommend', label: '按推荐' });
  if (picks.length >= 2) for (const k of picks) opts.push({ action: 'pick', pick: k, label: `选 ${k}` });
  opts.push({ action: 'skip', label: '先不做' });
  return opts;
}

function realDecision(d) { return d && d.question && !NO_DECISION.test(String(d.question).trim()) ? d : null; }

function teamIndex(teams) {
  const leadOf = new Map(), teamOfLead = new Map();
  for (const t of teams || []) {
    if (!t || !t.leadSid || !(t.members || []).length) continue;
    teamOfLead.set(t.leadSid, t);
    for (const m of t.members) if (m && m.sid) leadOf.set(m.sid, t.leadSid);
  }
  return { leadOf, teamOfLead };
}

// 问题明确是「重启 / 升级 / 更新到某个 Hub 版本」，而且这些目标版本都已经装上：这一问过时了（例：「什么时候重启 Hub 到 1.6.966？」）。
// 只认「到 / 至 + 版本号」这种目标写法，整版本号比较（含大版本）；「1.6.975 有问题要不要回滚」「从 1.6.975 升到 2.0.0」都不算（复审第 1 项）。
// 而且问的只能是「什么时候 / 要不要去重启升级」这件事本身：提到回滚、验收、丢数据、故障这类另有要定的事，就照常显示（复验第 1 项）。
function versionReached(text, current) {
  const cur = String(current || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!cur) return false;
  if (/回滚|退回|验收|确认效果|丢|损坏|故障|报错|异常|失败|问题|bug|风险|是否正常|有没有/i.test(String(text || ''))) return false;
  // 版本号必须是整句问话的落点：后面只剩「版 / 吗 / 了吗 / 呢」和标点。「已升级到 1.6.975，公司版是否同步发布？」后面还有别的事，不算（复验 A）。
  const targets = [...String(text || '').matchAll(/(?:重启|升级|更新|升|装|换)[^，。；？?！!\n]{0,12}?(?:到|至)\s*v?(\d+)\.(\d+)\.(\d+)(?![\d.])\s*(?:版本?)?\s*(?:了吗|吗|呢|了)?\s*[？?。！!]*\s*$/gi)];
  if (!targets.length) return false;
  const le = v => { for (let i = 1; i <= 3; i++) { const a = Number(v[i]), b = Number(cur[i]); if (a !== b) return a < b; } return true; };
  return targets.every(le);
}

// 跳过记录的键：会话 + 问句 + 推荐（全文）。
function skipKey(sessionId, question, recommendation) { return require('node:crypto').createHash('sha256').update([sessionId, question || '', recommendation || ''].join('|')).digest('hex').slice(0, 16); }

// 跳过用的「同一段话」：去掉空白后完全相同；只有一方带截断省略号（待定编号把问句截到 120 字、推荐截到 80 字，末尾加「…」）时，
// 才允许它是另一方的开头。没有截断标记的两段全文必须完全相同——旧问题后面追加了新要求就是新的一问（复审第 2、3 项）。
// 有方向（复验第 2 项）：记录是全文、条目是截断的编号 → 记录以条目开头即可；两边都截断 → 互为开头；
// 记录本身是截断的、条目是全文 → 不算（截断记录分不出尾部改没改，宁可让它出现）。所以跳过时尽量存全文（见编号补全文）。
function sameText(recText, itemText) {
  const a = String(recText || '').replace(/\s+/g, ''), b = String(itemText || '').replace(/\s+/g, '');
  if (a === b) return true;
  const ca = a.endsWith('…') ? a.slice(0, -1) : null, cb = b.endsWith('…') ? b.slice(0, -1) : null;
  if (ca && cb) return ca.startsWith(cb) || cb.startsWith(ca);
  if (cb) return a.startsWith(cb);
  return false;
}
// 一条跳过记录是不是这一问（同会话、问句和推荐都是同一段话）。
function askMatches(rec, sessionId, question, recommendation) { return !!rec && rec.sessionId === sessionId && sameText(rec.question, question) && sameText(rec.recommendation, recommendation); }

// sessions：会话号 → { open, closedByUser }（可缺省，缺省时不做「会话已关」判断）。appVersion：当前 Hub 版本。
function buildOverview({ tasks = [], teams = [], cards = [], decisions = [], answered = [], parks = {}, skips = [], sessions = null, appVersion = '', now = Date.now() } = {}) {
  const cardOf = new Map((cards || []).filter(c => c && c.sessionId).map(c => [c.sessionId, c]));
  const rowOf = new Map((tasks || []).map(r => [r.id, r]));
  const { leadOf, teamOfLead } = teamIndex(teams);
  const info = sid => sessions ? (typeof sessions.get === 'function' ? sessions.get(sid) : sessions[sid]) : undefined;
  const titleOf = sid => rowOf.get(sid)?.title || info(sid)?.title || teamOfLead.get(sid)?.title || clip(sid, 8);
  const projectOf = sid => { const lead = leadOf.get(sid) || (teamOfLead.has(sid) ? sid : null); return lead ? { leadSid: lead, project: titleOf(lead) } : { leadSid: null, project: '独立会话' }; };
  const cardDecision = sid => { const c = cardOf.get(sid); return c && c.plain && !c.decisionAnsweredAt ? realDecision(c.plain.decision) : null; };
  const busy = sid => rowOf.get(sid)?.state === 'run';
  const manualPark = sid => { const p = parks[sid]; const at = rowOf.get(sid)?.at || 0; return !!(p && p.at && !(at > p.at)); };

  const verOf = cardVersion;
  // 同一问：去掉空白和截断省略号后，一方是另一方的开头（待定编号存的问题最多 120 字，卡上是全文）。
  const norm = x => String(x || '').replace(/\s+/g, '').replace(/…$/, '');
  const same = (x, y) => { const a = norm(x), b = norm(y); return !!a && !!b && (a.startsWith(b) || b.startsWith(a)); };
  // 已经回过的同一问（排队中，或已送达但负责人还没改卡）：卡上那一问不再复活成待决（复审 B）。
  // 问句和推荐都一样才算同一问：负责人只改了推荐（比如 14 元改成 1400 元）就是新版本，要重新拍板（二次复审）。
  const sameAsk = (d, q, r) => same(d.question, q) && (norm(d.recommendation) === norm(r) || same(d.recommendation, r));
  const answeredSame = (sid, q, r, cardAt) => (decisions || []).some(d => d && d.sessionId === sid && d.status === 'open' && d.queued && sameAsk(d, q, r))
    || (answered || []).some(d => d && d.sessionId === sid && d.status === 'answered' && d.answer && (d.answer.at || 0) >= (cardAt || 0) && sameAsk(d, q, r));
  // 跳过记录不按时间失效：只要同一问还在，就一直不出现（复审建议 8）；记录本身由存储层清理很久以前的。
  const liveSkips = (skips || []).filter(r => r && r.sessionId);
  // 用到的记录记下来，存储层据此续期：同一问还在，记录就不会因 90 天 / 500 条被清掉（复验建议 8）。
  const inUse = new Set();
  const use = x => { if (x) inUse.add(x.key); return x; };
  const skipOf = (sid, q, r) => use(liveSkips.find(x => x.kind !== 'keep' && askMatches(x, sid, q, r)) || null);
  const keptOf = (sid, q, r) => !!use(liveSkips.find(x => x.kind === 'keep' && askMatches(x, sid, q, r)) || null);
  // 自动过期的原因；没过期返回空。
  const expiredWhy = base => {
    const s = info(base.sessionId);
    if (s && s.closedByUser) return '会话已被你关掉';
    const q = base.fullQuestion ?? base.question, r = base.fullRecommendation ?? base.recommendation;
    const waited = now - (base.waitingSinceAt || now);
    if (waited > EXPIRE_MS) return `已等 ${ago(waited)}没人处理，按 7 天过期（和待定编号同一时限）`;
    if (versionReached(q, appVersion)) return `Hub 已经是 ${appVersion}，这一问多半过时了`;
    const c = cardOf.get(base.sessionId);
    if (base.code && c && (c.mtimeMs || 0) > (base.waitingSinceAt || 0) + 60000) {
      const cd = cardDecision(base.sessionId);
      if (!cd || !sameAsk({ question: q, recommendation: r }, cd.question, cd.recommendation || '')) return c.plain && c.plain.status === '已完成' ? '负责人已交卷，没再提这一问' : '负责人后来改了进展卡，没再提这一问';
    }
    return '';
  };
  const items = [], queued = [], skipped = [], seenMain = new Set(), seenUnv = new Set(), seenSkip = new Set();
  let parked = 0, members = 0;
  const push = (base) => {
    // 成员、子会话的问题由负责人汇总后再报，这里不出现。
    if (leadOf.has(base.sessionId)) { members++; return; }
    const seen = base.verified ? seenMain : seenUnv;
    if (seen.has(base.sessionId)) return;
    const q = base.fullQuestion ?? base.question, r = base.fullRecommendation ?? base.recommendation;
    // 跳过身份用能拿到的最全文本：编号若能对上卡片，就用卡片全文（见下方编号补全文）。
    const aq = base.askQuestion ?? q, ar = base.askRecommendation ?? r;
    const manual = skipOf(base.sessionId, aq, ar), auto = manual || keptOf(base.sessionId, aq, ar) ? '' : expiredWhy(base);
    if (!manual && !auto) seen.add(base.sessionId);
    if (!manual && !auto && manualPark(base.sessionId)) { parked++; return; }
    const { leadSid, project } = projectOf(base.sessionId);
    const waited = Math.max(0, now - (base.waitingSinceAt || now));
    const running = busy(base.sessionId);
    const urgency = running ? 'partial' : base.ifNoReply && /\d{1,2}\s*[:：点]\s*\d{0,2}|分钟|小时|今晚|今天|明早|截止/.test(base.ifNoReply) ? 'deadline' : 'blocking';
    // 版本按完整原文算，显示用的截断不影响核对（复审 A）。
    // 版本与跳过用同一个身份（编号补了卡上全文就按全文算），负责人只改了截断之后的尾部也能拦下旧点击（复验 B）。
    const item = { ...base, ver: verOf(aq, ar), title: titleOf(base.sessionId), project, leadSid, leadTitle: leadSid ? titleOf(leadSid) : null,
      isMember: false, options: optionsOf(base.question, base.recommendation),
      waited: ago(waited), waitedMs: waited, stale: waited > STALE_MS, urgency,
      // 只写看到的状态，不替负责人推断「停工」（审查建议）。
      stateLabel: running ? '会话还在干别的部分' : '会话现在空闲' };
    if (manual || auto) {
      // 同一问的编号和卡片只留一条。
      const k = base.sessionId + '|' + norm(q).slice(0, 60);
      if (!seenSkip.has(k)) { seenSkip.add(k); skipped.push({ ...item, skipKind: manual ? 'manual' : 'auto', reason: manual ? '你跳过的' : auto, skippedAt: manual ? manual.at || 0 : 0, skipKey: manual ? manual.key : skipKey(base.sessionId, aq, ar) }); }
      return;
    }
    items.push(item);
  };
  for (const d of decisions || []) {
    if (!d || d.status !== 'open') continue;
    if (d.queued) { queued.push(d); continue; }
    const card = cardDecision(d.sessionId);
    let source = d.source || (card && same(card.question, d.question) ? 'card' : 'keyword');
    // 关键词编号和卡上当前的真问题不是同一问：编号留在「待核实」，真问题照常进主列表（审查第 2 项）。
    if (source === 'keyword' && card && same(card.question, d.question)) source = 'card';
    // 编号补全文：编号的问句、推荐是截断的；卡上同一问还在时，跳过身份取卡上全文，这样之后负责人只改了尾部也能认出是新的一问（复验第 2 项）。
    const full = card && askMatches({ sessionId: d.sessionId, question: card.question, recommendation: card.recommendation || '' }, d.sessionId, d.question, d.recommendation || '') ? card : null;
    push({ id: d.code, code: d.code, no: d.no, sessionId: d.sessionId, question: d.question, recommendation: d.recommendation || '',
      ...(full ? { askQuestion: full.question, askRecommendation: full.recommendation || '' } : {}),
      ifNoReply: d.ifNoReply || card?.ifNoReply || '', waitingSinceAt: d.createdAt, source, verified: source !== 'keyword', queued: false });
  }
  for (const c of cards || []) {
    const dec = c && c.sessionId ? cardDecision(c.sessionId) : null;
    if (!dec || answeredSame(c.sessionId, dec.question, dec.recommendation || '', c.mtimeMs)) continue;
    push({ id: 'card:' + c.sessionId, code: null, no: null, sessionId: c.sessionId, question: clip(dec.question, 160), recommendation: clip(dec.recommendation || '', 100),
      fullQuestion: dec.question, fullRecommendation: dec.recommendation || '',
      ifNoReply: dec.ifNoReply || '', waitingSinceAt: c.mtimeMs || now, source: 'card', verified: true, queued: false });
  }
  const RANK = { blocking: 0, deadline: 1, partial: 2 };
  const order = (a, b) => (a.stale - b.stale) || (RANK[a.urgency] - RANK[b.urgency]) || (b.waitedMs - a.waitedMs);
  const verified = items.filter(x => x.verified).sort(order);
  const main = verified.slice(0, MAX_MAIN), more = verified.slice(MAX_MAIN);
  const unverified = items.filter(x => !x.verified).sort(order);

  // 已回复：排队中 → 已送达（Hub 确认写进了会话）→ 已读（这条之后负责人答完了一轮）。
  // 送达时对方一定空闲（忙就排队），所以送达之后的第一条新答复就是对这条的回应；没确认送达的一律如实标「未确认」，不被运行状态覆盖（审查第 3 项）。
  const repliedRows = (answered || []).filter(d => d && d.status === 'answered' && d.answer && now - (d.answer.at || 0) < DAY)
    .sort((a, b) => b.answer.at - a.answer.at).map(d => {
      const row = rowOf.get(d.sessionId);
      const state = d.answer.confirmed === false ? 'unconfirmed' : row && (row.lineAt || 0) > d.answer.at + READ_GRACE_MS ? 'read' : 'delivered';
      return { id: d.code, code: d.code, sessionId: d.sessionId, title: titleOf(d.sessionId) || d.title, question: d.question, answerLabel: d.answer.label, from: d.answer.from, at: d.answer.at, state };
    });
  const replied = [...queued.map(d => ({ id: d.code, code: d.code, sessionId: d.sessionId, title: titleOf(d.sessionId) || d.title, question: d.question, answerLabel: '已回复，排队中', at: d.createdAt, state: 'queued' })), ...repliedRows];

  // 第一级 = 项目负责人会话，或没挂在任何负责人下的零碎会话；成员、子会话不单列，它们的状态只折进负责人这一行（在跑算进行中，出错打 ⚠）。
  // 每行只有：会话名、状态（等你 / 卡住 / 进行中 / 已完成）、一句话最新进展、最后活动时间。等你、卡住置顶，已完成折叠。
  const membersOf = new Map();
  for (const [m, l] of leadOf) { if (!membersOf.has(l)) membersOf.set(l, []); membersOf.get(l).push(m); }
  const askingNow = new Set(verified.map(x => x.sessionId));
  // 跳过或自动过期的那一问不再让任务显示「等你」，和红点同一口径（简化复审第 3 项）。
  // 只压住「还停在那一问上」的等待：会话在提问（自动过期）或你点跳过之后又有新活动，就是新的等待（比如新一轮的权限确认），照常算等你（复验 13ea2978）。
  const quietUntil = new Map();
  // 你跳过的：跳过那一刻之后的活动都是新的；自动过期的：没有跳过时刻，按提问后 10 分钟内算同一轮（复验 a19fd00c）。
  for (const x of skipped) quietUntil.set(x.sessionId, Math.max(quietUntil.get(x.sessionId) || 0, x.skipKind === 'manual' ? (x.skippedAt || 0) : (x.waitingSinceAt || 0) + 10 * 60000));
  const quieted = { has: sid => quietUntil.has(sid) && (rowOf.get(sid)?.at || 0) <= quietUntil.get(sid) };
  // 负责人自己超过 24 小时没动、但成员还在干：任务清单里没有负责人这一行，这里补上，不让整个项目消失（简化复审第 2 项）。
  const taskRows = [...(tasks || [])];
  for (const lead of membersOf.keys()) {
    if (rowOf.has(lead) || !(membersOf.get(lead) || []).some(id => rowOf.has(id))) continue;
    taskRows.push({ id: lead, title: titleOf(lead), state: info(lead)?.open ? 'idle' : 'dorm', at: 0, line: '' });
  }
  const CARD_FRESH_MS = 2 * HOUR;
  const firstLevel = [];
  for (const r of taskRows) {
    if (leadOf.has(r.id)) continue;
    const card = cardOf.get(r.id), plain = card && card.plain;
    const ms = (membersOf.get(r.id) || []).map(id => rowOf.get(id)).filter(Boolean);
    const closed = !!info(r.id)?.closedByUser;
    // 项目这一行的状态把成员折进来：成员出错→卡住；成员在跑或停着等负责人→进行中（等的是负责人，不是你）；
    // 负责人自己闲着但进展卡 2 小时内写过、还没写「已完成」（比如在等远端作业）→进行中（简化复审第 1 项）。
    const cardOpen = !!(plain && plain.status && plain.status !== '已完成' && now - (card.mtimeMs || 0) < CARD_FRESH_MS);
    const status = closed ? 'done'
      : askingNow.has(r.id) || (r.state === 'wait' && !quieted.has(r.id)) ? 'waiting'
      : r.state === 'error' || (plain && plain.status === '卡住') || ms.some(m => m.state === 'error') ? 'stuck'
      : r.state === 'run' || ms.some(m => m.state === 'run' || m.state === 'wait') || cardOpen ? 'running' : 'done';
    const at = Math.max(r.at || 0, ...ms.map(m => m.at || 0));
    firstLevel.push({ sessionId: r.id, title: r.title, status, closed,
      warn: status !== 'done' && (status === 'stuck' || !!(card && card.stale) || ms.some(m => m.state === 'error')),
      line: clip((plain && plain.line) || r.line || '', 80),
      lastActiveAt: at, lastActive: at ? ago(now - at) + (now - at < 60000 ? '' : '前') : '' });
  }
  const SR = { waiting: 0, stuck: 1, running: 2, done: 3 };
  firstLevel.sort((a, b) => (SR[a.status] - SR[b.status]) || (b.warn - a.warn) || (b.lastActiveAt - a.lastActiveAt));
  const active = firstLevel.filter(x => x.status !== 'done'), done = firstLevel.filter(x => x.status === 'done');
  const counts = { waiting: 0, stuck: 0, running: 0, done: done.length };
  for (const x of active) counts[x.status]++;

  // 红点＝全部有依据、还没回的（含折叠的、等太久的），和左栏「待你定」同一口径（审查第 4 项）。
  const badge = verified.length;
  return {
    ok: true, at: now,
    decisions: { main, more, unverified, replied, badge, skipKeysInUse: [...inUse],
      skipped: skipped.sort((a, b) => (a.skipKind === 'manual' ? 0 : 1) - (b.skipKind === 'manual' ? 0 : 1) || (b.skippedAt - a.skippedAt) || (a.waitedMs - b.waitedMs)),
      filtered: { unverified: unverified.length, parked, stale: verified.filter(x => x.stale).length, members,
        skipped: skipped.filter(x => x.skipKind === 'manual').length, expired: skipped.filter(x => x.skipKind === 'auto').length } },
    progress: { rows: active, done, counts, total: active.length, summary: plainSummary(counts) },
  };
}

function plainSummary(counts) {
  const n = counts.waiting + counts.stuck + counts.running;
  if (!n) return counts.done ? `没有在动的任务；${counts.done} 个已完成或空闲，在下面折叠着。` : '最近 24 小时没有任务。';
  const parts = [counts.waiting && `${counts.waiting} 个等你`, counts.stuck && `${counts.stuck} 个卡住`, counts.running && `${counts.running} 个进行中`].filter(Boolean);
  return `${n} 个任务在动：${parts.join('、')}。${counts.waiting ? '等你的点会话名打开处理，要拍板的也在「待我决策」。' : '不用你管，各自在推进。'}`;
}

// 卡片问题当前的版本（弹窗发送时核对用）。
function cardVersion(q, r) { return require('node:crypto').createHash('sha256').update(String(q || '') + '|' + String(r || '')).digest('hex').slice(0, 12); }

module.exports = { buildOverview, plainSummary, optionsOf, ago, cardVersion, skipKey, askMatches, versionReached, MAX_MAIN };
