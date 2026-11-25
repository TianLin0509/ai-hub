'use strict';

const PREFIX = '请简短回答（10 行以内）：';
const normalize = value => String(value || '').replace(/\s+/g, '');

function footerStart(lines) {
  // "Esc to close" in the main answer is not proof of an overlay. Match the
  // real navigation/copy/fork footer, including narrow-terminal line wraps.
  const footer = /^(?:↑\/↓ to scroll|⇧←\/→ to browse)\s*·\s*c to copy\s*·\s*f to fork\s*·\s*(?:x to clear history\s*·\s*)?Esc to close$/;
  for (let end = lines.length - 1; end >= 0; end--) {
    // Narrow panes can wrap anywhere inside the footer, even "Esc / to close".
    if (!/\bclose\s*$/.test(lines[end])) continue;
    for (let start = end; start >= Math.max(0, end - 5); start--) {
      if (footer.test(lines.slice(start, end + 1).map(line => line.trim()).join(' '))) return start;
    }
  }
  return -1;
}

// Only overlay headers count: the editor echo starts with ❯, not /btw.
function lastBtwQuestion(lines, end = lines.length) {
  for (let i = end - 1; i >= 0; i--) {
    const match = /^\s*\/btw(?:\s+|$)(.*)$/.exec(lines[i]);
    if (!match) continue;
    let question = match[1];
    let next = i + 1;
    // History view (CLI 2.1.317+, second /btw onward) clips each question to
    // one row ending in "…"; the next row may already be the answer.
    if (TRUNCATED.test(question.trimEnd())) return { question, answerStart: next };
    // Long questions wrap before the blank line separating the answer.
    while (next < end && lines[next].trim() && !/^\s*\/btw\b/.test(lines[next])) question += lines[next++].trim();
    return { question, answerStart: next };
  }
  return null;
}

const TRUNCATED = /(?:…|\.\.\.)$/;
function sameQuestion(shown, expected) {
  const s = normalize(shown);
  if (s === expected) return true;
  if (!TRUNCATED.test(s)) return false;
  // Clipped header: the visible part must be a non-trivial prefix. Hub closes
  // any old overlay before submitting, so a prefix match right after submit
  // can only be this ask.
  const head = s.replace(TRUNCATED, '');
  return head.length >= Math.min(expected.length, 8) && expected.startsWith(head);
}

function btwQuestionVisible(screenText, question) {
  const lines = String(screenText || '').split(/\r?\n/);
  const footer = footerStart(lines);
  const header = lastBtwQuestion(lines, footer < 0 ? lines.length : footer);
  return !!header && (!question || sameQuestion(header.question, normalize(question))
    || sameQuestion(header.question, normalize(PREFIX + question)));
}

function parseBtwOverlay(screenText, question) {
  const lines = String(screenText || '').split(/\r?\n/);
  const footer = footerStart(lines);
  const open = footer >= 0;
  const empty = { open, answer: '', complete: false, truncated: false };
  if (!open) return empty;
  const header = lastBtwQuestion(lines, footer);
  if (!header || !btwQuestionVisible(screenText, question)) return empty;
  const body = lines.slice(header.answerStart, footer);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body.at(-1).trim()) body.pop();
  const indent = Math.min(...body.filter(line => line.trim()).map(line => line.match(/^\s*/)[0].length));
  const answer = body.map(line => line.slice(Number.isFinite(indent) ? indent : 0).trimEnd()).join('\n');
  // These are standalone loading rows, not mentions of "thinking" in prose.
  const loading = body.some(line => /^\s*(?:[✻✽✶✳✢·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*)?(?:Thinking|Loading|Working|Generating|思考中|加载中|生成中)(?:[.…\s]|$)/i.test(line));
  // A scroll footer is also used for short answers. Flag dense/no-gap/ellipsis
  // views conservatively; never claim we fetched the off-screen text.
  const truncated = /↑\/↓ to scroll/.test(lines[footer]) && (body.length >= 10
    || (answer && lines[footer - 1]?.trim()) || /(?:…|\.{3}|[↓▼])\s*$/.test(answer));
  return { open, answer, complete: !!answer && !loading, truncated: !!truncated };
}

module.exports = { parseBtwOverlay, btwQuestionVisible, PREFIX };
