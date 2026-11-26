'use strict';
// 巡逻判定（自动续跑 P1，只提醒）：一个会话现在是不是「疑似停住」、为什么、该给什么提醒。纯函数，线上巡逻和离线回放共用。
// 只凭会话记录的结构 + 运行事实判；靠末句语义的两类（说了等结果、阶段汇报后停）也只是提醒，不会自动发。
//
// 输入：state（transcript-state.summarize 的结果）+ facts（运行事实，线上由主进程填；回放里能推的推、推不了的留空）：
//   now, role('lead'|'member'|null), kind（后端）, processAlive(true/false/null), interruption('hub-restart'|'cli-reopen'|null),
//   turnActive, needsInput, userInputAt, draftPending, intent（停止意图）, closed, autoResumeDisabled
// 输出：{ stalled:false, code, reason } 或
//       { stalled:true, action:'remind'|'login'|'quota', cause, label, evidence, thresholdMs, since }
//       action=remind 给「续跑」按钮；login 只提醒重新登录；quota 只显示「等额度」（交给已有额度续跑 / 换号）。
const { looksLikeAskingUser } = require('./decide');

const VERSION = 'patrol-v1';
const MIN = 60_000;
// wait：说了在等外部结果的，结果常经别的渠道（公司回执、团队消息）几分钟后送到，判停线放宽到 30 分钟（回放：这类手打继续前中位空等 67 分钟以上）。
// teamWait：组队成员 / 负责人在等队友（见下方 TEAM_ROLES）；加上二次确认，约 3 小时才提醒。
const THRESHOLD = { fault: 2 * MIN, exited: 1 * MIN, normal: 5 * MIN, lead: 10 * MIN, wait: 30 * MIN, teamWait: 90 * MIN };
const USER_QUIET_MS = 10 * MIN;
const LABEL = {
  'hub-restart': 'Hub 重启', 'cli-reopen': 'CLI 重开', 'api-error': '网络或服务端错误', 'partial-reply': '回复半截',
  'not-started': '送达未开工', compact: '压缩后没接上', 'wait-lost': '等结果没叫醒', 'stage-stop': '阶段汇报后停',
  login: '需重新登录', quota: '等额度',
};
// 说了在等外部结果 / 会被自动叫醒（最后一段）。
const WAIT_RE = /等.{0,24}(?:结果|回执|跑完|完成|合入|交卷|出来|到齐|回来|结束)|自动(?:叫醒|提醒|送到|通知|回报)|收到.{0,8}(?:就|再|后)(?:接着|继续)?|回来(?:查|看|再)|到时(?:候)?(?:我|再)|(?:完成|跑完|结束|出来)(?:后|之后|了)(?:我|再)|稍后(?:我|再)|过.{0,6}(?:分钟|小时)(?:后|再)/;
const CONT_RE = /(?:接下来|然后|现在|马上|这就)我(?:会|将|去|来|就|先)?(?:接着|继续)?(?:做|跑|改|写|推进|处理|实现|动手|开始)|我(?:接着|继续|马上|这就)(?:做|跑|改|写|推进|处理|实现|动手|开始|干)/;
const COMPACT_CONTINUE = /\[\[hub:compact-continue\]\]\s*$/;

const tailOf = text => { const s = String(text || '').trim(); const paras = s.split(/\n\s*\n/); return paras.slice(-2).join('\n').slice(-500); };
const fmt = ms => ms >= 3600_000 ? `${Math.round(ms / 3600_000 * 10) / 10} 小时` : `${Math.max(1, Math.round(ms / MIN))} 分钟`;
const no = (code, reason) => ({ stalled: false, code, reason });
// 组队里的成员 / 负责人说「等 X 跑完、等结果」：叫醒它的通常是队友经 Hub 发来的消息（hub-team / hub session send），
// 「疑似停住 · 等结果没叫醒」，点进去一切正常）。所以判停线放到 teamWait，不永久沉默：真丢了叫醒照样会提醒。
// 但说了「过 N 分钟回来查 / 稍后我再看」这类自己定时回来的，没人会替它叫醒，仍按 30 分钟判（Codex 审查 11-26）。
const TEAM_ROLES = new Set(['member', 'lead']);
const SELF_TIMED_RE = /回来(?:查|看|再)|到时(?:候)?(?:我|再)|稍后(?:我|再)|过.{0,6}(?:分钟|小时)(?:后|再)|自动(?:叫醒|提醒)/;
const waitGroup = (said, role) => (TEAM_ROLES.has(role) && !SELF_TIMED_RE.test(said) ? 'teamWait' : 'wait');

function thresholdFor(group, role) {
  if (group === 'normal' && (role === 'lead' || role === 'member')) return THRESHOLD.lead;
  if (group === 'wait') return THRESHOLD.wait;
  if (group === 'teamWait') return THRESHOLD.teamWait;
  return THRESHOLD[group];
}

