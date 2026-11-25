'use strict';
// 额度「随使用刷新」（2026-11-21）。
// 那些调用不在 Hub 会话里，看板就停在旧读数。这里补三条，全部挂在主进程每 5 秒的扫描上：
//   1. Codex 非当前账号：读它自己 CODEX_HOME/sessions 里最新的会话记录（每次模型回复都带官方 rate_limits），
//      比看板读数新就采用。只读本地文件，不联网。当前账号原本就每 5 秒扫一次。
//      安静 quietMs 后跑一次官方只读 /usage；同一账号两次之间至少隔 minGapMs，失败后退避 failBackoffMs。
//   3. 定时兜底：每 fallbackMs 做一次非强制的全账号读取，覆盖别的电脑、网页端这类本机看不到的用量。
function createUsageActivityRefresh({
  codexScopes = () => [], scanCodex = async () => null, codexReadingAt = () => 0, observeCodex = () => {},
  agyProfiles = () => [], agyActivityAt = () => 0, agyReadingAt = () => 0, refreshAgy = async () => null,
  fallback = async () => {}, now = Date.now,
  codexEveryMs = 15_000, agyEveryMs = 20_000, quietMs = 45_000, minGapMs = 3 * 60_000,
  failBackoffMs = 30 * 60_000, fallbackMs = 30 * 60_000, log = () => {},
} = {}) {
  const codexAt = new Map(), agyTried = new Map(), agyFailedAt = new Map();
  let agyCheckedAt = 0, fallbackAt = now(), codexFlight = null, agyFlight = null, fallbackFlight = null;

  async function codexPass(t) {
    for (const scope of codexScopes()) {
      if (!scope?.scopeKey || t - (codexAt.get(scope.scopeKey) || 0) < codexEveryMs) continue;
      codexAt.set(scope.scopeKey, t);
      let data = null;
      try { data = await scanCodex(scope); } catch (error) { log('codex scan failed: ' + error.message); continue; }
      // 两个窗口可能来自不同会话记录：只要有一个窗口比看板新就采用，逐窗口新旧由 observeCodex 合并时判断。
      const at = Math.max(Number(data?.observedAt) || 0, ...Object.values(data?.windowObservedAt || {}).map(Number).filter(Number.isFinite));
      if (!at || !(data.usage5h || data.usage7d) || at <= (Number(codexReadingAt(scope)) || 0)) continue;
      try { observeCodex(scope, data); } catch (error) { log('codex observe failed: ' + error.message); }
    }
  }

  async function agyPass(t) {
    if (t - agyCheckedAt < agyEveryMs) return;
    agyCheckedAt = t;
    for (const profile of agyProfiles()) {
      const id = profile?.id;
      if (!id) continue;
      const activity = Number(agyActivityAt(profile)) || 0;
      if (!activity || activity <= (Number(agyReadingAt(profile)) || 0)) continue; // 读数比最近一次使用还新
      if (t - activity < quietMs) continue; // 还在用，等它停一会儿再读，读到的才是这轮用完的余量
      if (t - (agyTried.get(id) || 0) < minGapMs) continue;
      if (t - (agyFailedAt.get(id) || 0) < failBackoffMs) continue;
      agyTried.set(id, t);
      try {
        const value = await refreshAgy(profile);
        if (value?.error) agyFailedAt.set(id, t); else agyFailedAt.delete(id);
      } catch (error) { agyFailedAt.set(id, t); log('antigravity refresh failed: ' + error.message); }
    }
  }

  function tick() {
    const t = now();
    if (!codexFlight) codexFlight = codexPass(t).catch(() => {}).finally(() => { codexFlight = null; });
    if (!agyFlight) agyFlight = agyPass(t).catch(() => {}).finally(() => { agyFlight = null; });
    if (!fallbackFlight && t - fallbackAt >= fallbackMs) {
      fallbackAt = t;
      fallbackFlight = Promise.resolve().then(fallback).catch(error => log('fallback refresh failed: ' + (error?.message || error)))
        .finally(() => { fallbackFlight = null; });
    }
    return Promise.all([codexFlight, agyFlight, fallbackFlight]);
  }
  return { tick };
}

// conversations 目录里最新文件的修改时间（毫秒）；/usage 这类只读查询不写这里。
function latestConversationAt(dir, fsImpl = require('fs'), pathImpl = require('path')) {
  let latest = 0;
  try {
    latest = fsImpl.statSync(dir).mtimeMs;
    for (const name of fsImpl.readdirSync(dir)) {
      try { latest = Math.max(latest, fsImpl.statSync(pathImpl.join(dir, name)).mtimeMs); } catch {}
    }
  } catch { return 0; }
  return latest;
}

module.exports = { createUsageActivityRefresh, latestConversationAt };
