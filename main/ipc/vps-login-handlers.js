'use strict';
// 账号页 · Claude 登录环境（2026-10-28，桌面「Claude 启动台」并入 Hub）。
const fs = require('fs');
const path = require('path');
const { getConfig, saveConfig, readConfigJsonForUpdate } = require('../../core/hub-config.js');
const { getHubDataDir } = require('../../core/data-dir');
const vps = require('../../core/vps-login-env');
const profilesTool = require('../../core/claude-subscription-profiles');
const registry = require('../../core/subscription-account-registry');
const { isMailUrl } = require('../../core/claude-mailbox-vault');
const exitCheck = require('../../core/claude-exit-check');
const network = require('../../core/claude-account-network');
const routeLatency = require('../../core/route-latency');
const { createDefaultClient } = require('../../core/vps-keeper-client');
const { createKeeperLauncher } = require('../../core/vps-keeper-launcher');

function keeperRoutes(data) {
  return data.exits.map(({ claudeNetwork, users, ...e }) => ({ ...e,
    runnable: !!e.hubHost && !!e.launcherRoute && !!e.ip && (e.shared || !!claudeNetwork)
      && !e.full && (data.source !== 'snapshot' || e.check?.status === 'ok'),
  }));
}
function keeperCheckRow(e, result, list, ip) {
  const check = result.check;
  return { key: e.id, expected: e.ip, ip: check.ip || '', shared: e.shared,
    state: check.status === 'ok' ? 'ok' : (check.status === 'mismatch' || check.status === 'ip-mismatch') ? 'mismatch' : 'unreachable',
    source: 'keeper', reason: check.reason || '', checkedAt: check.at || result.at,
    median: Number.isFinite(check.seconds) ? check.seconds * 1000 : null,
    accounts: list.filter(p => vps.runIpFor(p, ip) === e.ip).map(p => p.label || p.id) };
}

const ENV_PAGES = new Set(['https://claude.ai/', 'https://api.ipify.org/']);
function sharedIp(dataDir = getHubDataDir()) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-egress-baseline.json'), 'utf8')).shared || ''; } catch { return ''; }
}
function profiles() { return profilesTool.normalizeProfiles(getConfig().claudeSubscriptionProfiles); }