function judgeStall(state = {}, facts = {}) {
  const now = facts.now ?? Date.now();
  const role = facts.role || null;
  const kind = String(facts.kind || 'claude').replace(/-resume$/, '');
  if (facts.closed) return no('closed', '会话已关闭');
  if (facts.autoResumeDisabled) return no('session-disabled', '这个会话关了自动续跑');
  if (facts.intent || state.lastKind === 'interrupted') return no('user-stop', '用户主动停的（按了 Esc 或主动关闭）');
  const lastAt = state.lastAt ?? null;
  if (facts.userInputAt && (now - facts.userInputAt < USER_QUIET_MS || (lastAt != null && facts.userInputAt > lastAt))) return no('user-active', '用户最近在这个会话里操作过');
  if (facts.draftPending) return no('draft', '输入框里有没发出去的内容');
  if (facts.needsInput) return no('needs-input', '在等授权或选择');
  if (state.lastKind === 'local-command') return no('user-active', '用户刚调过设置');
  if (lastAt == null) return no('unknown', '读不到会话记录');
  const exited = facts.processAlive === false;
  const where = facts.interruption === 'hub-restart' ? 'hub-restart' : 'cli-reopen';
  // 非 Claude 后端（Codex、Antigravity 等）：会话记录读法一期只接了 Claude，其余只判进程退出 / 启动失败。
  if (kind !== 'claude' && !exited) return no('backend-limited', '这个后端一期只看进程退出');
  if (facts.turnActive && !exited && state.lastKind !== 'api-error') return no('working', '正在干活');

  let cause = null, group = 'normal', action = 'remind', evidence = '';
  switch (state.lastKind) {
    case 'api-error': {
      const cls = state.errorClass || 'network';
      if (cls === 'quota') { cause = 'quota'; action = 'quota'; group = 'fault'; }
      else if (cls === 'auth') { cause = 'login'; action = 'login'; group = 'fault'; }
      else { cause = 'api-error'; group = 'fault'; }
      evidence = `最后一条是报错：${String(state.errorText).slice(0, 80)}`;
      break;
    }
    case 'partial-reply': cause = 'partial-reply'; group = 'fault'; evidence = '回复写到一半，没有回合结束记录'; break;
    case 'tool-pending':
      if (!exited) return no('tool-running', '工具还在执行');
      cause = where; group = 'exited'; evidence = '工具调用没返回，CLI 进程已退出'; break;
    case 'tool-result-unanswered': cause = 'not-started'; evidence = '工具结果回来了，之后没有下文'; break;
    case 'message-unanswered': cause = 'not-started'; evidence = '消息送达了，没开出新回合'; break;
    case 'notification-unanswered':
      if (state.orphanExit) { cause = where; group = 'exited'; evidence = '后台任务随上一个 Claude 进程退出，通知来了没人接'; }
      else { cause = 'wait-lost'; evidence = '后台任务的结果通知来了，没有回应'; }
      break;
    case 'compact':
      // 压缩前回合已正常结束：按回合结束那一套判（已交卷 / 等拍板 / 说了等结果），只有写了「压缩后继续」才算没接上。
      if (state.preCompactKind === 'turn-end') {
        if (looksLikeAskingUser(state.lastAssistantText)) return no('asking-user', '最后一条回复在等用户拍板');
        if (COMPACT_CONTINUE.test(String(state.lastAssistantText || '').trim())) { cause = 'compact'; evidence = '写了压缩后继续的标记，压缩完没接上'; break; }
        if (WAIT_RE.test(tailOf(state.lastAssistantText)) && !(state.bgPending > 0)) {
          cause = 'wait-lost'; group = waitGroup(tailOf(state.lastAssistantText), role);
          evidence = group === 'teamWait' ? '组队中说了在等队友结果，压缩后很久没被叫醒' : '说了在等结果，压缩后没有能叫醒它的后台任务'; break;
        }
        return no('delivered', '压缩前回合已正常结束（已交卷）');
      }
      cause = 'compact'; evidence = '回合中途压缩，之后没有接着干'; break;
    case 'turn-end': {
      const said = tailOf(state.lastAssistantText);
      if (looksLikeAskingUser(state.lastAssistantText)) return no('asking-user', '最后一条回复在等用户拍板');
      if (state.bgPending > 0) {
        if (exited || facts.interruption) { cause = facts.interruption ? where : 'cli-reopen'; group = 'exited'; evidence = `挂着 ${state.bgPending} 个后台任务，进程已经没了`; break; }
        return no('waiting-background', `挂着 ${state.bgPending} 个后台任务，进程还在，正常等待`);
      }
      if (WAIT_RE.test(said)) {
        cause = 'wait-lost'; group = waitGroup(said, role);
        evidence = group === 'teamWait' ? '组队中说了在等队友结果，很久没被叫醒' : '说了在等结果 / 会被叫醒，但没挂着能叫醒它的后台任务'; break;
      }
      if (COMPACT_CONTINUE.test(String(state.lastAssistantText || '').trim())) { cause = 'compact'; evidence = '写了压缩后继续的标记，之后没接上'; break; }
      if (CONT_RE.test(said)) { cause = 'stage-stop'; evidence = '说了自己接着做，回合却结束了'; break; }
      return no('delivered', '回合正常结束，没有挂着的事（已交卷）');
    }
    default: return no('not-stalled', '');
  }
  const thresholdMs = thresholdFor(group, role);
  const idle = now - lastAt;
  if (idle < thresholdMs) return no('below-threshold', `停了 ${fmt(idle)}，还没到 ${fmt(thresholdMs)} 的判停线`);
  return { stalled: true, action, cause, label: LABEL[cause], evidence, thresholdMs, since: lastAt, idleMs: idle, idleText: fmt(idle), version: VERSION };
}

module.exports = { judgeStall, VERSION, THRESHOLD, LABEL, WAIT_RE, CONT_RE };
