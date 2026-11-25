'use strict';
// 负责人看板的进展卡补找（2026-11-03）：「进展」视图启动时只从原生记录末尾一段开始认卡，
// 早先写过卡的负责人会被漏掉（实测 3 个负责人里 2 个漏认）。助理汇报时，只对「进展」视图还没认出卡的负责人，
// 用同一套认卡规则（只认本会话自己写过的卡）把完整记录扫一遍，之后按偏移只读新增部分。只读，不改卡、不改记录。
const fs = require('node:fs');
const { writtenCardPaths, cardsInOwnDirectory } = require('./progress-card-service');
const { parseProgressCard, classifyCard } = require('../core/progress-card');

const MAX_CARD_BYTES = 64 * 1024;
// 每次补找所有负责人合计最多读这么多记录；读不完的下次接着读（2026-11-25：首次全量 378 MB 曾一次卡住主进程 1.8 秒）。
const READ_BUDGET = 8 * 1024 * 1024;
// 超长单行分块读时，每块末尾留这么多字节到下一块再认（> 认卡时向后看的 400 字 + 路径长度）。
const TAIL_KEEP = 4096;

function createLeadCardFallback({ getSession, fsImpl = fs, now = () => Date.now(), readBudget = READ_BUDGET } = {}) {
  let budgetLeft = readBudget;
  const tracked = new Map();     // leadSid → { transcriptPath, offset, cards:Set }
  const parsedCards = new Map(); // cardPath → { mtimeMs, parsed }

  // 2026-11-25 卡顿修复：按调用方给的负责人编号记偏移。原先用 session.id，可从磁盘读回的已关闭会话只有 hubId、没有 id，
  // 44 个负责人挤在同一个空键上，每次都把各自的完整记录（合计约 378 MB）从头重读，主进程每次卡 1.8 秒。
  function scan(session, key = session.id || session.hubId) {
    let t = tracked.get(key);
    if (!t || t.transcriptPath !== session.transcriptPath) {
      t = { transcriptPath: session.transcriptPath, offset: 0, cards: t ? t.cards : new Set() };
      tracked.set(key, t);
    }
    let size;
    try { size = fsImpl.statSync(t.transcriptPath).size; } catch { return t; }
    if (size < t.offset) { t.offset = 0; t.waitSize = null; t.carry = null; }
    // 原生记录一行一条，任何时候都不解析没写完的行（2026-11-25 交叉审查三轮指出），每轮读量不超过预算：
    //   块里有换行 → 认到最后一个完整行为止；
    //   单行比整轮预算还长 → 跨轮分块读，每块末尾 TAIL_KEEP 字节留到下一块，只认在它之前开头的路径；
    //   预算不够读完这一行 → 留到下一轮；文件末尾的半行（CLI 正在写）→ 文件变长后再读。
    if (size > t.offset && budgetLeft > 0 && t.waitSize !== size) {
      const from = t.offset;
      const end = Math.min(size, from + budgetLeft);
      budgetLeft -= end - from;
      const chunk = Buffer.alloc(end - from);
      const fd = fsImpl.openSync(t.transcriptPath, 'r');
      try { fsImpl.readSync(fd, chunk, 0, chunk.length, from); } finally { fsImpl.closeSync(fd); }
      const carry = t.carry || null;
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const nl = chunk.lastIndexOf(10);
      const add = (text, opts) => { for (const p of [...writtenCardPaths(text, session.cwd, opts), ...cardsInOwnDirectory(text, session.cwd, opts)]) { t.cards.delete(p); t.cards.add(p); } };
      if (nl >= 0) {
        add(buf.toString('utf8', 0, (carry ? carry.length : 0) + nl + 1));
        t.offset = from + nl + 1; t.carry = null; t.waitSize = null;
      } else if (end < size && (carry || chunk.length >= readBudget)) {
        if (buf.length > TAIL_KEEP) {
          add(buf.toString('utf8'), { before: buf.toString('utf8', 0, buf.length - TAIL_KEEP).length });
          t.carry = Buffer.from(buf.subarray(buf.length - TAIL_KEEP));
        } else t.carry = Buffer.from(buf);
        t.offset = end;
      } else if (end >= size) t.waitSize = size;
    }
    return t;
  }

  function cardFor(leadSid) {
    const session = getSession(leadSid);
    if (!session || !session.transcriptPath) return null;
    const t = scan(session, leadSid);
    let best = null;
    for (const p of t.cards) {
      try { const st = fsImpl.statSync(p); if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs }; } catch {}
    }
    if (!best) return null;
    // 卡没改就复用上次的解析结果，不再每次重读。
    let parsed;
    const cached = parsedCards.get(best.path);
    if (cached && cached.mtimeMs === best.mtimeMs) parsed = cached.parsed;
    else {
      try { parsed = parseProgressCard(fsImpl.readFileSync(best.path, 'utf8').slice(0, MAX_CARD_BYTES)); } catch { return null; }
      parsedCards.set(best.path, { mtimeMs: best.mtimeMs, parsed });
    }
    const running = ['running', 'waiting'].includes(session.status);
    const { group, stale } = classifyCard({ plain: parsed.plain, mtimeMs: best.mtimeMs, running, now: now() });
    return { sessionId: leadSid, title: session.title || '', kind: session.kind || '', cardPath: best.path, mtimeMs: best.mtimeMs,
      running, group, stale, cardTitle: parsed.title, goal: parsed.goal, done: parsed.done, total: parsed.total, plain: parsed.plain,
      decisionAnsweredAt: null, ghost: null, foundBy: 'assistant-full-scan' };
  }

  /** 把「进展」视图的快照补全：负责人缺卡时补找。返回新数组，不改原快照。 */
  function withFallback(cards = [], teams = []) {
    budgetLeft = readBudget;
    const have = new Set(cards.map(c => c.sessionId));
    const out = cards.slice();
    for (const team of teams) {
      if (!team || !(team.members || []).length || have.has(team.leadSid)) continue;
      try { const card = cardFor(team.leadSid); if (card) out.push(card); } catch {}
    }
    return out;
  }

  return { withFallback, cardFor, _tracked: tracked };
}

module.exports = { createLeadCardFallback };
