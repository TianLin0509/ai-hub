'use strict';

const { latestActivityTime, positiveTimestamp } = require('./session-recency');
const { sessionNeedsUserInput } = require('./session-attention-state');

const STALE_COMPLETED_MS = 3 * 86400000;
const ENDED_REASONS = new Set(['user-suspend', 'user-close', 'manual']);

// Presentation only: never clear unread, suspend a writer or remove history.
// A completed turn is not proof that the whole task is done. Keep all explicit
// requests for input, errors, active work and user-selected/pinned entries.
function sidebarMustStayVisible(item, classification, { selected = false, pending = false } = {}) {
  return !!(selected || pending || item.pinned || item._resumePending
    || classification.working || classification.waiting || classification.error
    || sessionNeedsUserInput(item) || item.needsUserInput === true);
}

function hasCompletionEvidence(item, classification, { dismissed = false } = {}) {
  const completed = positiveTimestamp(item.lastCompletedAt);
  const started = Math.max(positiveTimestamp(item.runStartedAt), positiveTimestamp(item.lastRunStartedAt),
    positiveTimestamp(item._attentionClock?.lastPromptAt));
  // A newer unfinished turn must not inherit the previous turn's completion.
  if (started > completed) return false;
  return completed > 0 || dismissed || (classification.dormant && ENDED_REASONS.has(item.suspendReason));
}

function sidebarCompletedAndStale(item, classification, { now = Date.now(), dismissed = false } = {}) {
  if (sidebarMustStayVisible(item, classification)) return false;
  const at = latestActivityTime(item);
  return !!at && now - at >= STALE_COMPLETED_MS && hasCompletionEvidence(item, classification, { dismissed });
}

// 用户主动隐藏高于置顶和「正在看」，只有真正要他处理或还在跑的才临时露出来。
function sidebarHiddenNeedsUser(item, classification, { pending = false } = {}) {
  return sidebarMustStayVisible({ ...item, pinned: false }, classification, { pending });
}

module.exports = { STALE_COMPLETED_MS, sidebarMustStayVisible, sidebarCompletedAndStale, sidebarHiddenNeedsUser };
