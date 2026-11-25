'use strict';
// CLI 冷启动超时（就绪检查 60 秒没过）时，把终端最后一屏落盘，失败提示里带上路径（2026-11-23）。
// 只能猜根因。文件放 Hub 数据目录 diagnostics/cli-start-timeouts，只保留最新 KEEP 份。
const fs = require('fs');
const path = require('path');

const KEEP = 50;
const SCREEN_LINES = 40;

function stamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function lastScreen(buf) {
  const text = require('./group-chat-cli-ready-detector').terminalText(String(buf || '').slice(-20000));
  const lines = text.split('\n').map(line => line.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-SCREEN_LINES).join('\n');
}

/** 写一份超时现场，返回文件路径；写不了返回 ''（只是诊断，不影响主流程）。 */
function dumpStartTimeout({ dataDir, sid, kind, buf, waitedMs }) {
  try {
    const dir = path.join(dataDir || require('./data-dir').getHubDataDir(), 'diagnostics', 'cli-start-timeouts');
    fs.mkdirSync(dir, { recursive: true });
    const safeSid = String(sid || 'unknown').replace(/[^\w-]/g, '').slice(0, 8) || 'unknown';
    const safeKind = String(kind || 'cli').replace(/[^\w-]/g, '').slice(0, 20) || 'cli';
    const file = path.join(dir, `${stamp()}-${safeSid}-${safeKind}.txt`);
    const raw = String(buf || '');
    const body = [
      `会话 ${sid}  后端 ${kind}  等了 ${Math.round((Number(waitedMs) || 0) / 1000)} 秒仍未识别到输入框`,
      `终端累计 ${raw.length} 字符；下面是还原成文字后的最后 ${SCREEN_LINES} 行：`,
      '----',
      lastScreen(raw),
      '----',
      '原始字节末尾（JSON 转义）：',
      JSON.stringify(raw.slice(-4000)),
      '',
    ].join('\n');
    fs.writeFileSync(file, body, 'utf8');
    prune(dir);
    return file;
  } catch { return ''; }
}

function prune(dir) {
  try {
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.txt')).sort();
    for (const name of files.slice(0, Math.max(0, files.length - KEEP))) fs.unlinkSync(path.join(dir, name));
  } catch { /* 清理失败下次再清 */ }
}

module.exports = { dumpStartTimeout, lastScreen, KEEP };