function createVpsLoginService({ dataDir = getHubDataDir(), env = process.env, remote, manager,
  keeper = remote || manager ? null : createDefaultClient(), readProfiles = profiles, ensureBrowser = vps.ensureLoginBrowser,
  readCodexProfiles = () => getConfig().codexSubscriptionProfiles || [],
  sendToRenderer = () => {}, clearSessionManagerConfigCache = () => {}, exitRequest = null } = {}) {
  const service = manager || new vps.VpsLoginEnv({ dataDir, remote, keeper, settings: vps.settings(env) });
  const enabled = () => !!remote || !!manager || service.available();
  const readAgyProfiles = () => getConfig().antigravitySubscriptionProfiles || [];
  const occupied = id => readProfiles().some(p => vps.bindingFor(p) === id) || readCodexProfiles().some(p => p.loginEnv === id)
    || readAgyProfiles().some(p => p.loginEnv === id);
  const readExits = async () => await keeper?.exits().catch(() => null) || { source: 'none', exits: [], at: null };
  let flight = null;
  async function snapshot() {
    const [status, keeperData] = await Promise.all([service.status(), readExits()]);
    const list = readProfiles(), names = service.launcherNames(), ip = sharedIp(dataDir);
    const view = vps.describe({ profiles: list, status, sharedIp: ip, names });
    for (const p of readCodexProfiles()) {
      const e = view.envs.find(e => e.id === p.loginEnv);
      if (e && !e.boundTo) { e.boundTo = 'codex:' + p.id; e.name = 'Codex · ' + (p.label || p.id); }
    }
    for (const p of readAgyProfiles()) {
      const e = view.envs.find(e => e.id === p.loginEnv);
      if (e && !e.boundTo) { e.boundTo = 'antigravity:' + p.id; e.name = 'Antigravity · ' + (p.label || p.id); }
    }
    const labels = {};
    for (const e of view.envs) labels[e.id] = e.boundTo ? (list.find(p => p.id === e.boundTo)?.label || e.name) : e.name;
    service.writeNames(labels);
    // The account page needs the exits a new account may use (with 是否接通本机), not describe()'s plain list.
    return { ...view, enabled: true, sharedIp: ip, keeper: { source: keeperData.source, at: keeperData.at },
      routes: keeperData.source !== 'none' ? keeperRoutes(keeperData)
        : vps.routeTemplates(list, status, ip, vps.wiredRoutes(dataDir)).map(({ network, ...r }) => r) };
  }
  function profileOf(id) {
    const p = readProfiles().find(x => x.id === id);
    if (!p) throw new Error('Claude 账号不存在，请刷新账号页');
    return p;
  }
  // A new environment or a free existing one, on the route whose IP equals this account's exit.
  async function resolveEnvironment({ runIp, loginEnv, status, onProgress = () => {} }) {
    const route = Object.values(status.routes || {}).find(r => r.ip === runIp);
    if (!route) throw new Error(`VPS 上没有出口 IP 为 ${runIp} 的线路，无法建立一致的登录环境`);
    if (loginEnv === 'new') {
      onProgress('正在 VPS 上新建登录环境、核对出口并预热浏览器（约 1–2 分钟）');
      return (await service.create(route.id)).id;
    }
    const env = status.accounts?.[loginEnv];
    if (!env) throw new Error('所选登录环境已不存在，请刷新');
    if (env.route !== route.id) throw new Error('所选登录环境的出口与账号出口不一致，不能绑定');
    if (env.managed && !env.provisioned) throw new Error('所选登录环境尚未创建完成');
    if (occupied(loginEnv)) throw new Error('这个登录环境已被其他账号使用');
    return loginEnv;
  }
  return {
    enabled,
    service,
    async state() {
      if (!enabled()) return { enabled: false };
      if (!flight) flight = snapshot().finally(() => { flight = null; });
      return flight;
    },
    // url: the account's own webmail (claude-mailbox-vault), claude.ai or the exit-IP page, so everything opened there stays on this exit.
    async open({ profileId, confirmed = false, url = '' }) {
      const p = profileOf(profileId), id = vps.bindingFor(p);
      if (!id) throw new Error('这个账号还没有登录环境，请先绑定');
      if (url && !isMailUrl(url) && !ENV_PAGES.has(url)) throw new Error('只能在登录环境里打开账号邮箱、Claude 官网或出口检测页');
      const view = await snapshot();
      const row = view.accounts.find(a => a.profileId === profileId);
      if (!row.consistent) throw new Error(row.problem + '；为保证同一 IP，未打开');
      let result;
      try { result = await service.open(id, { confirmed, url, onProgress: message => sendToRenderer('vps-login-progress', { profileId, message }) }); }
      catch (error) {
        if (url && /仅支持打开 Claude 官方页面或出口检测页面/.test(error.message)) throw new Error('登录窗口已打开，但 VPS 端还是旧版，不允许直接打开邮箱：请在登录窗口地址栏输入邮箱网址，或先把 VPS 端更新到 1.1.2');
        throw error;
      }
      if (result.needsConfirmation) {
        const names = view.envs.reduce((m, e) => ({ ...m, [e.id]: e.boundTo ? (readProfiles().find(x => x.id === e.boundTo)?.label || e.name) : e.name }), {});
        return { needsConfirmation: true, others: result.others.map(o => names[o] || o) };
      }
      const what = url === 'https://claude.ai/' ? 'Claude 官网' : url === 'https://api.ipify.org/' ? '出口检测页（页面上显示的就是远程浏览器的出口 IP）' : '邮箱';
      return { ...result, message: url ? `已在「${p.label}」的登录窗口打开${what}，出口 ${result.ip}` : `已打开「${p.label}」的登录窗口，出口 ${result.ip}` };
    },
    async stop({ profileId }) {
      const id = vps.bindingFor(profileOf(profileId));
      if (!id) throw new Error('这个账号还没有登录环境');
      await service.stop(id);
      return { message: '已关闭登录窗口，登录资料保留在 VPS' };
    },
    async bind({ profileId, loginEnv }) {
      const p = profileOf(profileId);
      if (vps.bindingFor(p)) throw new Error('这个账号已经有登录环境；为保持同一 IP，不在这里更换');
      const status = await service.status();
      const runIp = vps.runIpFor(p, sharedIp(dataDir));
      if (!runIp) throw new Error('还没有记录这个账号的运行出口 IP，请稍后再试');
      const id = await resolveEnvironment({ runIp, loginEnv, status, onProgress: message => sendToRenderer('vps-login-progress', { profileId, message }) });
      const raw = readConfigJsonForUpdate();
      saveConfig(registry.bindLoginEnv(raw, profileId, id, { normalized: readProfiles() }).raw);
      clearSessionManagerConfigCache();
      sendToRenderer('subscription-accounts-changed', { kind: 'claude', profileId });
      return { loginEnv: id, message: `已绑定登录环境，出口 ${runIp}` };
    },
    // 「检查出口」优先由管家执行，无法取得实时结果时沿用本机检查。
    async checkExits({ profileId } = {}) {
      const data = await readExits(), list = readProfiles(), ip = sharedIp(dataDir);
      const targetIp = profileId ? vps.runIpFor(profileOf(profileId), ip) : '';
      const choices = data.source !== 'none' ? data.exits.filter(e => !profileId || e.ip === targetIp) : [];
      let sharedProxy = null;
      try { sharedProxy = network.sharedRouteProxy(profilesTool.sharedNetworkEnv(getConfig()).HTTPS_PROXY); } catch {}
      const legacy = exitCheck.exitList({ profiles: list, sharedProxy, sharedIp: ip, wired: vps.wiredRoutes(dataDir) });
      const probe = e => exitCheck.probeExit(e, exitRequest ? { request: exitRequest } : {});
      const checked = await Promise.all(choices.map(async e => {
        const result = await keeper.check(e.id).catch(() => null);
        if (result?.source === 'api') return keeperCheckRow(e, result, list, ip);
        const old = legacy.find(r => r.expected === e.ip);
        // Fresh keeper exits need not exist in wired-routes.json yet.
        const fallback = old || { key: e.id, expected: e.ip, shared: e.shared, accounts: [],
          proxy: e.claudeNetwork?.proxy, proxyCaFile: e.claudeNetwork?.proxyCaFile };
        return probe(fallback);
      }));
      const rest = legacy.filter(e => (!profileId || e.expected === targetIp) && !choices.some(c => c.ip === e.expected));
      return [...checked, ...await Promise.all(rest.map(probe))];
    },
    // For accounts:add-subscription: the exit and login environment a new Claude account is born with.
    async prepareNew({ route, loginEnv }) {
      const data = await readExits();
      if (data.source !== 'none') {
        const choice = data.exits.find(e => e.id === route);
        if (!choice) throw new Error('所选出口已不在管家列表，请刷新后重新选择');
        if (choice.full) throw new Error('这个出口的 Claude 账号名额已满，请选择其他出口');
        if (!keeperRoutes(data).find(e => e.id === route)?.runnable) throw new Error('这个出口暂不可用；离线时只能选择快照中正常的出口');
        if (!choice.shared && choice.claudeNetwork.expectedIp !== choice.ip) throw new Error('管家线路配置与出口 IP 不一致，请先在管家检查');
        const network = choice.shared ? undefined : { ...choice.claudeNetwork, browserCommand: ensureBrowser(dataDir) };
        let id;
        if (!loginEnv || loginEnv === 'new') {
          sendToRenderer('vps-login-progress', { profileId: '', message: '正在所选出口的 VPS 上新建远程浏览器（约 1–2 分钟）' });
          id = (await service.create(choice.launcherRoute, choice.hubHost)).id;
        } else {
          const status = await service.status(), existing = status.accounts?.[loginEnv];
          if (!existing || (existing.host || 'main') !== choice.hubHost || existing.route !== choice.launcherRoute
            || (existing.managed && !existing.provisioned) || occupied(loginEnv))
            throw new Error('所选远程浏览器的主机、出口或占用状态已变化，请刷新');
          id = loginEnv;
        }
        return { network, loginEnv: id };
      }
      const status = await service.status(), list = readProfiles(), ip = sharedIp(dataDir);
      const choice = vps.routeTemplates(list, status, ip, vps.wiredRoutes(dataDir)).find(r => r.id === route);
      if (!choice) throw new Error('请选择出口');
      if (!choice.runnable) throw new Error('这个出口还没有接到本机，Claude 无法使用它');
      let network;
      if (!choice.shared) {
        network = { ...choice.network, browserCommand: ensureBrowser(dataDir) };
      }
      const id = await resolveEnvironment({ runIp: choice.ip, loginEnv: loginEnv || 'new', status, onProgress: message => sendToRenderer('vps-login-progress', { profileId: '', message }) });
      return { network, loginEnv: id };
    },
  };
}

