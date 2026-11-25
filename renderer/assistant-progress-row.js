'use strict';
// 会话进展在助理对话里的样子（那一行由 core/hub-assistant/progress-feed.js 记下）：一个会话一行，挨着的几行收成一块。
const { LABELS } = require('../core/hub-assistant/progress-feed');

// 每个会话最新的那一条进展（读记录时主进程已经只给最新一条；这里管的是页面开着期间陆续推过来的）。
function latestProgress(entries) {
  const last = new Map();
  for (const e of entries) if (e.progress?.sessionId) last.set(e.progress.sessionId, e);
  return new Set(last.values());
}
function progressRowHtml(e, { esc, time, openId = null }) {
  const p = e.progress, label = LABELS[p.state] || LABELS.done, title = e.by || '会话';
  return `<button type="button" class="ap-prog-row" data-progress-open="${esc(p.sessionId)}" data-state="${esc(p.state)}" aria-pressed="${openId === p.sessionId}" title="${esc(`${title}\n${label}：${p.line}\n点一下，在右侧打开这个会话`)}">`
    + `<em class="ap-prog-state">${esc(label)}</em><b>${esc(title)}</b><span>${esc(p.line)}</span><time>${esc(time(e.at))}</time></button>`;
}
const progressBlockHtml = (rows, context) => `<div class="ap-progress" role="group" aria-label="会话进展">${rows.map(e => progressRowHtml(e, context)).join('')}</div>`;
module.exports = { latestProgress, progressBlockHtml };
