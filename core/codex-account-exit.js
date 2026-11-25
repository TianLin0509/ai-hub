'use strict';

const SHARED = 'shared';
const UNAVAILABLE = '专属出口尚未接通，请检查管家与 VPS 配置';
function validExit(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id); }
async function prepareNewAccount(exit, { keeper, manager } = {}) {
  if (exit == null || exit === '' || exit === SHARED) return {};
  if (!validExit(exit)) throw new Error('出口标识无效');
  const { route } = await require('./codex-exit-network').checkedRoute({exit}, {keeper});
  manager ||= new (require('./vps-login-env').VpsLoginEnv)({ dataDir:require('./data-dir').getHubDataDir(), keeper });
  const created = await manager.create(route.launcherRoute, route.hubHost);
  if (!require('./vps-login-env').ENV_ID.test(created.id || '')) throw Error('远程浏览器标识无效');
  return { exit, loginEnv:created.id };
}

function createCodexExitService({ keeper = require('./vps-keeper-client').createDefaultClient(),
  readProfiles = () => require('./hub-config').getConfig().codexSubscriptionProfiles || [],
  enabled = () => !require('./distribution').community } = {}) {
  async function state() {
    if (!enabled()) return { enabled: false };
    const data = await keeper?.exits().catch(() => null) || { source: 'none', at: null, exits: [] };
    const profiles = readProfiles();
    const routes = data.exits.map(e => ({ id: e.id, name: e.name, ip: e.ip, vps: e.vps, vpsName: e.vpsName,
      shared: e.id === SHARED, fresh: e.fresh, check: e.check,
      codexCount: profiles.filter(p => (p.exit || SHARED) === e.id).length,
      selectable: e.id === SHARED || (data.source === 'api' && !!e.hubHost && !!e.launcherRoute && !!e.claudeNetwork),
      unavailable: e.id === SHARED ? '' : UNAVAILABLE }));
    if (!routes.some(r => r.id === SHARED)) routes.unshift({ id: SHARED, name: '共享出口', shared: true,
      selectable: true, codexCount: profiles.filter(p => !p.exit || p.exit === SHARED).length });
    return { enabled: true, keeper: { source: data.source, at: data.at }, routes,
      dedicatedSupported: true };
  }
  async function check(profileId) {
    if (!enabled()) throw new Error('此版本没有账号出口管家');
    const profile = readProfiles().find(p => p.id === profileId);
    if (!profile) throw new Error('Codex 账号不存在，请刷新账号页');
    const id = profile.exit || SHARED;
    if (!validExit(id)) throw new Error('出口标识无效');
    const result = await keeper?.check(id);
    if (!result?.check) throw new Error('管家不可用，未获得出口检查结果');
    return { exit: id, ...result };
  }
  return { state, check };
}
module.exports = { SHARED, UNAVAILABLE, validExit, prepareNewAccount, createCodexExitService };
