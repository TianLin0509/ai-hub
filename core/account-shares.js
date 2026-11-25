'use strict';
// Hub 只读不写，用来在换号框和右侧额度看板给这些号加一个「已共享」小标注。
// 这里只读设备名、建立时间等元信息，凭据字段一概不碰、不往界面传。
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILES = [
  { name: 'shares.json', key: 'shares' },
  { name: 'pc-devices.json', key: 'devices' },
];

function keeperDir(home = os.homedir()) {
  return process.env.CLAUDE_HUB_KEEPER_DIR || path.join(home, '.vps-keeper');
}

// 管家的账号写法是「claude:acct-xxx」，和风控标记的键一致；没有前缀的按 Claude 算。
function accountKey(account) {
  const text = String(account || '').trim();
  if (!text) return '';
  return text.includes(':') ? text : 'claude:' + text;
}

// 返回 { 'claude:acct-xxx': [{ device, label, since, revokable }] }；文件缺失或损坏时跳过那一份。
function readAccountShares({ dir = keeperDir(), logger = console } = {}) {
  const result = {};
  for (const { name, key } of FILES) {
    let list;
    try { list = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))?.[key]; }
    catch (error) { if (error.code !== 'ENOENT') logger.warn?.('[account-shares] 读取 ' + name + ' 失败：' + error.message); continue; }
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (!row || typeof row !== 'object' || row.status === 'revoked') continue;
      const id = accountKey(row.account);
      if (!id) continue;
      (result[id] ||= []).push({
        device: String(row.device || '其他设备').slice(0, 40),
        label: String(row.label || '').slice(0, 40),
        since: String(row.createdAt || '').slice(0, 25),
      });
    }
  }
  return result;
}

module.exports = { accountKey, keeperDir, readAccountShares };
