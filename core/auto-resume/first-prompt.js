'use strict';
// 读 Claude 会话记录（transcript JSONL）开头的第一条用户消息，用来判断首条任务是否写了「不要自动续」。
// 只读开头 256 KB，不读整份记录。
const fs = require('node:fs');

const HEAD_BYTES = 256 * 1024;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n');
  return '';
}

function readFirstUserText(transcriptPath) {
  if (!transcriptPath) return '';
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row?.type !== 'user' || row.isMeta || row.isSidechain) continue;
      const text = textOf(row.message?.content).trim();
      if (text && !text.startsWith('<')) return text.slice(0, 4000);
    }
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return '';
}

const TAIL_BYTES = 128 * 1024;
function readLastAssistantText(transcriptPath) {
  if (!transcriptPath) return '';
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let row; try { row = JSON.parse(lines[i]); } catch { continue; }
      if (row?.type !== 'assistant' || row.isSidechain) continue;
      const text = textOf(row.message?.content).trim();
      if (text) return text.slice(-4000);
    }
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return '';
}

module.exports = { readFirstUserText, readLastAssistantText };