function registerVpsLoginIpc(ipcMain, deps = {}) {
  const service = createVpsLoginService(deps);
  // Built once, after startup has settled (the first compile takes 1–3 s on the main thread), so a
  if (service.enabled()) setTimeout(() => { try { vps.ensureLoginBrowser(deps.dataDir || getHubDataDir()); } catch (error) { console.warn('[vps-login] 登录转发程序未生成：' + error.message); } }, 20000).unref?.();
  const wrap = fn => async (_e, payload = {}) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (error) { return { ok: false, error: error.message }; }
  };
  ipcMain.handle('vps-login:state', wrap(() => service.state()));
  ipcMain.handle('vps-login:open', wrap(p => service.open(p)));
  ipcMain.handle('vps-login:stop', wrap(p => service.stop(p)));
  ipcMain.handle('vps-login:bind', wrap(p => service.bind(p)));
  ipcMain.handle('vps-login:check-exits', wrap(p => service.checkExits(p)));
  const keeperManager = deps.keeperLauncher || createKeeperLauncher({ keeper: deps.keeper === undefined ? createDefaultClient() : deps.keeper });
  ipcMain.handle('vps-keeper:account', wrap(p => keeperManager.account(p)));
  ipcMain.handle('vps-keeper:manage', wrap(p => keeperManager.manage(p,
    message => deps.sendToRenderer?.('vps-keeper-progress', { ...p, message }))));
  const latency = routeLatency.createRouteLatency({ routes: () => {
    let sharedProxy = null;
    try { sharedProxy = network.sharedRouteProxy(profilesTool.sharedNetworkEnv(getConfig()).HTTPS_PROXY); } catch {}
    return routeLatency.routesFrom({ profiles: profiles(), sharedProxy, sharedIp: sharedIp(deps.dataDir || getHubDataDir()) });
  } });
  ipcMain.handle('route-latency:get', wrap(() => latency.get()));
  ipcMain.handle('route-latency:probe-claude', wrap(p => latency.probeClaude(String(p?.ip || ''))));
  return service;
}

module.exports = { createVpsLoginService, registerVpsLoginIpc, sharedIp };
