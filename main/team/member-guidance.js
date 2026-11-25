'use strict';

// 开工消息只给当前宿主可用的入口；具体派活权限以该宿主的 skill 为准。
function delegationGuidance(kind) {
  if (kind === 'codeagent') return '本团队只使用 CodeAgent；需要额外人手向负责人说明。';
  if (kind === 'codex') return 'Codex 成员使用宿主已授权的原生子 Agent。需要独立成员向负责人说明。';
  return '短作业先读当前宿主实际可见的派活 skill，按其能力与授权选择通道；需要独立成员向负责人说明。';
}

// 交付/汇报回执格式（skill v2.2.0 定的「成员短回执」，开工就交给每位成员，不靠负责人转述）。
const RECEIPT_FORMAT = [
  '交付或汇报的回执格式：',
  '1. 一句结论：讲领域里的结果（哪一环已对齐、指标从多少到多少、功能能不能用），不讲做了哪些步骤；负责人问过问题的，这句先正面回答它；',
  '2. 对照验收标准逐条写达到与否；',
  '3. 证据位置（命令与输出摘要、文件:行号、截图路径）；',
  '4. 未完成项与风险。',
  '尽量控制在 300 字内，原始材料留在磁盘、消息里只给路径。',
];

// Claude 系（含 CodeAgent）由 Hub 的同步 hook 硬拦（main/team/member-guard.js）；其余后端暂时只靠这段约定。
const GUARD_KINDS_ENFORCED = new Set(['claude', 'claude-resume', 'codeagent', 'deepseek-claude']);
function guardGuidance(kind, access, { company = false } = {}) {
  // 公司版 hook 走 PowerShell 脚本，没有这条判定：只靠约定。
  const enforced = !company && GUARD_KINDS_ENFORCED.has(String(kind || ''));
  const lines = [
    `权限边界：以下 5 类动作${enforced ? ' Hub 会直接拦下并报告负责人' : '（这一后端 Hub 拦不了，只靠任务书约束）先停下、用 send --to lead --wake 交负责人判断，不自行执行'}：` +
      '① git push、合入或改写 master/main；② 关闭/重启/kill 生产 Hub，或按进程名、命令行子串成批杀进程；' +
      '③ 删除任务目录（工作目录、你开的 worktree、临时目录）以外的文件；④ 改 Hub 生产数据目录的配置与状态；⑤ 读取或使用 DeepSeek/Anthropic/OpenAI 的 API Key。' +
      '被拦时不换命令或通道绕过，等负责人放行或改做法。',
  ];
  if (access === 'read') {
    const how = kind === 'codex' ? '（Codex 起在只读沙箱里）' : enforced ? '（Hub 拒绝写文件，临时目录除外）' : '（这一后端只靠这条约定，请自觉遵守）';
    lines.push(`你是只读成员${how}：只读代码、跑只读检查，结论写进回执；不改文件、不提交。`);
  }
  return [...lines, ''];
}

module.exports = { delegationGuidance, guardGuidance, RECEIPT_FORMAT };
