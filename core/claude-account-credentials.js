'use strict';

// Reference: realiti4/claude-swap (MIT), reviewed at 042a36b. Each original
// account directory remains the canonical refresh-token owner. Running Hub
// sessions receive access-only projections, never a second refresh owner.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_LEAD_MS = 120_000;
const MAX_BACKOFF_MS = 30 * 60_000;

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function readJson(file, optional = false) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw fail('CLAUDE_AUTH_READ', 'Claude 登录或配置文件无法读取'); }
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const previous = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    // Claude invalidates its token cache by mtime, including fast back-to-back swaps.
    if (fs.statSync(file).mtimeMs <= previous) {
      const next = new Date(previous + 1); fs.utimesSync(file, next, next);
    }
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function fingerprint(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function accessOnly(credentials) {
  const oauth = credentials?.claudeAiOauth;
  if (!oauth?.accessToken || oauth.refreshToken === '') throw fail('CLAUDE_RELOGIN_REQUIRED', '此 Claude 账号需要重新登录');
  const { refreshToken, ...access } = oauth;
  return { ...credentials, claudeAiOauth: access };
}
function globalConfigPath(home) {
  const legacy = path.join(home, '.config.json');
  if (fs.existsSync(legacy) && fs.statSync(legacy).size > 0) return legacy;
  return path.basename(home).toLowerCase() === '.claude'
    ? path.join(path.dirname(home), '.claude.json') : path.join(home, '.claude.json');
}

// Claude 2.1.310's two proper-lockfile directory names. Never steal a lock;
// timeout is recoverable and cannot revoke the other process's credential.
async function withDirectoryLocks(names, work, { timeoutMs = 9000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (true) {
    const acquired = [];
    let heartbeat;
    let compromised = false;
    try {
      for (const name of names) { fs.mkdirSync(name); acquired.push({ name, ino: fs.statSync(name).ino }); }
      heartbeat = setInterval(() => {
        for (const lock of acquired) {
          try {
            if (fs.statSync(lock.name).ino !== lock.ino) { compromised = true; continue; }
            const time = new Date(); fs.utimesSync(lock.name, time, time);
          } catch { compromised = true; }
        }
      }, 3000);
      heartbeat.unref?.();
      return await work(() => {
        if (compromised || acquired.some(lock => !fs.existsSync(lock.name) || fs.statSync(lock.name).ino !== lock.ino)) {
          throw fail('CLAUDE_AUTH_LOCK_LOST', 'Claude 登录刷新锁已变化，未覆盖凭据');
        }
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= until) throw fail('CLAUDE_AUTH_BUSY', 'Claude 正在刷新登录，稍后再试');
    } finally {
      clearInterval(heartbeat);
      for (const lock of acquired.reverse()) {
        try { if (fs.statSync(lock.name).ino === lock.ino) fs.rmdirSync(lock.name); }
        catch (error) { if (error.code !== 'ENOENT') throw fail('CLAUDE_AUTH_UNLOCK', 'Claude 登录锁释放失败'); }
      }
    }
    await delay(100);
  }
}

function withCredentialLocks(home, work, options) {
  return withDirectoryLocks([path.join(home, '.oauth_refresh.lock'), fs.realpathSync(home) + '.lock'], work, options);
}

// Hub cache rows are { usage5h: { pct, resetsAt(ms) }, usage7d, ts }; the
// switch policy reads the API shape { five_hour: { utilization, resets_at } }.
function apiWindow(row) {
  return row && typeof row.pct === 'number' && Number.isFinite(row.pct)
    ? { utilization: row.pct, resets_at: Number(row.resetsAt) > 0 ? new Date(Number(row.resetsAt)).toISOString() : null } : null;
}
// account changes only when a window reaches its reset time.
function afterResets(usage, at) {
  const out = {};
  for (const [key, value] of Object.entries(usage || {})) {
    const reset = Date.parse(value?.resets_at || '');
    out[key] = value && typeof value === 'object' && Number.isFinite(reset) && reset <= at ? { ...value, utilization: 0, resets_at: null } : value;
  }
  return out;
}

// onRefreshed(profile, credentials) runs after a token request rotated the
// account's login. Anthropic revokes the previous access token at that moment,
// so every session of the account needs the new one right away (2026-11-07:
// a sibling mid-turn used the old token 12 s later and got "token revoked").
function createClaudeCredentialBroker({ request, stateDir, now = Date.now, onUsage = () => {}, cachedUsage = () => null, onRefreshed = () => {}, paused = () => false }) {
  const pending = new Map();
  const usageBlockedUntil = new Map();
  const usageStrikes = new Map();
  const usageFlights = new Map();
  // Last full API answer per account: it alone carries per-model weekly windows.
  const lastApi = new Map();
  async function call(profile, url, options) {
    if (typeof request !== 'function') throw fail('CLAUDE_AUTH_OFFLINE', 'Claude 账号服务尚未就绪');
    try { return await request(url, options, profile); }
    catch (error) { throw Object.assign(fail('CLAUDE_AUTH_NETWORK', 'Claude 账号服务连接失败，本次未换号'), { notSent: error?.notSent === true }); }
  }
  const markerFor = profile => path.join(stateDir, fingerprint(profile.home) + '.refresh.json');
  // One line per token request, so a future 429 can be explained by counting
  // what Hub actually sent instead of guessing.
  function logRefresh(profile, reason, outcome) {
    try {
      const file = stateDir + '-log.jsonl'; // sibling: the state dir holds only per-account markers
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.1');
      fs.appendFileSync(file, JSON.stringify({ at: new Date(now()).toISOString(), profile: profile.id, reason, ...outcome }) + '\n');
    } catch {}
  }
  async function fresh(profile, leadMs = REFRESH_LEAD_MS, reason = 'on-demand') {
    const file = path.join(profile.home, '.credentials.json');
    let credentials = readJson(file);
    accessOnly(credentials);
    if (Number(credentials.claudeAiOauth.expiresAt) > now() + leadMs) return credentials;
    let renewed = false;
    const result = await withCredentialLocks(profile.home, async assertLock => {
      credentials = readJson(file); // Another Claude may have refreshed while we waited.
      const oauth = credentials.claudeAiOauth;
      accessOnly(credentials);
      if (Number(oauth.expiresAt) > now() + leadMs) return credentials;
      if (!oauth.refreshToken) throw fail('CLAUDE_RELOGIN_REQUIRED', 'Claude 登录已过期，请重新登录该账号');
      const marker = markerFor(profile);
      const previous = readJson(marker, true);
      const tokenHash = fingerprint(oauth.refreshToken);
      if (Number(previous?.retryAfterAt) > now()) {
        // Backing off must not block work while the current access token still works.
        if (Number(oauth.expiresAt) > now()) return credentials;
        throw fail('CLAUDE_AUTH_RATE_LIMIT', 'Claude 登录刷新正在退避，稍后再试');
      }
      // 平台已明确拒绝过这张刷新凭据：不再重发，直接说登录过期（2026-11-24：账号3 被拒后一直报「结果未确认」）。
      if (previous?.rejectedHash === tokenHash) throw fail('CLAUDE_RELOGIN_REQUIRED', `Claude 登录已过期（${new Date(previous.rejectedAt).toLocaleDateString('zh-CN')} 刷新被平台拒绝），请到账号页点「授权」重新登录该账号`);
      if (previous?.tokenHash === tokenHash) throw fail('CLAUDE_REFRESH_UNCONFIRMED', '上次登录刷新结果未确认，请先重新登录该账号');
      const failures = Number(previous?.failures) || 0;
      // Persist uncertainty BEFORE issuing a rotating grant. A timeout/crash
      // must not repeatedly consume the same possibly superseded grant.
      atomicJson(marker, { tokenHash, startedAt: now(), failures });
      let response;
      try {
        response = await call(profile, 'https://platform.claude.com/v1/oauth/token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: OAUTH_CLIENT_ID }),
        });
      } catch (error) {
        logRefresh(profile, reason, { status: error.notSent ? 'not-sent' : 'network' });
        // The grant provably never left this machine (proxy/DNS/offline), so it
        // is still unused: wait a fixed minute instead of demanding a fresh login.
        // Not exponential, so a recovered network is usable again right away.
        if (error.notSent) atomicJson(marker, { retryAfterAt: now() + 60_000, failures });
        throw error;
      }
      logRefresh(profile, reason, { status: response.status, ...(response.retryAfterMs ? { retryAfterMs: response.retryAfterMs } : {}) });
      if (response.status !== 200) {
        if (response.status === 429) {
          // Exponential: a fixed 60 s retry keeps knocking during a long limit window.
          const wait = Math.max(Math.min(60_000 * 2 ** failures, MAX_BACKOFF_MS), Number(response.retryAfterMs) || 0);
          atomicJson(marker, { retryAfterAt: now() + wait, failures: failures + 1 });
          throw fail('CLAUDE_AUTH_RATE_LIMIT', 'Claude 登录刷新暂时限流，稍后再试');
        }
        // 400/401 等：凭据作废。记下被拒，以后不再拿它去请求，也不再报成「结果未确认」。
        atomicJson(marker, { rejectedHash: tokenHash, rejectedAt: now(), status: response.status, failures });
        throw fail('CLAUDE_RELOGIN_REQUIRED', 'Claude 登录刷新被平台拒绝，请到账号页点「授权」重新登录该账号');
      }
      const data = response.data;
      if (!data?.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
        throw fail('CLAUDE_REFRESH_UNCONFIRMED', 'Claude 登录刷新返回不完整，未继续切换');
      }
      assertLock();
      const current = readJson(file);
      if (current.claudeAiOauth?.refreshToken !== oauth.refreshToken) {
        throw fail('CLAUDE_AUTH_CHANGED', '账号登录已在其他位置改变，未覆盖');
      }
      const next = { ...current, claudeAiOauth: { ...oauth, accessToken: data.access_token,
        refreshToken: data.refresh_token || oauth.refreshToken, expiresAt: now() + data.expires_in * 1000,
        ...(typeof data.scope === 'string' ? { scopes: data.scope.split(' ') } : {}) } };
      atomicJson(file, next);
      fs.unlinkSync(marker);
      renewed = true;
      return next;
    });
    // Outside the account lock: the fan-out takes each runtime's own lock.
    if (renewed) {
      try { await onRefreshed(profile, result); }
      catch (error) { console.warn('[claude-auth] 新登录未能同步到全部会话:', error?.message || error); }
    }
    return result;
  }
  function getCredentials(profile, leadMs, reason) {
    const key = path.resolve(profile.home).toLowerCase();
    if (!pending.has(key)) {
      const task = fresh(profile, leadMs, reason).finally(() => { if (pending.get(key) === task) pending.delete(key); });
      pending.set(key, task);
    }
    return pending.get(key);
  }
  // Compatibility entry: background renewal is retired, even for old callers.
  async function prefresh() { return null; }
  async function fetchUsage(profile, why) {
    if ((usageBlockedUntil.get(profile.id) || 0) > now()) throw fail('CLAUDE_USAGE_RATE_LIMIT', 'Claude 额度查询正在退避，稍后再试');
    const credentials = await getCredentials(profile);
    const response = await call(profile, 'https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${credentials.claudeAiOauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    logRefresh(profile, 'usage', { status: response.status, ...(why ? { why } : {}) });
    if (response.status !== 200 || !response.data || typeof response.data !== 'object') {
      // Repeated 429s double the pause (2, 4, 8 … up to 30 minutes); one success resets it.
      if (response.status === 429) {
        const strikes = (usageStrikes.get(profile.id) || 0) + 1;
        usageStrikes.set(profile.id, strikes);
        usageBlockedUntil.set(profile.id, now() + Math.max(Number(response.retryAfterMs) || 0, Math.min(30 * 60_000, 120_000 * 2 ** (strikes - 1))));
      }
      throw fail(response.status === 429 ? 'CLAUDE_USAGE_RATE_LIMIT' : 'CLAUDE_USAGE_UNAVAILABLE', '暂时无法确认 Claude 账号额度，本次未换号');
    }
    usageStrikes.delete(profile.id);
    const snapshot = { id: profile.id, ready: true, usage: response.data, observedAt: now() };
    lastApi.set(profile.id, { usage: response.data, observedAt: snapshot.observedAt });
    onUsage(profile, snapshot);
    return snapshot;
  }
  function cachedSnapshot(profile) {
    const row = cachedUsage(profile) || null;
    const api = lastApi.get(profile.id) || null;
    const rowAt = Number(row?.observedAt || row?.ts) || 0;
    const five = apiWindow(row?.usage5h), seven = apiWindow(row?.usage7d);
    if (!api && !five && !seven) return null;
    const useRow = rowAt >= (api?.observedAt || 0);
    const usage = { ...(api?.usage || {}),
      ...(useRow && five ? { five_hour: five } : {}), ...(useRow && seven ? { seven_day: seven } : {}) };
    return { id: profile.id, ready: true, usage: afterResets(usage, now()), observedAt: Math.max(rowAt, api?.observedAt || 0) };
  }
  return {
    getCredentials,
    prefresh,
    // Best known reading without a request: the Hub cache (fed for free by every
    // reply's status line, and by earlier requests) plus model windows from the
    // last API answer, with windows past their reset time counted as reset.
    cached: cachedSnapshot,
    // maxAgeMs > 0 accepts a cached reading at most that old (Infinity: any).
    // A reused reading is reported as of now, so freshness checks downstream
    // apply to the request-free source too; cachedAt keeps the real time.
    async usage(profile, { maxAgeMs = 0, cacheOnly = false, why = '' } = {}) {
      if (cacheOnly || /^(after-turn|wall-|precompact-)/.test(why) || paused(profile.id)) {
        const hit = cachedSnapshot(profile);
        return hit ? { ...hit, cachedAt: hit.observedAt, observedAt: now() } : null;
      }
      if (maxAgeMs > 0) {
        const hit = cachedSnapshot(profile);
        if (hit?.usage.five_hour && hit.usage.seven_day && now() - hit.observedAt <= maxAgeMs) return { ...hit, observedAt: now(), cachedAt: hit.observedAt };
      }
      // Callers asking at the same moment share one request.
      if (usageFlights.has(profile.id)) return usageFlights.get(profile.id);
      const flight = fetchUsage(profile, why).finally(() => { if (usageFlights.get(profile.id) === flight) usageFlights.delete(profile.id); });
      usageFlights.set(profile.id, flight);
      return flight;
    },
  };
}

module.exports = { accessOnly, atomicJson, readJson, globalConfigPath, withDirectoryLocks, withCredentialLocks, createClaudeCredentialBroker, fail };
