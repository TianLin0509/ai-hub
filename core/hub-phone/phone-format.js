'use strict';
// 手机端推送与回复的格式（2026-11-21 前台多端闭环 m4）。
// 依据：11-15～11-21 手机每天收 77～200 条提醒，前台转告 77 条里 73 条超过 200 字（中位 594 字），
// 规则：
// 1. 前台转告、交卷、请拍板、告警直接用原文，不加前缀；关注会话原文只加一个短来源「会话名」。
// 2. 关注会话原文与「前台已代批」公告进对话但不响铃（quiet），其余都响铃。
// 3. 只有上面两类低价值流按同一来源 2 分钟合并；告警、拍板、交卷、转告即时单条推送。
// 4. 超过约 200 字：正文给结论（按句子截断），全文放 detail，App 3.1 显示「展开全文」。
const PHONE_LIMIT = 200;
const MERGE_MS = 2 * 60000;
// 原样发正文的类型（不加任何来源前缀）
const PLAIN = new Set(['memory-update', 'reminder', 'memo-digest', 'podcast', 'restart-resume', 'front-relay', 'lead-handoff', 'lead-decide', 'front-decision', 'decision', 'alert', 'hub-alert', 'hub-announce', 'note', 'assistant-notice', 'endpoint-health']);
// 只有低价值流才进对话不响铃、才合并（2026-11-21 审查）：关注会话原文（4 天 437 条那类）与「前台已代批」公告。
// 告警、请拍板、交卷、前台转告、Hub 升级/重启公告、记忆更新一律即时单条推送并响铃。
const LOW_VALUE = new Set(['target-final-reply']);
const isAutoApprove = n => n?.kind === 'hub-announce' && (String(n?.id || '').startsWith('announce:auto-approve:') || n?.title === '前台已代批');

const chars = s => [...String(s || '')];
const len = s => chars(s).length;

function isDaily(kind) { return typeof kind === 'string' && kind.startsWith('daily-'); }

function shortTitle(title, max = 16) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  const c = chars(t);
  return c.length > max ? c.slice(0, max).join('') + '…' : t;
}

// 一条提醒在手机上显示的正文（未裁剪）。
function noticeText(n) {
  // 合同 v1.2：前台总入口为手机单独给的短文（phoneText）优先，没有才用全文。
  const text = String(n?.phoneText || n?.text || '').trim();
  if (PLAIN.has(n?.kind) || isDaily(n?.kind)) return text;
  const title = shortTitle(n?.title);
  return title ? `「${title}」${text}` : text;
}

function isLowValue(n) { return LOW_VALUE.has(n?.kind) || isAutoApprove(n); }
function isQuiet(n) { return isLowValue(n); }
// 只有低价值流按「类型 + 来源」2 分钟合并；其余返回 null＝即时单条。
function mergeKey(n) { return isLowValue(n) ? `${n?.kind || ''}|${n?.title || ''}` : null; }

// 把一段长文压成约 limit 字的结论：优先取第一段，在句末（。！？；）处截断；截不到合适的句末就硬截加省略号。
function conclusion(text, limit = PHONE_LIMIT) {
  const full = String(text || '').trim();
  if (len(full) <= limit) return full;
  const paras = full.split(/\n\s*\n|\n(?=\s*[-*•]\s|\s*\d+[.、]\s)/).map(s => s.trim()).filter(Boolean);
  let head = paras[0] || full;
  // 第一段太短（如「已经查清了，直接汇报。」）就并入下一段
  for (let i = 1; len(head) < limit * 0.3 && i < paras.length; i++) head += '\n' + paras[i];
  const c = chars(head);
  if (c.length <= limit) return head + (head.length < full.length ? '…' : '');
  const window = c.slice(0, limit - 1).join('');
  let cut = -1;
  for (const m of window.matchAll(/[。！？；!?;]|\n/g)) cut = m.index + m[0].length;
  const minKeep = Math.floor(limit * 0.4);
  const piece = cut > 0 && len(window.slice(0, cut)) >= minKeep ? window.slice(0, cut) : window;
  return closeMarkdown(piece.trim()) + '…';
}

// 截断后可能留下半个 **加粗**，补上配对，免得 App 把后面全渲染成粗体。
function closeMarkdown(s) {
  const bold = (s.match(/\*\*/g) || []).length;
  return bold % 2 ? s + '**' : s;
}

// 手机正文 + 可展开全文。detail 只有在确实裁剪了时才给。
function clip(text, limit = PHONE_LIMIT) {
  const full = String(text || '').trim();
  if (len(full) <= limit) return { text: full, detail: null };
  return { text: conclusion(full, limit), detail: full };
}

// 多条合并成一条：每条给一行要点，总长仍按 limit 控制，全文按顺序放 detail。
function mergeTexts(texts, limit = PHONE_LIMIT) {
  const list = texts.map(t => String(t || '').trim()).filter(Boolean);
  if (list.length <= 1) return clip(list[0] || '', limit);
  const per = Math.max(30, Math.floor((limit - 12) / list.length));
  const lines = list.map((t, i) => `${i + 1}. ${conclusion(t.replace(/\s*\n\s*/g, ' '), per)}`);
  let text = `${list.length} 条新消息：\n` + lines.join('\n');
  if (len(text) > limit) text = chars(text).slice(0, limit - 1).join('') + '…';
  return { text: closeMarkdown(text), detail: list.map((t, i) => `**${i + 1}.** ${t}`).join('\n\n') };
}

