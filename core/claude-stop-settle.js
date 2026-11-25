'use strict';
// Stop hook 收尾兜底（2026-11-09）。
//
// Claude Code 在后台任务结束、Monitor 出事件、定时唤醒（/loop、ScheduleWakeup）时会自己注入一轮续跑，
// 同样发 UserPromptSubmit，Hub 据此记「回合开始」。但这几类回合没有真人用户记录：transcript 对齐
// （core/claude-turn-alignment.js 的 human() 明确排除 <task-notification>，重复的定时提示词也对不上唯一记录）
// 只能发 turn-pending，从不发 turn-complete，于是回合状态永远停在「运行中」：
//   - 闲置巡检对 PTY 会话按 pty-turn-unfinished 一律跳过，挂着监视器的会话永远不会自动休眠；
//   - 组队心跳把它当「运行中却没输出」，每段静默都提醒负责人一次「可能卡住」。
// 2026-11-09 生产诊断快照里 51753569（task-notification）与 1446ef4c（scheduled_task_fire）两例实证：
// Stop hook 已触发（stop_hook_summary），45 / 29 分钟后 Hub 仍判回合未结束。
//
// Stop hook 本身就是「主代理这一轮答完了」的权威信号（子代理的 Stop 在上游已被过滤）。所以：
// Stop 触发的对齐拿不到可展示的完整答复（turn-pending）时，只把回合状态收尾，不伪造 turn-complete，
// 卡片、通知、群聊收口仍走原来的对齐链路。原生后端的回合状态由引擎自报，不在这里改。
function settleTurnOnStopPending(sessionManager, event, now = Date.now()) {
  if (!event || !event.hubSessionId || event.signalSource !== 'stop_hook') return false;
  const session = sessionManager && typeof sessionManager.getSession === 'function'
    ? sessionManager.getSession(event.hubSessionId) : null;
  if (!session || session.runtimeBackend) return false;
  if (typeof sessionManager.isAgentTurnActive === 'function' && !sessionManager.isAgentTurnActive(event.hubSessionId)) return false;
  // 不带 turnId：续跑回合的 hook 编号本来就对不上对齐结果，带上反而会被当成别的回合拒掉。
  return sessionManager.noteAgentTurnFinished(event.hubSessionId, { completedAt: now }) === true;
}

module.exports = { settleTurnOnStopPending };
