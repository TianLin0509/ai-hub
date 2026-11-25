'use strict';
// 自动续跑判定（P0）：Hub 重启和 CLI 重开两个触发点共用这一个纯函数；真正写入输入框前还会用它再判一次。
// 只凭故障证据续：最近一次回合结束时挂着后台任务（快照非空），而它所在的进程已经没了。
// 任一排除条件命中就不发，返回原因给助理页和账本。宁可漏续，不误续。
const { isClaudeFamily } = require('../ai-kinds');

const TTL_MS = 24 * 3600_000;
const STOP_INTENT = new Set(['user-close', 'manual', 'user-suspend', 'assistant-rotated', 'team-delivered', 'team-dismissed']);
const OPT_OUT_RE = /不要自动续|别自动续|禁止自动续|不要自动继续/;
const REASON = { 'hub-restart': 'Hub 重启', 'cli-reopen': 'CLI 进程重开' };
//   1) 末行以问号结尾；
//   2) 请他拍板 / 确认 / 决定 / 回复的说法，含「你回 X」「回 1 或 2」「回个数字」「选哪个」「要不要」「行不行」；
//   3) 编号选项：末尾有 ≥2 条编号项（1. / 1、/ ① / A. / 方案一），并带「推荐」或「选 / 回」字眼。
// 宁可多拦：误拦只是不自动发、卡片上多一个「续跑」按钮；漏判才会误发，所以规则往宽里写。
const ASK_RE = new RegExp([
  '拍板', '你回一句', '回一行', '回我一句', '回复一下', '等你(?:的)?(?:确认|回复|决定|拍板|回话|一句)?', '待你', '你说了算', '听你的', '请指示',
  '请你?(?:确认|决定|选择|选|定一下|看一下|回复|回)', '你(?:看|定|选)(?:一下)?(?:哪|行不行|可以吗|如何|吧)',
  '你回\\s*[：:]?\\s*[0-9A-Za-z一二三四五①-⑩「“"]', '回(?:复|我)?\\s*[0-9A-Da-d一二三①-⑩]+\\s*(?:或|还是|\\/|／|、|即可|就行)', '回(?:个|一个)?(?:数字|编号|序号)',
  '选哪', '(?:选|用|走)\\s*\\S{1,12}?\\s*还是', '哪个(?:方案|更好|好)', '要不要', '行不行', '可不可以', '是否(?:需要|同意|继续|可以|要)', '需要你', '待确认',
].join('|'));
const OPTION_LINE = /^\s*(?:[*_]{0,2})(?:[0-9]{1,2}\s*[.、)）:：]|[①-⑩]|[A-Da-d]\s*[.、)）:：]|方案\s*[一二三四五A-Da-d0-9])/;
const OPTION_HINT = /推荐|建议选|选|回/;

