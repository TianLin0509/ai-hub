'use strict';
const { getSessionRuntimeTruth } = require('./session-runtime-truth');
const { hasStreamDisconnectIssue } = require('./stream-disconnect');

// Attention is a projection, not another runtime state writer. In particular a
// disconnected native runtime remains unknown until the provider reconciles it.
function sessionRuntimeIssue(session, truth = getSessionRuntimeTruth(session)) {
  if (!session || session.status === 'dormant' || truth.state === 'dormant') return null;
  // 自动续跑巡逻器（P1）：疑似停住，只提醒；在「当前概览 → 续跑」Tab 里一键续跑或忽略。
  // 排在「运行异常」前面：报错后停住正是巡逻的结论，证据里已带报错原文，悬停能看到怎么接上。
  if (session.patrolStall && !(truth && (truth.state === 'running' || truth.state === 'starting'))) {
    const p = session.patrolStall;
    return { label:'疑似停住', message:`${p.label}：${p.evidence}（已停 ${p.idleText}）。在「当前概览 → 续跑」里续跑或忽略` };
  }
  if (truth.state === 'failed') return { label:'运行异常', message:truth.evidence || truth.reason || session.lastError || '本轮执行失败' };
  if (hasStreamDisconnectIssue(session)) return { label:'连接异常', message:session.connectionIssue.message || '连接已中断' };
  if (unfinishedTurnPending(session, truth)) return { label:'上轮未完成', message:session.unfinishedTurn.message || '上轮没做完进程就停了' };
  const native = session.nativeRuntime;
  if (native?.connection === 'disconnected' && native.state !== 'interrupted' && !session._resumePending) {
    return { label:'连接异常', message:native.reason || '连接已断开，状态待核对' };
  }
  // Claude 的一条提交没拿到收到证据、连接仍在：下一次发送会自动恢复，输入框只
  // 平静地说一句，侧栏也不再亮「待核对」（2026-09-24 用户决定）。
  const quietClaudeReceipt = session.runtimeBackend === 'claude-stream-json' && native?.connection === 'connected'
    && native?.cancellation?.status !== 'unknown';
  if (!quietClaudeReceipt && (native?.submission?.status === 'unknown' || native?.submission?.sendStatus === 'unknown')
      || native?.cancellation?.status === 'unknown') {
    return { label:'状态待核对', message:native.reason || '提交或停止操作尚未获得原生确认' };
  }
  return null;
}
// 「上轮未完成」由 core/unfinished-turn.js 扫原生记录得出，只对没有进程的会话下结论。
// 之后只要出现了新一轮（开工或收工时间晚于记录最后一次写入），或用户已点开看过，就撤掉。
function unfinishedTurnPending(session, truth) {
  const mark = session && session.unfinishedTurn;
  if (!mark || mark.acknowledged) return false;
  if (truth && (truth.state === 'running' || truth.state === 'starting' || truth.state === 'waiting')) return false;
  const lastAt = Number(mark.lastAt) || 0;
  if ((Number(session.runStartedAt) || 0) > lastAt) return false;
  if ((Number(session.lastCompletedAt) || 0) > lastAt) return false;
  return true;
}
module.exports = { sessionRuntimeIssue, unfinishedTurnPending };
