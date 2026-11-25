'use strict';
// Hub 把 config.json 缓存在内存里，外部程序直接改文件会被下一次保存覆盖，所以管家只挂出「待导入」，
// 由 Hub 用自己的保存路径（saveAccounts → saveConfig + 清缓存 + 通知界面）写入，再回报管家。
// 只访问本机 127.0.0.1:17950，不跟随跳转；每 15 秒一次，管家没开就安静跳过。
const fs = require('fs');
const path = require('path');
const ORIGIN = 'http://127.0.0.1:17950';

function createKeeperAccountImporter({
  request = globalThis.fetch, homeDir, shownAccounts, saveAccounts, registry, policy, prepareDir = () => {},
  saveMailbox = () => {}, log = () => {}, intervalMs = 15000, timeoutMs = 2500,
} = {}) {
  let timer = null, running = null;
  async function api(endpoint, method = 'GET', body) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(ORIGIN + endpoint, { method, signal: controller.signal, redirect: 'error',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error('keeper ' + response.status);
      return await response.json();
    } finally { clearTimeout(t); }
  }
  function importOne(entry) {
    // 出口配置不完整（证书缺失等）就不收：宁可不导入，也不让账号走错 IP
    if (entry.network) policy({ id: entry.id, network: entry.network });
    let profile;
    try {
      profile = saveAccounts('claude', raw => registry.importAccount(raw, 'claude', entry, { homeDir, normalized: shownAccounts('claude') }));
    } catch (error) {
      if (error.code === 'EXISTS') return { ok: true, profileId: entry.id, already: true };
      throw error;
    }
    fs.mkdirSync(profile.home, { recursive: true });
    try { prepareDir(profile.home); } catch (error) { log('prepare ' + profile.id + ': ' + error.message); }
    if (entry.email) { try { saveMailbox(profile.id, entry.email); } catch (error) { log('mailbox ' + profile.id + ': ' + error.message); } }
    return { ok: true, profileId: profile.id };
  }
  async function runOnce() {
    if (running) return running;
    running = (async () => {
      let data;
      try { data = await api('/v1/hub-sync'); } catch { return []; }   // 管家没开或旧版：安静跳过
      const results = [];
      for (const entry of Array.isArray(data?.pending) ? data.pending : []) {
        if (!entry || typeof entry.id !== 'string') continue;
        let result;
        try { result = importOne(entry); } catch (error) { result = { ok: false, error: error.message }; }
        results.push({ id: entry.id, ...result });
        log('import ' + entry.id + ' ' + (result.ok ? 'ok' : 'failed: ' + result.error));
        try { await api('/v1/hub-sync/' + encodeURIComponent(entry.id) + '/ack', 'POST', { ok: !!result.ok, ...(result.ok ? { profileId: result.profileId } : { error: result.error }) }); }
        catch (error) { log('ack ' + entry.id + ': ' + error.message); }
      }
      return results;
    })();
    try { return await running; } finally { running = null; }
  }
  return {
    runOnce,
    start() { if (!timer) { timer = setInterval(() => { runOnce().catch(() => {}); }, intervalMs); timer.unref?.(); } return this; },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createKeeperAccountImporter, ORIGIN };
