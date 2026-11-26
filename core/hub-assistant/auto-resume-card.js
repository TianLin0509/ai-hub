'use strict';
// 自动续跑在前台助理页的记录（P0）：每次「已续 / 需核对 / 未续」都进同一张卡，一次重启的多个会话合并成一张
// （「这次重启 N 个会话：已续 a、需核对 b、未续 c」），CLI 重开是单个会话一张。数据来自 core/auto-resume/controller.js 的事件。
// 卡片是助理对话记录里的一条（card: 'auto-resume'），同一个 id 的后一条替换前一条（与重启续跑卡同一套折叠，见 restart-resume.js）。
// 两处显示：窗口顶部提示条（renderer/assistant-resume-card.js，可收起）；前台「当前概览」弹窗的「续跑」Tab（renderer/assistant-overview.js，list，收起后仍能找到）。
// 首次出卡发一条助理通知（手机能看到）；夜里 23:00–08:00 不发通知，只记卡片。
const CARD = 'auto-resume';
const ACTION_LABEL = { resumed: '已续', uncertain: '需核对', skipped: '未续', failed: '未续', retrying: '重试中' };
const LIST_DAYS = 3;

// 北京时间的小时（zh-CN 的格式化会带「时」字，取数字部分）。
const hourOf = at => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' })
  .formatToParts(new Date(at)).find(p => p.type === 'hour')?.value);
const isQuietHour = at => { const h = hourOf(at); return h >= 23 || h < 8; };

function tally(rows) {
  const out = { resumed: 0, uncertain: 0, skipped: 0, retrying: 0 };
  for (const r of rows) { const k = r.action === 'failed' ? 'skipped' : r.action; out[k] = (out[k] || 0) + 1; }
  return out;
}

function cardText(card) {
  const rows = card.rows || [], t = tally(rows);
  const parts = [`已续 ${t.resumed}`, `需核对 ${t.uncertain}`, `未续 ${t.skipped}`];
  if (t.retrying) parts.push(`重试中 ${t.retrying}`);
  if (card.trigger === 'hub-restart') return `Hub 重启后自动续跑检查了 ${rows.length} 个会话：${parts.join('、')}`;
  const row = rows[0];
  if (card.trigger === 'patrol' && row && (row.by === 'patrol-auto' || row.by === 'quota-resume')) return `「${row.title}」${row.reason}`;
  if (card.trigger === 'patrol') return row ? `「${row.title}」巡逻提醒后续跑：${ACTION_LABEL[row.action] || row.action}${row.action === 'resumed' ? '' : `（${row.reason}）`}` : '巡逻提醒后续跑';
  return row ? `「${row.title}」CLI 进程重开：${ACTION_LABEL[row.action] || row.action}${row.action === 'resumed' ? '' : `（${row.reason}）`}` : 'CLI 进程重开';
}

class AutoResumeCards {
  // patrol（P1 巡逻器，主进程挂上）：{ list(), dismiss(sid), resume(sid), enabled(), setEnabled(on), mode(), setMode(m), breakers() }。
  constructor(assistant, { now = Date.now } = {}) { this.a = assistant; this.now = now; this.cards = new Map(); this.resumer = null; this.patrol = null; this.busy = new Map(); }

  all() {
    try { return require('./restart-resume').foldCards(this.a.dialog.recent({ limit: 2000 })).filter(e => e.card === CARD); }
    catch { return []; }
  }
  find(id) {
    if (this.cards.has(id)) return this.cards.get(id);
    const found = this.all().find(e => e.id === id);
    if (!found) return null;
    const { at: _at, ...card } = found; this.cards.set(id, card); return card;
  }

  // 收一条自动续跑事件（账本行）。返回更新后的卡。
  record(event) {
    if (!event?.batch || !event.sessionId) return null;
    const id = `${CARD}:${event.batch}`, at = event.at || this.now();
    const existing = this.find(id);
    const card = existing ? { ...existing, rows: [...existing.rows] } : { id, role: 'system', card: CARD, trigger: event.trigger, startedAt: at, rows: [], state: 'open' };
    const row = { id: event.sessionId, title: event.title || '未命名会话', action: event.action, code: event.code || null, reason: event.reason || '', at,
      trigger: event.trigger || card.trigger, interruption: event.interruption || null, ...(event.canResume ? { canResume: true } : {}), ...(event.by ? { by: event.by } : {}) };
    const index = card.rows.findIndex(r => r.id === row.id);
    if (index < 0) card.rows.push(row); else card.rows[index] = row;
    card.updatedAt = at; card.state = card.state === 'dismissed' ? 'open' : card.state;
    card.text = cardText(card);
    this.cards.set(id, card);
    if (!existing && !isQuietHour(at) && card.trigger !== 'patrol') {
      try { this.a.watches.addNotice({ id, title: '自动续跑', kind: CARD, label: '自动续跑', text: card.text }); } catch {}
    }
    return this.a.logDialog(card);
  }

