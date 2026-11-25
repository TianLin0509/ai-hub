'use strict';

// Adds, renames and removes Claude / Codex subscription accounts in the raw
// config (providers.<kind>.subscription_profiles). Pure: the caller reads the
// config for update, saves it, and creates nothing but the empty account folder.
//
// - New ids are random (acct-xxxxxx) and never reused, so an old session that
//   still names a removed account can never land on a different new one.
// - Renaming changes only the label: sessions keep their id and folder.
// - Removing drops the row only. The folder, its login and history stay on
//   disk, and nothing is logged out, so the server-side login stays valid.
const path = require('path');
const crypto = require('crypto');

const KINDS = {
  claude: { folder: '.claude-profiles', name: 'Claude' },
  codex: { folder: '.codex-profiles', name: 'Codex' },
  // 2026-11-17：Antigravity 账号同样可在账号页新建、改名、移除；内置我的账号/账号 2移除时只标 hidden。
  antigravity: { folder: '.antigravity-profiles', name: 'Antigravity', hideBuiltIn: true },
};
const BUILT_IN = new Set(['default', 'second']);
const LABEL_MAX = 40;

function kindOf(kind) {
  if (!Object.hasOwn(KINDS, kind)) throw new Error('只支持 Claude、Codex 和 Antigravity 账号');
  return KINDS[kind];
}
function cleanLabel(label) {
  const value = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (!value) throw new Error('请填写账号名称');
  if (value.length > LABEL_MAX) throw new Error(`账号名称最多 ${LABEL_MAX} 个字`);
  return value;
}
function rowsOf(raw, kind) {
  const rows = raw.providers?.[kind]?.subscription_profiles;
  return Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object') : [];
}
function withRows(raw, kind, rows) {
  return { ...raw, providers: { ...raw.providers, [kind]: { ...raw.providers?.[kind], subscription_profiles: rows } } };
}
function newId(taken, random = () => crypto.randomBytes(3).toString('hex')) {
  for (let i = 0; i < 20; i++) {
    const id = 'acct-' + random();
    if (!taken.has(id)) return id;
  }
  throw new Error('未能生成账号标识，请重试');
}

// `normalized` is the list the Hub actually shows (built-in rows included), used
// to refuse duplicates against rows that are not written in the raw file.
function addAccount(raw, kind, label, { homeDir, normalized = [], now = () => new Date().toISOString(), random, network, loginEnv, exit } = {}) {
  const meta = kindOf(kind);
  const name = cleanLabel(label);
  const rows = rowsOf(raw, kind);
  const all = [...normalized, ...rows];
  if (all.some(r => String(r.label || '').trim() === name)) throw new Error(`已有名为「${name}」的${meta.name}账号`);
  const id = newId(new Set(all.map(r => r.id)), random);
  const profile = { id, label: name, home: path.join(homeDir, meta.folder, id), createdAt: now() };
  // A Codex login opens in its own Chrome profile, so this account's ChatGPT
  // cookies never mix with the main or second account's.
  if (kind === 'codex') profile.browserIdentity = 'codex-' + id;
  if (kind === 'codex' && exit != null && exit !== '') {
    if (!require('./codex-account-exit').validExit(exit)) throw new Error('出口标识无效');
    profile.exit = exit;
  }
  // first sign-in already leaves from the IP it will use every day (2026-10-28).
  if (kind === 'claude' && network) profile.network = { ...network };
  if (kind === 'antigravity' && network) {
    if (!require('./antigravity-exit').validExit(exit || '')) throw new Error('出口标识无效');
    profile.exit = exit; profile.network = { ...network };
  }
  if (loginEnv) {
    if (!require('./vps-login-env').ENV_ID.test(loginEnv)) throw Error('登录环境标识无效');
    profile.loginEnv = loginEnv;
  }
  return { raw: withRows(raw, kind, [...rows, profile]), profile };
}

function renameAccount(raw, kind, id, label, { normalized = [] } = {}) {
  const meta = kindOf(kind);
  const name = cleanLabel(label);
  const shown = normalized.find(r => r.id === id);
  const rows = rowsOf(raw, kind);
  const index = rows.findIndex(r => r.id === id);
  if (index < 0 && !shown) throw new Error(`${meta.name}账号不存在，请刷新账号页`);
  if ([...normalized, ...rows].some(r => r.id !== id && String(r.label || '').trim() === name)) throw new Error(`已有名为「${name}」的${meta.name}账号`);
  const next = rows.slice();
  // A built-in row that was never written to the file is written now, with the
  // folder the Hub already resolves for it, so only its label changes.
  if (index < 0) next.push({ id, label: name, home: shown.home || '' });
  else next[index] = { ...rows[index], label: name };
  return { raw: withRows(raw, kind, next), profile: next.find(r => r.id === id) };
}

