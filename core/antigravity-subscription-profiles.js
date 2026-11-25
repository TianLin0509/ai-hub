'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const PROFILE_ID = /^[\w-]{1,64}$/;
const SSH_FILE_MARKER = 'hub-antigravity-account';
const FOREIGN_AUTH_ENV = /^(?:AGY_.*AUTH.*|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GEMINI_BASE_URL|ANTIGRAVITY_(?:LS_ADDRESS|CSRF_TOKEN|CREDENTIAL_SCOPE|SIDECAR_UI_TOKEN))$/i;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const defaultHome = env => env.CLAUDE_HUB_HOME_DIR || env.USERPROFILE || env.HOME || os.homedir();
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function expanded(value, home) {
  const text = String(value || '');
  return path.resolve(/^~(?:[\\/]|$)/.test(text) ? path.join(home, text.slice(1)) : text);
}
// Resolve existing ancestors too: a not-yet-created profile can sit below a junction.
function physical(value) {
  const target = path.resolve(value);
  try { return fs.realpathSync.native(target); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(physical(parent), path.basename(target));
  }
}
// exit = 管家出口标识；network.proxy 只收本机回环的明文 http 代理（agy 是 Go 程序，不认管家私有 CA 的 https 代理）；
const LOOPBACK_PROXY = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;
function exitFields(row) {
  if (row.id === 'default' || row.network == null) return {};
  // A binding that is present but malformed must stop the account, never fall back to the Hub-wide proxy.
  const bad = {exit:String(row.exit || ''), networkInvalid:true};
  if (typeof row.network !== 'object') return bad;
  const proxy = String(row.network.proxy || ''), ip = String(row.network.expectedIp || '');
  if (!LOOPBACK_PROXY.test(proxy) || !require('net').isIPv4(ip)) return bad;
  return {exit:String(row.exit || ''), network:{mode:'strict', proxy, expectedIp:ip},
    ...(/^(?:[abcd]|u[0-9a-f]{8})$/.test(row.loginEnv || '') ? {loginEnv:row.loginEnv} : {})};
}
function allProfiles(profiles, homeDir = defaultHome(process.env)) {
  const rows = new Map([
    ['default', {id:'default', label:'我的账号', home:''}],
    ['second', {id:'second', label:'账号 2', home:path.join(homeDir, '.antigravity-profiles', 'second')}],
  ]);
  for (const row of Array.isArray(profiles) ? profiles : []) {
    if (!row || !PROFILE_ID.test(row.id || '')) continue;
    rows.set(row.id, {id:row.id, label:String(row.label || row.id),
      home: String(row.home || (row.id === 'default' ? '' : path.join(homeDir, '.antigravity-profiles', row.id))),
      ...(row.hidden === true ? {hidden:true} : {}), ...exitFields(row)});
  }
  return [...rows.values()];
}
// 分享版：内置账号 2的目录真正存在才列出来；旧会话仍可按 allProfiles 解析。
// 2026-11-17：账号页「移除」内置账号只写 hidden，列表不再显示，旧会话照样按 allProfiles 找到原目录。
function normalizeProfiles(profiles, homeDir = defaultHome(process.env)) {
  const rows = allProfiles(profiles, homeDir).filter(p => !p.hidden);
  if (!require('./distribution').sharedBuild) return rows;
  const declared = Array.isArray(profiles) && profiles.some(p => p && p.id === 'second');
  return rows.filter(p => p.id !== 'second' || declared || fs.existsSync(p.home));
}
function visibleSelection(id, profiles, homeDir) {
  if (!require('./distribution').sharedBuild) return id;
  return normalizeProfiles(profiles, homeDir).some(p => p.id === id) ? id : 'default';
}
function connectionId(id) { return !id || id === 'default' ? 'gemini-cli' : 'gemini-' + id; }
function resolveProfile(config = {}, id, env = process.env, homeDir = defaultHome(env)) {
  const selected = id || config.antigravitySubscriptionProfile || 'default';
  const profiles = allProfiles(config.antigravitySubscriptionProfiles, homeDir);
  const row = profiles.find(p => p.id === selected);
  if (!row) throw new Error('Antigravity 账号配置不存在，未切换到我的账号');
  const home = expanded(row.home || homeDir, homeDir);
  if (row.id === 'default' && !equalPath(physical(home), physical(homeDir)))
    throw new Error('Antigravity 我的账号使用现有系统登录，不能改成独立账号目录');
  const root = physical(path.join(home, '.gemini'));
  const authRoot = physical(path.join(home, '.gemini', 'antigravity-cli'));
  for (const other of profiles) {
    if (other.id === row.id) continue;
    const otherRoot = physical(path.join(expanded(other.home || homeDir, homeDir), '.gemini'));
    const otherAuthRoot = physical(path.join(expanded(other.home || homeDir, homeDir), '.gemini', 'antigravity-cli'));
    if (equalPath(root, otherRoot) || equalPath(authRoot, otherAuthRoot)) throw new Error('两个 Antigravity 账号不能共用登录目录');
  }
  if (env.CLAUDE_HUB_HOME_DIR && row.id !== 'default') {
    const boundary = env.CLAUDE_HUB_DATA_DIR ? path.dirname(path.resolve(env.CLAUDE_HUB_DATA_DIR)) : path.resolve(homeDir);
    const relative = path.relative(physical(boundary), physical(home));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('隔离测试不能访问外部 Antigravity 账号目录');
  }
  return {...row, home, configDir:path.join(home, '.gemini', 'antigravity-cli'),
    authMode:row.id === 'default' ? 'system-keyring' : 'ssh-file'};
}
function tokenFile(profile) {
  return profile.id === 'default' ? null : path.join(profile.home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}
function assertSubscriptionConfig(profile) {
  if (profile.id === 'default') return;
  try {
    const stat = fs.lstatSync(tokenFile(profile));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Antigravity 登录文件不是独立普通文件');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of [path.join(profile.home, '.gemini', 'antigravity-cli', 'settings.json'),
    path.join(profile.home, '.gemini', 'config', 'config.json')]) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    let settings;
    try { settings = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new Error('Antigravity 独立账号配置无效，未启动'); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Antigravity 独立账号配置无效，未启动');
    if (settings.modelProvider || settings.enableAdc || settings.userSettings?.enableAdc)
      throw new Error('Antigravity 独立订阅账号不能启用 API 或 ADC 登录');
  }
}
function assertProfileEnv(env) {
  const id = env.AI_HUB_ANTIGRAVITY_PROFILE;
  if (!id || id === 'default') return;
  const home = env.AI_HUB_ANTIGRAVITY_HOME;
  if (!home || env.SSH_TTY !== SSH_FILE_MARKER || !env.USERPROFILE || !env.HOME ||
    !equalPath(path.resolve(home), path.resolve(env.USERPROFILE)) || !equalPath(path.resolve(home), path.resolve(env.HOME)))
    throw new Error('Antigravity 独立账号环境不完整，已阻止回落系统我的账号');
  if (Object.keys(env).some(key => FOREIGN_AUTH_ENV.test(key) && env[key]))
    throw new Error('Antigravity 独立账号含其他认证环境，已阻止启动');
  assertSubscriptionConfig({id, home});
}
function applyProfileEnv(env, profile) {
  const out = {...env};
  if (profile.id === 'default') {
    if(out.AI_HUB_ANTIGRAVITY_PROFILE && out.AI_HUB_ANTIGRAVITY_PROFILE !== 'default')
      throw new Error('Antigravity 副账号环境不能作为我的账号环境复用');
    return out;
  }
  if (!PROFILE_ID.test(profile.id || '') || !profile.home || !path.isAbsolute(profile.home))
    throw new Error('Antigravity 独立账号目录无效');
  assertSubscriptionConfig(profile);
  // Native agy SSH detection chooses file storage once, before any keyring read.
  // Keep this on every login, models/usage probe and PTY child. Merely changing
  // HOME would silently sign in with the primary Windows Credential Manager entry.
  for (const key of Object.keys(out)) if (FOREIGN_AUTH_ENV.test(key)) delete out[key];
  Object.assign(out, {AI_HUB_ANTIGRAVITY_PROFILE:profile.id, AI_HUB_ANTIGRAVITY_HOME:profile.home,
    USERPROFILE:profile.home, HOME:profile.home, GEMINI_CLI_HOME:profile.home, SSH_TTY:SSH_FILE_MARKER});
  // Dedicated exit: every agy child (session PTY, models, usage, login) leaves through the same
  // loopback proxy. The marker tells cliEnv not to replace it with the Hub-wide proxy.
  delete out.AI_HUB_ANTIGRAVITY_PROXY;
  if (profile.networkInvalid || exitFields(profile).networkInvalid) throw new Error('Antigravity 账号的专线配置无效，已阻止启动（不会改走其他出口）');
  const pinned = exitFields(profile).network;
  if (pinned) for (const key of Object.keys(out)) if (/^(https?|all|no)_proxy$/i.test(key)) delete out[key];
  if (pinned) Object.assign(out, {AI_HUB_ANTIGRAVITY_PROXY:pinned.proxy, HTTP_PROXY:pinned.proxy, HTTPS_PROXY:pinned.proxy,
    ALL_PROXY:pinned.proxy, http_proxy:pinned.proxy, https_proxy:pinned.proxy, all_proxy:pinned.proxy,
    NO_PROXY:'localhost,127.0.0.1', no_proxy:'localhost,127.0.0.1'});
  // CLAUDE_HUB_HOME_DIR is an existing test guard; never manufacture it in production.
  assertProfileEnv(out);
  return out;
}
function profileForSession(opts = {}, config = {}, env = process.env) {
  const history = opts.useResume || opts.geminiChatId || opts.antigravityForkFrom;
  let id = opts.antigravityProfile || (history ? 'default' : config.antigravitySubscriptionProfile);
  const transcript = opts.transcriptPath || opts.resumeTranscriptPath;
  if (!opts.antigravityProfile && transcript && /[\\/]antigravity-cli[\\/]brain[\\/]/i.test(transcript)) {
    for (const row of allProfiles(config.antigravitySubscriptionProfiles, defaultHome(env))) {
      const p = resolveProfile(config, row.id, env);
      const rel = path.relative(path.join(p.configDir, 'brain'), path.resolve(transcript));
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { id = p.id; break; }
    }
  }
  const profile = resolveProfile(config, id, env);
  if (opts.antigravityProfileHome && !equalPath(physical(opts.antigravityProfileHome), physical(profile.home)))
    throw new Error('此会话原来的 Antigravity 账号目录已改变，请先恢复账号配置');
  if (transcript && /[\\/]antigravity-cli[\\/]brain[\\/]/i.test(transcript)) {
    const rel = path.relative(physical(path.join(profile.configDir, 'brain')), physical(transcript));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Antigravity 历史不属于所选账号，未启动新会话');
  }
  return profile;
}
// 2026-11-21：agy 每次换发访问令牌都会改写登录文件（access_token、expiry 变），整文件哈希因此每小时变一次，
// 额度读数按旧归属作废、刚查到的结果被当成「登录已变化」丢掉。只取登录身份（邮箱 + 刷新令牌）做指纹：
// 换发访问令牌不变，重新登录（刷新令牌或邮箱变）才变。认不出结构的文件仍按整文件哈希。
function credentialIdentity(buffer) {
  try {
    const value = JSON.parse(String(buffer));
    const email = typeof value?.id_token_email === 'string' ? value.id_token_email.trim().toLowerCase() : '';
    const refresh = typeof value?.token?.refresh_token === 'string' ? value.token.refresh_token : '';
    if (email || refresh) return digest('identity\0' + email + '\0' + refresh);
  } catch {}
  return digest(buffer);
}
function accountLabel(profile) {
  const file = typeof profile === 'string'
    ? path.join(profile, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    : tokenFile(profile || { id: 'default' });
  if (!file) return '';
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) return '';
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const email = typeof value?.id_token_email === 'string' ? value.id_token_email.trim() : '';
    return email.slice(0, 120);
  } catch { return ''; }
}
function publicAuthInfo(profile) {
  const file = tokenFile(profile);
  let fingerprint = '', present = false;
  if (file) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Antigravity 登录文件不是独立普通文件');
      // Hash only; neither identity nor successful sign-in is inferred from an opaque token file.
      fingerprint = credentialIdentity(fs.readFileSync(file)); present = stat.size > 0;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return {authMode:profile.id === 'default' ? 'system-keyring' : 'ssh-file', credentialFilePresent:present,
    authenticated:null, credentialFingerprint:fingerprint,
    // The pinned proxy is part of the scope: binding an exit retires usage readers built with the old proxy.
    authScope:digest(profile.id + '\0' + physical(profile.home) + '\0' + fingerprint + (profile.network?.proxy ? '\0' + profile.network.proxy : ''))};
}
function usageScope(config, id, env = process.env) { return publicAuthInfo(resolveProfile(config, id, env)).authScope; }
// Config keeps hidden rows (storedProfiles) so a removed built-in stays removed; lists use normalizeProfiles.
const storedProfiles = allProfiles;
module.exports = {exitFields, visibleSelection, normalizeProfiles, storedProfiles, resolveProfile, connectionId, applyProfileEnv, assertProfileEnv,
  assertSubscriptionConfig, profileForSession, tokenFile, accountLabel, credentialIdentity, publicAuthInfo, usageScope, SSH_FILE_MARKER};
