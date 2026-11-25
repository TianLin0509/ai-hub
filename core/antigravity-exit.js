'use strict';
// 三处同一出口 IP（铁律「1 账号 1 环境 1 IP」）。
//
// agy 是 Go 程序：它不认管家私有 CA 的 https 本机代理（2026-11-21 实测 x509 unknown authority，AGY_CA_CERT 也不管用），
// 所以每条可用出口要有一个本机回环的明文 http 代理入口，出口与远程浏览器同一 IP、没有直连兜底。
// 其他专线要接 Antigravity，先给它开同样的明文入口，再加到这张表。
const http = require('http');
// 每条出口一个本机回环明文 http 代理入口：{ <出口 id>: { proxy, expectedIp } }。纯净版不内置任何出口，自建后在这里登记。
const PLAIN = {};
const CACHE_MS = 10 * 60000;
const checks = new Map();

function validExit(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id); }
function plainFor(exit) { return validExit(exit) && Object.hasOwn(PLAIN, exit) ? PLAIN[exit] : null; }

// One plain-http request through the loopback proxy to api.ipify.org (the only health target the
// keeper rules allow). Resolves the exit IP or rejects; never falls back to a direct connection.
function exitIp(proxy, { timeoutMs = 15000, request = http.request } = {}) {
  const u = new URL(proxy);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const req = request({ host: u.hostname, port: Number(u.port), method: 'GET', path: 'http://api.ipify.org/',
      headers: { Host: 'api.ipify.org', 'User-Agent': 'ai-hub-exit-check' }, timeout: timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; if (body.length > 200) req.destroy(new Error('专线返回内容过长')); });
      res.on('error', e => done(reject, new Error('专线连不上：' + (e.message || e.code || '未知原因'))));
      res.on('aborted', () => done(reject, new Error('专线连接意外中断')));
      res.on('close', () => { if (!res.complete) done(reject, new Error('专线连接意外中断')); });
      res.on('end', () => {
        const ip = body.trim();
        if (res.statusCode === 200 && require('net').isIPv4(ip)) done(resolve, ip);
        else done(reject, new Error('专线没有返回出口 IP（HTTP ' + res.statusCode + '）'));
      });
    });
    timer = setTimeout(() => {
      const err = new Error('专线检查超时');
      try { req.destroy(err); } catch {}
      done(reject, err);
    }, timeoutMs);
    timer.unref?.();
    req.on('timeout', () => req.destroy(new Error('专线检查超时')));
    req.on('error', e => done(reject, new Error('专线连不上：' + (e.message || e.code || '未知原因'))));
    req.end();
  });
}

// Before a session or a sign-in leaves through the exit: the IP it reports must be the bound one.
async function checkedNetwork(network, { force = false, ipImpl = exitIp, now = Date.now } = {}) {
  if (!network?.proxy || !network?.expectedIp) throw new Error('这个 Antigravity 账号没有专线配置');
  const key = network.proxy + '|' + network.expectedIp, hit = checks.get(key);
  if (!force && hit && now() - hit.at < CACHE_MS) return { ip: hit.ip, cached: true };
  const ip = await ipImpl(network.proxy);
  if (ip !== network.expectedIp) { checks.delete(key); throw new Error(`专线出口 IP 不符（应为 ${network.expectedIp}，实际 ${ip}），已阻止使用`); }
  checks.set(key, { at: now(), ip });
  return { ip, cached: false };
}

// Session launch is synchronous (_createSession): same check in a hidden child process, as Codex does.
// A pass within the last 10 minutes in this process is reused without spawning anything.
function checkedNetworkSync(network, { run = require('child_process').execFileSync, env = process.env, now = Date.now } = {}) {
  if (!network?.proxy || !network?.expectedIp) return null;
  const key = network.proxy + '|' + network.expectedIp, hit = checks.get(key);
  if (hit && now() - hit.at < CACHE_MS) return hit.ip;
  let result;
  try {
    result = JSON.parse(run(process.execPath, [__filename, '--check', network.proxy, network.expectedIp],
      { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 20000, encoding: 'utf8', maxBuffer: 65536 }));
  } catch (error) { throw new Error('Antigravity 专线未就绪：' + (error.message || '检查超时') + '；未启动'); }
  if (!result.ok) throw new Error('Antigravity 专线未就绪：' + result.error + '；未启动');
  checks.set(key, { at: now(), ip: result.ip });
  return result.ip;
}

function keeperExit(data, exit) {
  const e = (data?.exits || []).find(x => x.id === exit);
  if (!e) throw new Error('管家中找不到这条出口，请刷新账号页');
  if (data.source !== 'api' || !e.hubHost || !e.launcherRoute) throw new Error('管家未在线或出口未接通，未创建远程浏览器');
  return e;
}

