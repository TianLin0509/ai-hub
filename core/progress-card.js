'use strict';
// （状态 / 一句话 / 进度 / 新发现 / 等你拍板，模板见 ~/.agents/templates/进展卡模板.md）。
// 这里只做纯解析和分类，不碰文件系统；读卡、监听、代写在 main/progress-card-service.js。

const STATUSES = ['顺利', '有风险', '卡住', '已完成'];
// 卡在跑、但超过这么久没更新，就算「久未更新」，Hub 开始代写（2026-10-27 原型定稿值）。
const STALE_MS = 40 * 60 * 1000;
const FIELDS = { 状态: 'status', 一句话: 'line', 进度: 'progress', 新发现: 'finding', 等你拍板: 'decide' };
const NONE = /^(无|没有|暂无|none|n\/a|-|—)?[。.]?$/i;

function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function orNull(s) { const v = clean(s); return NONE.test(v) ? null : v; }

// 普通回答里的可选进展块（2026-10-31）：只有 AI 在「白话解读」下面主动写出
// 「进展概述」才进入左侧「进展」页。这里不要求固定的 Markdown 写法，也不把
// 进展概述注入回答卡；原文仍按普通回答自然显示。
function parseProgressOverview(text) {
  const s = String(text || '').replace(/^\uFEFF/, '');
  const white = /(?:^|\r?\n|\\n)\s*(?:#{1,6}\s*)?(?:\*\*)?白话解读\s*[:：]?(?:\*\*)?\s*/m.exec(s);
  if (!white) return null;
  const from = white.index + white[0].length;
  const overview = /(?:^|\r?\n|\\n)\s*(?:#{1,6}\s*)?(?:\*\*)?进展概述\s*[:：]?(?:\*\*)?\s*/m.exec(s.slice(from));
  if (!overview) return null;
  const start = from + overview.index + overview[0].length;
  const lines = s.slice(start).split(/\r?\n|\\n/);
  const out = [];
  for (const line of lines) {
    if (out.length && /^\s*(?:#{1,6}\s+|---+\s*$|(?:\*\*)?(?:检查顺序|下一步|限制|白话解读|进展概述)\s*[:：]?(?:\*\*)?(?:\s|$))/.test(line)) break;
    out.push(line);
  }
  const value = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return value ? value.slice(0, 1600) : null;
}

function assistantTextFromRecord(record) {
  if (!record || typeof record !== 'object') return '';
  const payload = record.payload || record.message || record;
  const role = payload.role || record.role || (record.type === 'assistant' ? 'assistant' : '')
    || (record.payload && record.payload.type === 'agent_message' ? 'assistant' : '');
  if (role !== 'assistant' && !(record.payload && record.payload.type === 'agent_message')) return '';
  const content = payload.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(x => x && typeof x.text === 'string').map(x => x.text).join('\n');
  if (record.payload && typeof record.payload.message === 'string') return record.payload.message;
  return typeof payload.message === 'string' ? payload.message : '';
}

function normalizeStatus(raw) {
  const s = clean(raw);
  if (STATUSES.includes(s)) return s;
  // 模板里的占位「<顺利 / 有风险 / 卡住 / 已完成>」或写成一句话时，按最严重的关键词认。
  if (/[<＜]/.test(s)) return null;
  if (/卡住|阻塞|失败/.test(s)) return '卡住';
  if (/风险|异常|超时/.test(s)) return '有风险';
  if (/已完成|完成了|全部完成/.test(s)) return '已完成';
  if (/顺利|正常|进行中/.test(s)) return '顺利';
  return null;
}

// 「已完成 3 项，正在做 X，还剩 2 项」→ { done: 3, total: 5 }；只写了一半就只给能确定的。
function parseCounts(text) {
  const s = String(text || '');
  const done = /已完成\s*(\d+)\s*(?:项|个|步|批)?/.exec(s);
  const left = /(?:还剩|剩余|剩下)\s*(\d+)\s*(?:项|个|步|批)?/.exec(s);
  const frac = /(\d+)\s*\/\s*(\d+)/.exec(s);
  if (done && left) return { done: +done[1], total: +done[1] + +left[1] };
  if (frac && +frac[2] > 0) return { done: +frac[1], total: +frac[2] };
  return { done: done ? +done[1] : null, total: null };
}

// 2026-11-25：拍板行可写成「问题｜推荐：…｜不回：…」，「不回」是不回复的后果（当前概览弹窗显示）；旧写法照旧解析。
function splitDecision(text) {
  let v = orNull(text);
  if (!v) return null;
  let ifNoReply = '';
  const tail = /[｜|，,；;。\s]*不回(?:复)?(?:会怎样|的话|后果)?\s*[:：]\s*(.+)$/.exec(v);
  if (tail && tail.index > 0) { ifNoReply = clean(tail[1]); v = v.slice(0, tail.index); }
  const m = /^(.*?)[｜|，,；;。\s]*推荐[:：]?\s*(.+)$/.exec(v);
  const out = m && clean(m[1]) ? { question: clean(m[1]), recommendation: clean(m[2].replace(/[｜|]\s*$/, '')) } : { question: clean(v.replace(/[｜|]\s*$/, '')), recommendation: '' };
  return ifNoReply ? { ...out, ifNoReply } : out;
}

// 取某个二级标题下的正文（到下一个二级标题为止）。
function section(text, heading) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp(`^##\\s*${heading}\\s*$`).test(l.trim()));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i += 1) out.push(lines[i]);
  return out;
}

function parsePlainBlock(text) {
  const lines = section(text, '给用户看');
  if (!lines) return null;
  const block = {};
  for (const raw of lines) {
    const m = /^\s*[-*]?\s*(状态|一句话|进度|新发现|等你拍板)\s*[:：]\s*(.*)$/.exec(raw);
    if (m) block[FIELDS[m[1]]] = clean(m[2]);
  }
  if (!Object.keys(block).length) return null;
  return {
    status: normalizeStatus(block.status),
    line: orNull(block.line),
    progress: orNull(block.progress),
    finding: orNull(block.finding),
    decision: splitDecision(block.decide),
  };
}

function parseGoal(text) {
  const lines = section(text, '目标与完成条件') || section(text, '目标') || [];
  const goal = lines.map(l => /^\s*[-*]\s*目标\s*[:：]\s*(.+)$/.exec(l)).find(Boolean);
  const boxes = lines.filter(l => /^\s*[-*]\s*\[[ xX]\]/.test(l));
  return {
    goal: goal ? clean(goal[1]) : null,
    checks: boxes.length ? { done: boxes.filter(l => /\[[xX]\]/.test(l)).length, total: boxes.length } : null,
  };
}

function parseProgressCard(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const title = (/^#\s+(.+)$/m.exec(s) || [])[1] || '';
  const plain = parsePlainBlock(s);
  const { goal, checks } = parseGoal(s);
  let counts = plain ? parseCounts(plain.progress) : { done: null, total: null };
  if (counts.total == null && checks) counts = checks;
  return { title: clean(title), plain, goal, done: counts.done, total: counts.total };
}

/**
 * 卡片该放进哪一栏：decide 待拍板 / risk 有风险、卡住或久未更新 / ok 顺利 / done 已完成 / unknown 没写白话块。
 * running：会话这一刻是否在跑；不在跑的卡不算久未更新（Agent 停了，自然不会再写）。
 */
function classifyCard({ plain, mtimeMs, running, now = Date.now(), staleMs = STALE_MS } = {}) {
  const stale = Boolean(running && mtimeMs && now - mtimeMs >= staleMs && !(plain && plain.status === '已完成'));
  if (plain && plain.decision) return { group: 'decide', stale };
  if (plain && plain.status === '已完成') return { group: 'done', stale: false };
  if (stale || (plain && (plain.status === '有风险' || plain.status === '卡住'))) return { group: 'risk', stale };
  if (plain && plain.status === '顺利') return { group: 'ok', stale };
  return { group: plain ? 'ok' : 'unknown', stale };
}

module.exports = { STATUSES, STALE_MS, normalizeStatus, parseCounts, splitDecision, parseProgressCard, parseProgressOverview, assistantTextFromRecord, classifyCard };
