'use strict';
// 全部是本机读取，不联网；只存显示用的名字和它的来源，不存邮箱、也不存没用上的其他名字。
// 读 git 走异步子进程（隐藏窗口），不阻塞主进程；缓存 7 天内直接用缓存。用户可以在个人页就地改称呼（nickname），改了就优先显示称呼。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const REFRESH_MS = 7 * 86400000;
const text = (v, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function gitUserName() {
  return new Promise(resolve => {
    try {
      execFile('git', ['config', '--global', 'user.name'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (error, stdout) => resolve(error ? '' : text(stdout, 40)));
    } catch { resolve(''); }
  });
}
// Claude Code 登录后把账号资料写在 ~/.claude.json 的 oauthAccount 里，只取显示名。
async function claudeAccountName(home = os.homedir()) {
  try {
    const o = JSON.parse(await fs.promises.readFile(path.join(home, '.claude.json'), 'utf8')).oauthAccount || {};
    return text(o.displayName, 40) || text(o.fullName, 40);
  } catch { return ''; }
}

// 本机能拿到的名字。按顺序问，前一个有就不再问后面的；每个来源单独兜底。
async function localIdentity({ gitName = gitUserName, claudeName = claudeAccountName, osName = () => os.userInfo().username } = {}) {
  const safe = async fn => { try { return text(await fn(), 40); } catch { return ''; } };
  for (const [from, fn] of [['git', gitName], ['claude', claudeName], ['system', osName]]) {
    const name = await safe(fn);
    if (name) return { name, from };
  }
  return { name: '', from: '' };
}

// 缓存 7 天内有效就直接用，不再读本机；force（个人页「重新识别」）或过期时重读。
async function resolveIdentity({ cached, read = () => localIdentity(), now = Date.now(), force = false }) {
  if (cached && cached.name && !force && now - (cached.at || 0) < REFRESH_MS) return { name: cached.name, from: cached.from || '', at: cached.at };
  const local = await read();
  return { name: local.name, from: local.from, at: now };
}

const FROM_TEXT = { git: 'Git 用户名', claude: 'Claude 账号名', system: '系统用户名' };

module.exports = { localIdentity, resolveIdentity, gitUserName, claudeAccountName, FROM_TEXT };