// with the profile. Refuses before creating anything if the loopback proxy does not leave from the exit IP.
async function prepareExit(exit, { keeper = require('./vps-keeper-client').createDefaultClient(), manager, ipImpl } = {}) {
  if (require('./distribution').community) throw new Error('此版本没有 VPS 专线');
  const plain = plainFor(exit);
  if (!plain) throw new Error('这条出口还不支持 Antigravity（缺少本机明文代理入口）');
  const e = keeperExit(await keeper.exits(), exit);
  if (e.ip !== plain.expectedIp) throw new Error('管家记录的出口 IP 与 Antigravity 专线不一致，未创建');
  await checkedNetwork({ proxy: plain.proxy, expectedIp: plain.expectedIp }, { force: true, ipImpl });
  manager ||= new (require('./vps-login-env').VpsLoginEnv)({ dataDir: require('./data-dir').getHubDataDir(), keeper });
  const created = await manager.create(e.launcherRoute, e.hubHost);
  if (!require('./vps-login-env').ENV_ID.test(created.id || '')) throw new Error('远程浏览器标识无效');
  return { exit, network: { mode: 'strict', proxy: plain.proxy, expectedIp: plain.expectedIp }, loginEnv: created.id };
}

// Saves an exit binding onto an existing Antigravity row (raw config, pure). Once bound it never changes.
function bindRow(raw, id, born, { normalized = [] } = {}) {
  if (id === 'default') throw new Error('我的账号用系统钥匙串登录，不能绑定专线；请新建一个账号');
  const rows = Array.isArray(raw.providers?.antigravity?.subscription_profiles) ? raw.providers.antigravity.subscription_profiles.filter(r => r && typeof r === 'object') : [];
  const index = rows.findIndex(r => r.id === id), shown = normalized.find(r => r.id === id);
  if (index < 0 && !shown) throw new Error('Antigravity 账号不存在，请刷新账号页');
  const current = index >= 0 ? rows[index] : { id, label: shown.label, home: shown.home || '' };
  if (current.network) throw new Error('这个账号已经绑定专线，出口建好后不再更换');
  const next = rows.slice(), row = { ...current, exit: born.exit, network: { ...born.network }, loginEnv: born.loginEnv, exitBoundAt: new Date().toISOString() };
  if (index < 0) next.push(row); else next[index] = row;
  return { raw: { ...raw, providers: { ...raw.providers, antigravity: { ...raw.providers?.antigravity, subscription_profiles: next } } }, profile: row };
}

function createAntigravityExitService({ keeper = require('./vps-keeper-client').createDefaultClient(),
  readProfiles = () => require('./hub-config').getConfig().antigravitySubscriptionProfiles || [],
  enabled = () => !require('./distribution').community, ipImpl } = {}) {
  async function state() {
    if (!enabled()) return { enabled: false };
    const data = await keeper?.exits().catch(() => null) || { source: 'none', at: null, exits: [] };
    const profiles = readProfiles();
    const routes = data.exits.filter(e => plainFor(e.id)).map(e => ({ id: e.id, name: e.name, ip: e.ip, vps: e.vps, vpsName: e.vpsName,
      check: e.check, agyCount: profiles.filter(p => p.exit === e.id && p.network).length,
      selectable: data.source === 'api' && !!e.hubHost && !!e.launcherRoute && e.ip === plainFor(e.id).expectedIp }));
    const bindings = {};
    for (const p of profiles) if (p.network) {
      const r = routes.find(x => x.id === p.exit);
      bindings[p.id] = { exit: p.exit, name: r?.name || p.exit, vpsName: r?.vpsName || r?.vps || '', ip: p.network.expectedIp, proxy: p.network.proxy, loginEnv: p.loginEnv || '' };
    }
    return { enabled: true, keeper: { source: data.source, at: data.at }, routes, bindings };
  }
  async function check(profileId) {
    if (!enabled()) throw new Error('此版本没有账号出口管家');
    const p = readProfiles().find(x => x.id === profileId);
    if (!p?.network) throw new Error('这个 Antigravity 账号没有绑定专线');
    const r = await checkedNetwork(p.network, { force: true, ipImpl });
    return { exit: p.exit, check: { status: 'ok', ip: r.ip, expectedIp: p.network.expectedIp, at: new Date().toISOString() } };
  }
  return { state, check };
}
module.exports = { PLAIN, validExit, plainFor, exitIp, checkedNetwork, checkedNetworkSync, prepareExit, bindRow, createAntigravityExitService };
if (require.main === module && process.argv[2] === '--check') {
  checkedNetwork({ proxy: process.argv[3], expectedIp: process.argv[4] }, { force: true })
    .then(r => process.stdout.write(JSON.stringify({ ok: true, ip: r.ip })), e => process.stdout.write(JSON.stringify({ ok: false, error: e.message })));
}