function bindLoginEnv(raw, id, loginEnv, { normalized = [] } = {}) {
  if (!/^(?:[abcd]|u[0-9a-f]{8})$/.test(loginEnv || '')) throw new Error('登录环境标识无效');
  const shown = normalized.find(r => r.id === id);
  const rows = rowsOf(raw, 'claude');
  const index = rows.findIndex(r => r.id === id);
  if (index < 0 && !shown) throw new Error('Claude账号不存在，请刷新账号页');
  const next = rows.slice();
  if (index < 0) next.push({ id, label: shown.label, home: shown.home || '', loginEnv });
  else next[index] = { ...rows[index], loginEnv };
  return { raw: withRows(raw, 'claude', next), profile: next.find(r => r.id === id) };
}

function removeAccount(raw, kind, id, { selectedId = 'default', sessionsUsing = 0, normalized = [] } = {}) {
  const meta = kindOf(kind);
  if (BUILT_IN.has(id) && !meta.hideBuiltIn) throw new Error('我的账号和账号 2是内置账号，只能改名，不能移除');
  if (id === selectedId) throw new Error('这是当前用量账号，请先把用量切到别的账号再移除');
  // A hidden built-in still resolves for its old sessions, so they do not block hiding it.
  if (sessionsUsing > 0 && !(BUILT_IN.has(id) && meta.hideBuiltIn)) throw new Error(`还有 ${sessionsUsing} 个会话属于这个账号；关闭或删除这些会话后再移除`);
  const rows = rowsOf(raw, kind);
  // The Hub re-creates a built-in account whose row is missing, so it is kept with
  // hidden:true; its folder and login stay, and old sessions still resolve it.
  if (BUILT_IN.has(id)) {
    const index = rows.findIndex(r => r.id === id);
    const shown = normalized.find(r => r.id === id);
    if (index < 0 && !shown) throw new Error(`${meta.name}账号不存在，请刷新账号页`);
    const row = { ...(index < 0 ? { id, label: shown.label, home: shown.home || '' } : rows[index]), hidden: true };
    return { raw: withRows(raw, kind, index < 0 ? [...rows, row] : rows.map((r, i) => i === index ? row : r)), profile: row };
  }
  const removed = rows.find(r => r.id === id);
  if (!removed) throw new Error(`${meta.name}账号不存在，请刷新账号页`);
  return { raw: withRows(raw, kind, rows.filter(r => r.id !== id)), profile: removed };
}

// Sessions (open or saved) that still belong to an account.
function countSessionsUsing(sessions, kind, id) {
  const seen = new Set();
  let count = 0;
  for (const s of sessions || []) {
    if (!s || typeof s !== 'object' || seen.has(s.id)) continue;
    seen.add(s.id);
    const owners = kind === 'claude' ? [s.claudeProfile, s.claudeContextProfile]
      : kind === 'antigravity' ? [s.antigravityProfile] : [s.codexProfile, s.codexContextProfile];
    if (owners.includes(id)) count++;
  }
  return count;
}

// id / 目录由管家定（凭据已在该目录），这里只核对格式、重名和目录位置；出口配置由调用方先按 policy() 核过。
function importAccount(raw, kind, entry, { homeDir, normalized = [], now = () => new Date().toISOString() } = {}) {
  if (kind !== 'claude') throw new Error('管家导入目前只支持 Claude 账号');
  const meta = kindOf(kind);
  const id = String(entry?.id || '');
  if (!/^acct-[0-9a-f]{6}$/.test(id)) throw new Error('管家给的账号标识无效');
  const name = cleanLabel(entry.label);
  const rows = rowsOf(raw, kind);
  const all = [...normalized, ...rows];
  if (all.some(r => r.id === id)) { const e = new Error('Hub 里已有这个账号'); e.code = 'EXISTS'; throw e; }
  if (all.some(r => String(r.label || '').trim() === name)) throw new Error(`已有名为「${name}」的${meta.name}账号`);
  const home = path.join(homeDir, meta.folder, id);
  if (path.resolve(String(entry.home || '')).toLowerCase() !== path.resolve(home).toLowerCase()) throw new Error('管家给的账号目录不在 Hub 的账号目录下，已拒绝');
  const profile = { id, label: name, home, createdAt: typeof entry.createdAt === 'string' && entry.createdAt ? entry.createdAt : now() };
  if (entry.network) profile.network = { ...entry.network };
  if (entry.loginEnv) {
    if (!require('./vps-login-env').ENV_ID.test(entry.loginEnv)) throw Error('登录环境标识无效');
    profile.loginEnv = entry.loginEnv;
  }
  profile.source = 'vps-keeper';
  return { raw: withRows(raw, kind, [...rows, profile]), profile };
}

module.exports = { KINDS, BUILT_IN, importAccount, addAccount, renameAccount, removeAccount, bindLoginEnv, countSessionsUsing, cleanLabel };
