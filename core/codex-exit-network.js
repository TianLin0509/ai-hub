'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { createDefaultClient } = require('./vps-keeper-client');
const dedicated = p => !!p?.exit && p.exit !== 'shared';

function routeEnvironment(route, exists = fs.existsSync) {
  const n = route?.claudeNetwork;
  if (!route?.hubHost || !route.launcherRoute || !net.isIP(route.ip || '') || n?.expectedIp !== route.ip
      || !/^https:\/\/127\.0\.0\.1:\d{1,5}$/.test(n?.proxy || '')
      || !n?.proxyCaFile || !path.isAbsolute(n.proxyCaFile) || !exists(n.proxyCaFile))
    throw Error('Codex 专属出口配置不完整或 CA 不存在，请在管家检查；未使用共享出口');
  const url = new URL(n.proxy);
  if (!url.port || Number(url.port) > 65535) throw Error('Codex 出口代理端口无效');
  return { HTTPS_PROXY:n.proxy, HTTP_PROXY:n.proxy, ALL_PROXY:n.proxy,
    https_proxy:n.proxy, http_proxy:n.proxy, all_proxy:n.proxy,
    CODEX_CA_CERTIFICATE:n.proxyCaFile, NO_PROXY:'localhost,127.0.0.1', no_proxy:'localhost,127.0.0.1' };
}
async function checkedRoute(profile, { keeper = createDefaultClient(), exists } = {}) {
  if (!dedicated(profile)) return null;
  if (!keeper) throw Error('此版本不支持 Codex 专属出口');
  const data = await keeper.exits();
  const route = data.exits.find(e => e.id === profile.exit);
  const env = routeEnvironment(route, exists);
  const result = await keeper.check(profile.exit);
  if (data.source !== 'api' || result?.source !== 'api' || result.check?.status !== 'ok' || result.check.ip !== route.ip)
    throw Error('Codex 专属出口实时检查失败：' + (result?.check?.reason || '管家离线或出口 IP 不符') + '；未启动');
  return { route, env };
}
function applyEnvironment(env, network) {
  // Remove mixed-case aliases too: an inherited NO_PROXY=* must not bypass the exit.
  for (const key of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy|codex_ca_certificate)$/i.test(key)) delete env[key];
  Object.assign(env, network);
  return env;
}
// SessionManager is synchronous. Keep its contract and check only dedicated accounts
// in a bounded, hidden child; no snapshot/cache can authorize a launch.
function checkedEnvironmentSync(profile, { run = execFileSync, env = process.env } = {}) {
  if (!dedicated(profile)) return null;
  try {
    const output = run(process.execPath, [__filename, '--check', profile.exit], {
      env:{...env,ELECTRON_RUN_AS_NODE:'1'}, windowsHide:true, timeout:10000, encoding:'utf8', maxBuffer:65536 });
    const result = JSON.parse(output);
    if (!result.ok) throw Error(result.error);
    return result.env;
  } catch (error) { throw Error('Codex 专属出口未就绪：' + (error.message || '检查超时') + '；未启动'); }
}
function profileForHome(env, profiles = require('./hub-config').getConfig().codexSubscriptionProfiles || []) {
  if (!env.CODEX_HOME) return null;
  const {expandHomePath}=require('./codex-usage-scope');
  return profiles.find(p => p.home && path.resolve(expandHomePath(p.home)).toLowerCase() === path.resolve(env.CODEX_HOME).toLowerCase());
}
async function applyHomeEnvironment(env, options={}) {
  const p=profileForHome(env,options.profiles);
  if(dedicated(p))applyEnvironment(env,(await checkedRoute(p,options)).env);
  return env;
}
module.exports = { dedicated, routeEnvironment, checkedRoute, applyEnvironment, checkedEnvironmentSync, profileForHome, applyHomeEnvironment };
if (require.main === module && process.argv[2] === '--check') {
  checkedRoute({exit:process.argv[3]}).then(r => process.stdout.write(JSON.stringify({ok:true,env:r.env})),
    e => process.stdout.write(JSON.stringify({ok:false,error:e.message})));
}