function looksLikeAskingUser(text) {
  const tail = String(text || '').trim().slice(-800);
  if (!tail) return false;
  // 有人把选项写在一行里、用「／」隔开，按换行看待。
  const lines = tail.split(/\n|／/).map(s => s.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || '';
  if (/[？?]\s*[*_`）)」』]*$/.test(lastLine) || ASK_RE.test(tail)) return true;
  return lines.filter(l => OPTION_LINE.test(l)).length >= 2 && OPTION_HINT.test(tail);
}

function skip(code, reason, extra = {}) { return { send: false, code, reason, ...extra }; }

function decideAutoResume(input = {}) {
  const { enabled = true, snapshot, now = Date.now(), ttlMs = TTL_MS, session = null, cliStarted = null, intent = null,
    userInputAt = 0, firstPromptText = '', lastReplyText = '', claimedBy = null, accountSwitching = false,
    origin = 'background', expectedSnapAt = null, expectedCliGen = null, currentCliGen = null } = input;
  if (!enabled) return skip('disabled', '自动续跑总开关已关');
  if (!snapshot || !Array.isArray(snapshot.tasks) || !snapshot.tasks.length) return skip('no-snapshot', '上一轮结束时没有挂着后台任务');
  // 排队期间会话又结束了一轮（新快照）或 CLI 又换了一个进程：这次任务作废，按新情况另判。
  if (expectedSnapAt != null && snapshot.at !== expectedSnapAt) return skip('snapshot-changed', '等待期间会话又结束了一轮，这次续跑作废');
  if (expectedCliGen && currentCliGen && currentCliGen !== expectedCliGen) return skip('cli-changed', '等待期间 CLI 又重开了一次，这次续跑作废');
  if (now - (snapshot.at || 0) > ttlMs) return skip('expired', '后台任务快照已超过 24 小时，可能早已过时');
  if (!session) return skip('closed', '会话已删除或关闭');
  if (session.closed) return skip('closed', '会话已关闭');
  const base = String(session.kind || '').replace(/-resume$/, '');
  if (!isClaudeFamily(base)) return skip('not-claude', '不是 Claude 会话，P0 只提醒不自动续');
  if (session.autoResumeDisabled === true) return skip('session-disabled', '这个会话关了自动续跑');
  if (session.meetingId) return skip('group-member', '群聊成员由群聊流程续作，P0 只提醒');
  if (intent || snapshot.stoppedReason || STOP_INTENT.has(session.suspendReason) && session.suspendedAt > snapshot.at) {
    return skip('user-stop', intent?.reason === 'esc' ? '这一轮用户按过 Esc 停止' : '快照之后会话被主动关闭或休眠');
  }
  if (snapshot.userInputAt || userInputAt > snapshot.at) return skip('user-typed', '快照之后用户在这个会话里操作过（打字或改草稿）');
  if (snapshot.supersededAt) return skip('new-turn', '快照之后会话又开了新回合');
  if (snapshot.needsInputAt) return skip('needs-input', '快照之后弹过授权或待决策窗口，需要用户处理');
  if (session.turnActive) return skip('turn-active', '会话正在跑新回合');
  if (accountSwitching) return skip('account-switch', '换号流程正在重开会话，由它自己发继续');
  if (session.accountRisk) return skip('account-risk', '账号有风险标记，不自动续');
  if (snapshot.authErrorAt) return skip('auth-error', '最近一次报了鉴权错误，不自动续');
  // CLI 重开后原生身份必须接得上：同一个 id，或从快照那个 id 分叉出来（换号重开会分叉）。
  if (cliStarted && snapshot.ccSessionId && cliStarted.ccSessionId && cliStarted.ccSessionId !== snapshot.ccSessionId
      && cliStarted.forkedFrom !== snapshot.ccSessionId) return skip('identity', 'CLI 重开后接的不是原来那段对话');
  if (OPT_OUT_RE.test(String(firstPromptText || ''))) return skip('opted-out', '首条任务写了不要自动续');
  if (claimedBy) return skip('claimed', `已由${require('./claims').ownerLabel(claimedBy)}接手`);
  if (looksLikeAskingUser(lastReplyText)) return skip('asking-user', '它最后一条回复在等你拍板', { canResume: true });
  if (origin !== 'background') return skip('manual-open', '你亲自打开了这个会话，由你决定是否续跑', { canResume: true });
  return { send: true, code: 'send', reason: '上一轮结束时挂着后台任务，已随进程退出' };
}

function resumeText(trigger) {
  return `【Hub 自动续跑 · 原因：${REASON[trigger] || REASON['cli-reopen']}】你上一轮结束时挂着后台任务，它们已随进程退出而丢失。先自查再动手：1) 读进展卡和你最后一条回复，列出已完成和未完成；2) 核对最后一个工具操作的实际结果（文件、进程、远端作业），已完成的不要重做；3) 先确认要等的作业还在，再按原参数重挂监视，不要重跑作业本身；4) 下一步若涉及删除数据、花钱、对外发布、刷固件或要用户拍板，停下写明待确认；5) 任务其实已完成就只回 [[hub:no-update]]。然后从中断处继续。`;
}

// 巡逻提醒上点「续跑」发的话（P1）：按停住的原因带一句说明，自查步骤与 P0 相同。
function patrolResumeText(label) {
  return `【Hub 续跑 · 原因：${label || '疑似停住'}】你上一轮在没做完时停住了。先自查再动手：1) 读进展卡和你最后一条回复，列出已完成和未完成；2) 核对最后一个工具操作的实际结果（文件、进程、远端作业），已完成的不要重做；3) 你挂的后台监视或轮询若已丢失，先确认要等的作业还在，再按原参数重挂，不要重跑作业本身；4) 下一步若涉及删除数据、花钱、对外发布、刷固件或要用户拍板，停下写明待确认；5) 任务其实已完成就只回 [[hub:no-update]]。然后从停住的地方继续。`;
}

module.exports = { decideAutoResume, resumeText, patrolResumeText, looksLikeAskingUser, STOP_INTENT, TTL_MS, REASON };
