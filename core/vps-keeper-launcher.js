'use strict';
// Only launch the local keeper. Account URLs never come from a renderer-supplied origin.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ORIGIN } = require('./vps-keeper-client');
const START_SCRIPT = process.env.AI_HUB_KEEPER_START || '';
function accountId(kind, profileId) {
  if (!['claude', 'codex'].includes(kind) || typeof profileId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(profileId)) throw Error('账号标识无效，请刷新账号页');
  return kind + ':' + profileId;
}
function keeperUrl(kind, profileId) { return ORIGIN + '/?account=' + encodeURIComponent(accountId(kind, profileId)); }
function launch(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
function edgePath() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const file = roots.map(root => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(p => fs.existsSync(p));
  if (!file) throw Error('没有找到 Microsoft Edge，请安装后重试');
  return file;
}
function createKeeperLauncher({ keeper, start = async () => {
  if (!fs.existsSync(START_SCRIPT)) throw Error('管家启动文件不存在：' + START_SCRIPT);
  await launch('wscript.exe', [START_SCRIPT]);
}, open = url => launch(edgePath(), ['--app=' + url, '--window-size=1440,900']),
  now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 15000 } = {}) {
  let starting = null;
  async function ensure(onProgress) {
    const deadline = now() + timeoutMs;
    if (await keeper.health(Math.min(1500, timeoutMs))) return;
    onProgress('管家尚未运行，正在后台启动（最多等 15 秒）…');
    await start();
    while (now() < deadline) {
      const remaining = deadline - now();
      if (await keeper.health(Math.min(1000, remaining))) return;
      if (now() < deadline) await sleep(Math.min(500, deadline - now()));
    }
    throw Error('等待管家启动超过 15 秒，健康接口仍未响应；可以重试或使用 Hub 后备入口');
  }
  return {
    async manage({ kind, profileId }, onProgress = () => {}) {
      const url = keeperUrl(kind, profileId);
      if (!keeper) throw Error('此版本未启用 VPS 管家');
      onProgress('正在检查管家是否运行…');
      if (!starting) starting = ensure(onProgress).finally(() => { starting = null; });
      await starting;
      onProgress('管家已就绪，正在打开这个账号的管理页…');
      await open(url);
      return { url, message: '已打开管家，请在那里管理此账号的远程浏览器' };
    },
    async account({ kind, profileId }) {
      const id = accountId(kind, profileId);
      return keeper ? keeper.account(id) : null;
    },
  };
}
module.exports = { createKeeperLauncher, accountId, keeperUrl };
