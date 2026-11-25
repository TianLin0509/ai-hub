'use strict';
// 助理会话里的「定时任务」回合：每日秘书（计划、总结、今日一档）和交接记录由 Hub 定时发进前台会话，
// 提问卡由 turn-card-renderer 标上 auto-task-q；这里顺着卡片顺序，把它名下的回答卡一并标上 data-auto-task。
function mountAssistantAutoTasks({ document, window }) {
  const overlay = document.getElementById('msg-overlay');
  if (!overlay) return;
  let queued = false;
  const mark = () => {
    queued = false;
    let auto = false;
    for (const card of overlay.children) {
      if (!card.classList.contains('turn-card')) continue;
      if (card.classList.contains('user')) auto = card.classList.contains('auto-task-q');
      if (card.hasAttribute('data-auto-task') !== auto) card.toggleAttribute('data-auto-task', auto);
    }
  };
  // 卡片分批挂载、原位更新时都会改子节点；每帧最多整理一次。
  new window.MutationObserver(() => { if (!queued) { queued = true; window.requestAnimationFrame(mark); } })
    .observe(overlay, { childList: true, subtree: true });
}
// 助理页对话流里的定时通知：今日计划 / 今日总结 / 今日一档的到点推送、助理记忆更新。
const isAutoNotice = entry => entry?.lane === 'notice' && /^notice:(secretary|memory):/.test(String(entry.id || ''));
module.exports = { mountAssistantAutoTasks, isAutoNotice };
