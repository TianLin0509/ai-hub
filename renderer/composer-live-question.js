'use strict';
// composer「等你回答」的屏幕探测（从 renderer.js detectComposerLiveQuestion 抽出，便于单测）。
//
// 2026-11-23 返工：Antigravity（agy）在终端里原样回显整条用户消息，组队开工消息里的编号清单
// （「2. 对照验收标准…」）加上「哪一环」被当成选择题，成员卡片底部误显示
// 「Antigravity 在等你回答：「────」」和两个快捷答复按钮，点了会把开工消息的片段发给成员。
// agy 真正要用户选的弹窗（信任目录、配色、条款、登录）由 core/terminal-runtime-state.js 的
// classifyAntigravity 按固定文案识别，不靠这里猜；所以 agy 不走「编号清单 + 疑问词」这条启发式。
// 分隔线「────」是输入框边框，不是 AI 说的话，不进问题摘要。Claude / Codex 的判定不变。
const { isWaitingForUser } = require('./terminal-activity-monitor');

const PROMPT_PREFIX_RE = /^[\s│╭─╮╰╯]*[❯›>]\s+/;
const EMPTY_PROMPT_RE = /^[\s│╭─╮╰╯]*[❯›>]\s*$/;
const RULE_RE = /^\s*[─━═┄┈╌]{3,}[\s─━═┄┈╌]*$/;

// CLI 的输入框以下全是 TUI 装饰（状态栏、快捷键提示），在输入框那一行把尾巴切断。
function tailAboveCliPrompt(lines) {
  let cut = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] || '';
    if (PROMPT_PREFIX_RE.test(line) || EMPTY_PROMPT_RE.test(line)) { cut = i; break; }
  }
  return cut < 0 ? lines : lines.slice(0, cut);
}

function dropTrailingRules(lines) {
  let end = lines.length;
  while (end > 0 && (!String(lines[end - 1] || '').trim() || RULE_RE.test(lines[end - 1]))) end -= 1;
  return lines.slice(0, end);
}

const isAntigravity = kind => /^gemini(?:-resume)?$/.test(String(kind || ''));

/** 返回 { verdict, tail } 或 null。verdict.text 不会是分隔线。 */
function composerQuestionVerdict(kind, lines) {
  const raw = tailAboveCliPrompt(Array.isArray(lines) ? lines : []);
  if (!raw.length) return null;
  const agy = isAntigravity(kind);
  const tail = agy ? dropTrailingRules(raw) : raw;
  if (!tail.length) return null;
  const verdict = isWaitingForUser(tail);
  if (!verdict || !verdict.waiting) return null;
  let text = String(verdict.text || '');
  if (agy && verdict.reason === 'choice') {
    // 编号清单多半来自回显的用户消息；agy 自己以问句收尾时仍按「问句」提示（与检测器同一规则）。
    if (!(text.length < 200 && /[?？]\s*$/.test(text))) return null;
    return { verdict: { waiting: true, reason: 'question', text }, tail };
  }
  if (RULE_RE.test(text)) {
    const words = dropTrailingRules(tail).filter(line => String(line || '').trim() && !PROMPT_PREFIX_RE.test(line));
    text = words.length ? String(words[words.length - 1]).trim() : '';
  }
  return { verdict: { ...verdict, text }, tail };
}

module.exports = { composerQuestionVerdict, tailAboveCliPrompt, dropTrailingRules };
