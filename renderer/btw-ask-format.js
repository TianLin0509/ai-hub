'use strict';
// 「问一下」答案排版：Claude /btw 的回答是从终端浮层抄下来的，按终端宽度硬折了行
// （一句话在「200\n拍」处断开、续行缩进几格）。显示前先把这种折行接回去，再按 markdown 渲染，
// 和卡片视图的正文一样有段落、编号列表、加粗和行内代码。

// 终端里中日韩字符和多数 emoji 占两格。
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}]/u;
const displayWidth = line => { let w = 0; for (const ch of line) w += WIDE.test(ch) ? 2 : 1; return w; };
// 以这些开头的行是新块（列表项、标题、引用、表格、代码围栏），不接到上一行后面。
const BLOCK_START = /^\s*(?:[-*+•]\s|\d+[.)]\s|#{1,6}\s|>|\||```|📌)/u;
const ASCII_END = /[A-Za-z0-9%)\]`'".,;:!?+\-/]$/;
const ASCII_START = /^[A-Za-z0-9(`'"[]/;
const CJK_PUNCT_END = /[，。：；、！？）】」』]$/;
// 折行处离终端右边界最多差一个英文单词。
const WRAP_SLACK = 14;
const MIN_WRAP_WIDTH = 40;

function unwrapTerminalText(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n').map(line => line.replace(/\s+$/, ''));
  const widths = lines.map(displayWidth);
  const max = Math.max(0, ...widths);
  if (max < MIN_WRAP_WIDTH) return lines.join('\n');
  const out = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const wrapped = i > 0 && !fenced && line.trim() && lines[i - 1].trim()
      && !BLOCK_START.test(line) && widths[i - 1] >= max - WRAP_SLACK;
    if (!wrapped) { out.push(line); return; }
    const head = out[out.length - 1], tail = line.trim();
    const space = !CJK_PUNCT_END.test(head) && (ASCII_END.test(head) || ASCII_START.test(tail)) ? ' ' : '';
    out[out.length - 1] = head + space + tail;
  });
  return out.join('\n');
}

// 「**白话解读：**OSCA」这种写法：收尾的 ** 前是全角标点、后面紧跟文字，按 CommonMark 不算收尾，
// 整段会露出星号。把这个标点挪到 ** 外面（「**白话解读**：」），显示只差标点不加粗。
const fixCjkStrong = text => text.replace(/\*\*([^*\n]+?)([：；，。！？、])\*\*/g, '**$1**$2');
const escapeHtml = raw => String(raw).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let markedInstance = null;
// 单独的 marked 实例：关掉「缩进 4 格即代码块」（终端回答常带缩进，会被误当成代码），不改全局 marked。
const purify = html => require('dompurify').sanitize(html, { FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'style', 'form', 'input'] });
function renderAnswerHtml(text, { engine, sanitize = purify } = {}) {
  if (!markedInstance) {
    const { Marked } = require('marked');
    // 裸 HTML 一律当文字显示，与卡片视图的 marked 配置一致（否则 a<b、List<String> 会吞掉后文）。
    markedInstance = new Marked({ gfm: true, breaks: true, tokenizer: { code() { return undefined; } },
      renderer: { html(token) { return escapeHtml(typeof token === 'string' ? token : token?.text ?? token?.raw ?? ''); } } });
  }
  // Codex 与 DSH 的回答不经终端，原文换行就是作者的换行。
  const source = fixCjkStrong(engine === 'codex' || engine === 'dsh' ? String(text || '') : unwrapTerminalText(text));
  return sanitize(markedInstance.parse(source, { async: false }));
}

module.exports = { unwrapTerminalText, renderAnswerHtml, displayWidth };