// 同类 2 分钟合并：第一条立即放行；窗口内的后续条目攒着，窗口到点后合成一条放行。
// 只在内存里攒：Hub 中途重启时，未发出的提醒仍在助理提醒列表里，会被重新读到再发。
class NoticeMerger {
  constructor({ windowMs = MERGE_MS, now = () => Date.now() } = {}) { this.windowMs = windowMs; this.now = now; this.groups = new Map(); this.held = new Set(); }
  // 返回现在就该发出的批次：[{key, notices:[...]}]
  offer(notices) {
    const now = this.now(), out = [];
    for (const n of notices) {
      if (this.held.has(n.id)) continue;
      const key = mergeKey(n);
      if (!key) { out.push({ key: null, notices: [n] }); continue; }
      const g = this.groups.get(key);
      if (!g || (now - g.lastAt >= this.windowMs && !g.pending.length)) { this.groups.set(key, { lastAt: now, pending: [] }); out.push({ key, notices: [n] }); continue; }
      g.pending.push(n); this.held.add(n.id);
    }
    for (const [key, g] of this.groups) {
      if (g.pending.length && now - g.lastAt >= this.windowMs) { out.push({ key, notices: g.pending }); for (const n of g.pending) this.held.delete(n.id); g.pending = []; g.lastAt = now; }
      else if (!g.pending.length && now - g.lastAt >= this.windowMs * 5) this.groups.delete(key);
    }
    return out;
  }
  pendingCount() { let n = 0; for (const g of this.groups.values()) n += g.pending.length; return n; }
}

// 一批提醒在手机上的最终形态。full=true 表示 App 不认 detail，正文发全文（老 App 不倒退）。
function noticePacket(batch, { limit = PHONE_LIMIT, full = false } = {}) {
  const texts = batch.map(noticeText);
  const shaped = batch.length > 1 ? mergeTexts(texts, limit) : clip(texts[0], limit);
  const text = full ? (shaped.detail || shaped.text) : shaped.text;
  return { text, detail: full ? null : shaped.detail, quiet: batch.every(isQuiet), merged: batch.length };
}

// 读 phone-usage.jsonl 出每天的手机用量（北京时间）：收到几条、答几条、推几条（其中不响铃几条）、手机确认收到几条，
// 以及端到端延迟：手机提问到达电脑 → 答复被手机确认收到（同一 Hub 时钟），P50/P90 毫秒。
function summarizeUsage(file, { days = 14 } = {}) {
  let rows = [];
  try { rows = require('node:fs').readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { }
  const day = t => new Date(t + 8 * 3600e3).toISOString().slice(0, 10), since = Date.now() - days * 86400e3;
  const out = {}, inAt = new Map(), sentIds = new Set(), e2e = {}, arrive = {};
  const d = k => (out[k] ??= { in: 0, answer: 0, push: 0, quiet: 0, merged: 0, sent: 0, acked: 0 });
  for (const r of rows) {
    if (r.at < since) continue; const k = day(r.at), x = d(k);
    if (r.ev === 'in') { x.in++; inAt.set('answer-' + r.id, r.at); }
    else if (r.ev === 'answer') x.answer++;
    else if (r.ev === 'push') { x.push++; if (r.quiet) x.quiet++; if (r.merged > 1) x.merged += r.merged - 1; }
    else if (r.ev === 'sent') { x.sent++; sentIds.add(r.id); }
    else if (r.ev === 'ack') { x.acked++; if (r.arriveMs != null) (arrive[k] ??= []).push(r.arriveMs); if (inAt.has(r.id)) (e2e[k] ??= []).push(r.at - inAt.get(r.id)); }
  }
  const pct = (a, p) => { if (!a?.length) return null; const s = [...a].sort((m, n) => m - n); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  for (const k in out) Object.assign(out[k], { arriveP50: pct(arrive[k], 0.5), arriveP90: pct(arrive[k], 0.9), e2eP50: pct(e2e[k], 0.5), e2eP90: pct(e2e[k], 0.9), e2eN: e2e[k]?.length || 0 });
  return { file, days: out };
}

// 手机字数上限以前台端配置为准（m1 的 endpoints.js，phone.maxChars）；取不到时用 200。
function phoneLimit() {
  try { const e = require('../hub-assistant/endpoints'); const n = Number(e.profileOf ? e.profileOf('phone')?.maxChars : e.PROFILES?.phone?.maxChars); if (n >= 60) return n; } catch { }
  return PHONE_LIMIT;
}

module.exports = { phoneLimit, summarizeUsage, PHONE_LIMIT, MERGE_MS, noticeText, isQuiet, mergeKey, conclusion, clip, mergeTexts, NoticeMerger, noticePacket, shortTitle };
