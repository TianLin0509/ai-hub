'use strict';
// 账号页 · 风控标记（2026-10-31）：改动后广播给所有界面，账号标签和启动中心即时更新。
// 2026-11-24 账号状态：account-risk:flag / clear 也收 items 批量；另一个 Hub 实例改了同一份记录时，
// 每 5 秒看一次文件修改时间，变了就把最新记录广播给本实例界面（右侧栏随之隐藏或恢复）。
const fs = require('fs');

function registerAccountRiskIpc(ipcMain, { store, sendToRenderer, readShares = () => require('../../core/account-shares').readAccountShares(), watchIntervalMs = 5000 }) {
  const wrap = fn => async (_event, payload = {}) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (error) { return { ok: false, error: error.message }; }
  };
  const changed = snapshot => { sendToRenderer('account-risk:changed', snapshot); return snapshot; };
  ipcMain.handle('account-risk:list', wrap(() => store.snapshot()));
  ipcMain.handle('account-risk:flag', wrap(payload => changed(store.flag(payload))));
  ipcMain.handle('account-risk:clear', wrap(payload => changed(store.clear(payload))));
  // 发行版关掉账号基础设施时没有管家，不去读它的目录。
  ipcMain.handle('account-shares:list', wrap(() => require('../../core/distribution').featureEnabled('accountInfra') ? readShares() : {}));
  if (!watchIntervalMs || !store.file) return null;
  const onChange = (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs) return;
    try { changed(store.snapshot()); } catch (error) { console.warn('[account-risk] 账号状态记录读取失败：' + error.message); }
  };
  try { fs.watchFile(store.file, { interval: watchIntervalMs, persistent: false }, onChange); }
  catch (error) { console.warn('[account-risk] 无法监视账号状态记录：' + error.message); return null; }
  return { stop: () => fs.unwatchFile(store.file, onChange) };
}

module.exports = { registerAccountRiskIpc };
