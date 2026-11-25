'use strict';

// 生命周期、焦点和时钟只发布缓存；联网仅来自用户手动刷新。
// 旧 policy 导出保留给兼容调用方，不再用于触发请求。
const CLAUDE_USAGE_REFRESH_POLICY = Object.freeze({ minMs: 30_000, activeMs: 60_000, idleMs: 300_000, maxBackoffMs: 300_000 });

function createClaudeUsageRefresh({ refresh, getSessions, getCached, publish,
  onError = error => console.warn('[claude-usage] refresh failed:', error.message) }) {
  let flight = null, stopped = false;
  function tick() {
    if (!stopped) {
      const cached = getCached();
      if (cached) publish(cached);
    }
    return Promise.resolve(null);
  }
  function manualRefresh() {
    if (stopped) return Promise.resolve(null);
    if (flight) return flight;
    const sessions = getSessions();
    flight = Promise.resolve().then(refresh).then(result => {
      if (sessions.length && result?.source !== 'claude-native') throw new Error('Claude 未返回新的账号额度，保留上次数据');
      if (!stopped && result?.data) publish(result.data);
      return result;
    }).catch(error => { onError(error); throw error; }).finally(() => { flight = null; });
    return flight;
  }
  return { tick, refresh: manualRefresh, stop: () => { stopped = true; } };
}

module.exports = { createClaudeUsageRefresh, CLAUDE_USAGE_REFRESH_POLICY };