  // 「当前概览」的「续跑」Tab：近 3 天的卡，新的在前（收起过的也在）。
  list({ days = LIST_DAYS } = {}) {
    const since = this.now() - days * 86400_000;
    return this.all().filter(c => (c.updatedAt || c.at || 0) >= since).sort((a, b) => (b.updatedAt || b.at || 0) - (a.updatedAt || a.at || 0));
  }

  async act({ id, action, sessionId, reminderId, enabled, mode } = {}) {
    const p = this.patrol;
    // mode：'off' 关 / 'remind' 只提醒 / 'auto' 自动续故障类（三档开关）。
    const state = () => ({ enabled: p ? !!p.enabled() : true, mode: p ? (p.enabled() ? (p.mode?.() === 'auto' ? 'auto' : 'remind') : 'off') : 'remind', breakers: p?.breakers ? p.breakers() : [] });
    // 重启卡（restart-resume.js：Hub 重启时回合还在进行的会话）也进「续跑」Tab，与自动续跑记录按时间排在一起（2026-11-26）。
    const restart = this.a.restartResume;
    if (action === 'list') {
      let turns = []; try { turns = restart ? restart.list() : []; } catch (error) { console.warn('[assistant] restart-resume list', error.message); }
      const cards = [...turns, ...this.list()].sort((a, b) => (b.startedAt || b.updatedAt || b.at || 0) - (a.startedAt || a.updatedAt || a.at || 0));
      return { ok: true, cards, stalled: p ? p.list() : [], ...state() };
    }
    if (String(id || '').startsWith('restart-resume:') && (action === 'resume' || action === 'resume-all')) {
      if (!restart) throw new Error('重启续跑尚未就绪');
      const r = await restart.resumeRows({ id, sessionId: action === 'resume' ? sessionId : null });
      const failed = r.results.find(x => !x.ok);
      return { ok: r.ok, sent: r.sent, results: r.results, row: failed ? { reason: failed.message } : null };
    }
    if (action === 'set-mode') {
      if (!p) throw new Error('巡逻器尚未就绪');
      if (!['off', 'remind', 'auto'].includes(mode)) throw new Error('未知档位');
      await p.setMode(mode);
      return { ok: true, ...state() };
    }
    // 巡逻提醒：忽略（这一回合不再提醒）/ 续跑（走按钮路径）/ 总开关。
    if (action === 'patrol-dismiss') { if (!p) throw new Error('巡逻器尚未就绪'); return { ok: !!p.dismiss(sessionId, reminderId || null), stalled: p.list() }; }
    if (action === 'patrol-resume') {
      if (!p) throw new Error('巡逻器尚未就绪');
      const key = `patrol|${sessionId}`;
      if (this.busy.has(key)) return this.busy.get(key);
      const job = Promise.resolve(p.resume(sessionId)).then(r => ({ ok: r?.ok !== false, error: r?.error || r?.row?.reason || null, stalled: p.list() })).finally(() => this.busy.delete(key));
      this.busy.set(key, job);
      return job;
    }
    if (action === 'set-enabled') { if (!p) throw new Error('巡逻器尚未就绪'); await p.setEnabled(!!enabled); return { ok: true, enabled: !!p.enabled() }; }
    const card = this.find(id);
    if (!card) throw new Error('这张卡已经不在对话记录里');
    if (action === 'dismiss') {
      const next = { ...card, state: 'dismissed' };
      this.cards.set(id, next);
      try { this.a.watches.markRead(id); } catch {}
      return { ok: true, card: this.a.logDialog(next) };
    }
    if (action !== 'resume') throw new Error('未知操作');
    const row = card.rows.find(r => r.id === sessionId);
    if (!row || !row.canResume) throw new Error('这一行不能一键续跑');
    if (typeof this.resumer !== 'function') throw new Error('自动续跑尚未就绪');
    const key = `${id}|${sessionId}`;
    if (this.busy.has(key)) return this.busy.get(key);
    // resumer 会把结果作为同一批次的新事件 record 进来，这里取回最新的卡。
    const job = Promise.resolve(this.resumer({ sessionId, batch: card.id.slice(CARD.length + 1), trigger: row.trigger || card.trigger, interruption: row.interruption }))
      .then(result => ({ ok: result?.ok !== false, card: this.find(id), row: result?.row || null }))
      .finally(() => this.busy.delete(key));
    this.busy.set(key, job);
    return job;
  }
}

module.exports = { AutoResumeCards, CARD, cardText, isQuietHour, tally };
