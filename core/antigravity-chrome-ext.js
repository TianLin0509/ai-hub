'use strict';
// 改道、分不出资料，而且只覆盖部分谷歌域名（youtube.com、gmail.com、统计广告域名等会漏到别的节点）。
// 所以给这个资料装一个只属于它的小扩展：把整份资料的全部流量固定交给该账号专线的本机入口，关掉 WebRTC 的非代理 UDP。
// Chrome 的代理设置按资料保存，其他资料、其他软件、Clash 都不受影响；入口不通时这个资料直接上不了网，不会改走别处。
const fs = require('fs');
const path = require('path');

function extensionDir(dataDir, exit) { return path.join(dataDir, 'antigravity-chrome-ext', String(exit).replace(/[^\w-]/g, '_')); }
function files({ exit, name, proxy, expectedIp }) {
  const u = new URL(proxy);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port) throw new Error('专线入口地址无效');
  const title = 'AI Hub 专线 · ' + (name || exit) + ' · ' + expectedIp;
  const manifest = {
    manifest_version: 3, name: title.slice(0, 75), version: '1.0.0',
    description: '把这个 Chrome 资料的全部流量固定走 ' + (name || exit) + '（出口 ' + expectedIp + '）。由 AI Hub 生成。',
    permissions: ['proxy', 'privacy'], background: { service_worker: 'background.js' }, action: { default_title: title },
  };
  const background = `'use strict';
// 由 AI Hub 生成：${title}
const RULES = { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port: ${Number(u.port)} }, bypassList: ['127.0.0.1', 'localhost', '[::1]'] } };
function apply() {
  chrome.proxy.settings.set({ value: RULES, scope: 'regular' }, () => {
    chrome.proxy.settings.get({ incognito: false }, d => {
      const ok = d.levelOfControl === 'controlled_by_this_extension';
      chrome.action.setBadgeText({ text: ok ? '专线' : '失效' });
      chrome.action.setBadgeBackgroundColor({ color: ok ? '#3478f6' : '#d93025' });
      chrome.action.setTitle({ title: ok ? ${JSON.stringify(title)} : '专线未生效：另一个扩展在控制代理，请停用它' });
    });
  });
  chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: 'disable_non_proxied_udp' });
}
chrome.runtime.onInstalled.addListener(apply);
chrome.runtime.onStartup.addListener(apply);
chrome.proxy.onProxyError.addListener(() => { chrome.action.setBadgeText({ text: '断开' }); chrome.action.setBadgeBackgroundColor({ color: '#d93025' }); });
apply();
`;
  return { 'manifest.json': JSON.stringify(manifest, null, 2), 'background.js': background };
}
function writeExtension(dataDir, binding) {
  const dir = extensionDir(dataDir, binding.exit);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files(binding))) fs.writeFileSync(path.join(dir, name), text, 'utf8');
  return dir;
}
module.exports = { extensionDir, files, writeExtension };
