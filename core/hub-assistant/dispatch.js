'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { compare, reason } = require('../claude-account-pick');
const TYPES = ['追加任务', '相关并行', '无关新建'];
const GRANT_TTL_MS = 24 * 3600 * 1000;
const key = value => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
function candidates(sessions, taskGroups, { cwd, group, relatedSessionId } = {}) {
  const sameGroup = new Set(taskGroups.filterSessions(sessions, group).map(s => s.id));
  return sessions.map(s => {
    const reasons = [];
    if (relatedSessionId === s.id) reasons.push('指定原会话');
    if (group && sameGroup.has(s.id)) reasons.push('同一任务组');
    if (cwd && key(cwd) === key(s.cwd)) reasons.push('同一工作目录');
    return { sessionId: s.id, title: s.title || s.name, cwd: s.cwd, status: s.status,
      groupIds: taskGroups.groupsForSession(s.id), reasons, score: reasons.length,
      lastActiveAt: Math.max(0,...['lastOutputTime','lastOutputAt','updatedAt','createdAt','lastMessageTime','lastCompletedAt','spawnedAt'].map(k=>Number(s[k])||Date.parse(s[k])||0)) };
  }).sort((a, b) => b.score - a.score || b.lastActiveAt - a.lastActiveAt).slice(0, 8);
}
function findAccount(rows, account) {
  const ref = String(account).trim(), byId = rows.find(r => r.id === ref);
  if (byId) return byId;
  const num = (/^(?:账号|帐号)?\s*(\d+)$/.exec(ref) || [])[1];
  const label = r => String(r.label || '').trim();
  const hits = rows.filter(r => label(r) === ref || (num && Number(r.no) === Number(num)) || (num && new RegExp('^(?:账号|帐号)\\s*' + num + '(?!\\d)').test(label(r))));
  if (hits.length === 1) return hits[0];
  const list = rows.slice(0, 30).map(r => r.label ? `${r.label}（${r.id}）` : r.id).join('、');
  throw Error(hits.length ? `「${ref}」命中 ${hits.length} 个账号，请填 id：` + hits.map(r => `${r.label}（${r.id}）`).join('、')
    : `点名账号「${ref}」不在 Hub 账号列表里；可选：${list}`);
}
function chooseAccount(kind, account, inventory, model = '') {
  if(inventory?.backends?.[kind]==='api'){
    if(account)throw Error('当前使用 API 后端，不能指定订阅账号');
    return{account:null,reason:'沿用 Hub API 后端配置'};
  }
  const rows = (inventory?.[kind]?.rows || (kind === 'claude' ? inventory?.rows : []) || []).map(r => ({
    planMultiplier:1,activeSessions:0,resets7dAt:null,spare5h:null,spare7d:null,...r }));
  const isThirdPartyModel = kind === 'gemini' && /^(?:claude|gpt)/i.test(String(model || '').trim());
  const bucket5h = r => (isThirdPartyModel && r.thirdPartySpare5h !== undefined) ? r.thirdPartySpare5h : r.spare5h;
  const bucket7d = r => (isThirdPartyModel && r.thirdPartySpare7d !== undefined) ? r.thirdPartySpare7d : r.spare7d;
  const unavailable = r => r.excluded || r.flagged || r.error || [bucket5h(r), bucket7d(r)].some(v => v != null && v <= 0);
  // Antigravity（gemini）：点名账号检查可用性（拦风控/额度用完/报错）；不点名时绝不静默回落到不可用的默认号。
  if (kind === 'gemini' && rows.length) {
    if (account) {
      const row = findAccount(rows, account);
      if (unavailable(row)) throw Error('点名账号不可用：' + (row.excluded || row.error || (row.flagged ? (typeof row.flagged === 'string' ? row.flagged : '风控观察中') : '额度用完')));
      return { account: row.id, reason: `${row.label || row.id}：点名账号` };
    }
    const pool = rows.filter(r => !unavailable(r));
    if (!pool.length) throw Error('没有可用的 Antigravity 账号');
    if (!pool.some(r => bucket5h(r) !== null || bucket7d(r) !== null)) {
      if (pool.length === rows.length) {
        return { account: null, reason: '沿用 Hub 当前 Antigravity 账号' };
      }
      const preferred = pool.find(r => r.id === (inventory?.gemini?.defaultId || 'default')) || pool[0];
      return { account: preferred.id, reason: `${preferred.label || preferred.id}：排除不可用账号后的可用 Antigravity 账号` };
    }
    // 只有它跌到保留线（5 小时 <15% 或 7 天 <10%）才按号池规则换别的号。
    const defaultRow = pool.find(r => r.id === inventory?.gemini?.defaultId);
    const belowReserve = r => (bucket5h(r) != null && bucket5h(r) < 15) || (bucket7d(r) != null && bucket7d(r) < 10);
    if (defaultRow && !belowReserve(defaultRow)) return { account: defaultRow.id, reason: `${defaultRow.label || defaultRow.id}：Hub 默认 Antigravity 账号` };
    pool.sort((a, b) => Number(bucket7d(b) != null || bucket5h(b) != null) - Number(bucket7d(a) != null || bucket5h(a) != null)
      || (a.activeSessions || 0) - (b.activeSessions || 0)
      || (bucket7d(b) ?? bucket5h(b) ?? -1) - (bucket7d(a) ?? bucket5h(a) ?? -1)
      || (bucket5h(b) ?? -1) - (bucket5h(a) ?? -1)
      || String(a.id).localeCompare(String(b.id)));
    const row = pool[0];
    return { account: row.id, reason: `${row.label || row.id}：Antigravity 号池，${row.activeSessions || 0} 个会话` };
  }
  if (!['claude', 'codex'].includes(kind)) {
    if (account) throw Error('这个后端不支持指定订阅账号');
    return { account: null, reason: '沿用该后端默认配置' };
  }
  if (account) {
    const row = findAccount(rows, account);
    account = row.id;
    if (unavailable(row)) throw Error('点名账号不可用：' + (row.excluded || row.error || (row.flagged ? (typeof row.flagged === 'string' ? row.flagged : '风控观察中') : '额度用完')));
    return { account, reason: kind === 'claude' ? reason(row, true) : `${row.label || account}：点名账号，${row.activeSessions || 0} 个会话` };
  }
  const pool = rows.filter(r => !unavailable(r));
  if (kind === 'claude') {
    if(pool.length&&!pool.some(r=>r.spare5h!==null&&r.spare7d!==null))return{account:null,reason:'没有可确认额度的账号，沿用 Hub 默认账号'};
    pool.sort(compare);
  }
  else pool.sort((a, b) => Number(b.spare5h != null && b.spare7d != null) - Number(a.spare5h != null && a.spare7d != null)
    || (a.activeSessions || 0) - (b.activeSessions || 0) || (b.spare7d ?? -1) - (a.spare7d ?? -1) || String(a.id).localeCompare(String(b.id)));
  const row = pool[0];
  if (!row && rows.length) throw Error('没有可用的 ' + kind + ' 账号');
  return { account: row?.id || null, reason: row ? kind === 'claude' ? reason(row) : `${row.label || row.id}：Codex 号池，${row.activeSessions || 0} 个会话` : '没有号池读数，沿用 Hub 默认账号' };
}
function launchOptions(kind, action, inventory) {
  const picked = chooseAccount(kind, action.account, inventory, action.model), opts = {};
  if (action.cwd !== undefined) {
    if (typeof action.cwd !== 'string' || !path.isAbsolute(action.cwd) || !fs.statSync(action.cwd, { throwIfNoEntry: false })?.isDirectory()) throw Error('工作目录必须是已存在的绝对目录');
    opts.cwd = action.cwd;
  }
  if (picked.account && kind === 'claude') Object.assign(opts, { claudeProfile: picked.account, claudeAccountSwitchable: true });
  if (picked.account && kind === 'codex') Object.assign(opts, { codexProfile: picked.account, codexAccountPinned: true, codexAutoSwitch: true });
  if (picked.account && kind === 'gemini') opts.antigravityProfile = picked.account;
  return { opts, ...picked };
}
function pickAccount({kind,exclude=[],model=''}={},inventory={}){
  if(!['claude','codex','gemini'].includes(kind))throw Error('挑号只支持 Claude / Codex / Antigravity');
  const excluded=new Set(exclude),rows=(inventory[kind]?.rows||(kind==='claude'?inventory.rows:[])||[]).filter(r=>!excluded.has(r.id));
  // 接力不能回落至可能正被排除的默认号；返回 null 由健康模块报告无号可用。
  if(!rows.length)return{id:null,reason:'没有符合规则的接力账号'};
  try{
    const picked=chooseAccount(kind,null,{...inventory,[kind]:{...inventory[kind],rows}},model);
    return{id:picked.account,reason:picked.account?picked.reason:'没有可确认额度的接力账号'};
  }catch(error){return{id:null,reason:error.message};}
}
function teamPrompt(text) {
    return `【前台相关并行派工】前台已代批。请由你担任原任务负责人，按 hub-driver skill 提交组队计划；Hub 会根据可信派工记录代批，成员人数不设常规上限（只有 100 的安全阀）。请先明确原任务与新增任务的分工边界。\n${text}`;
}
// 2026-11-18 前台纯派活：前台 create_session 新开的会话就是这件活的负责人，任务正文后面追加这段负责人守则。
const LEAD_RULES = '【负责人守则】你是这件活的负责人，对它全权负责：小活自己干，大活可以按 hub-driver skill 组队。'
  + '干完交卷时，第一段写结论；附上证据（产物路径、作业卡数或提交号）；要用户定的事单独写一行，并给出你的推荐。'
  + '中途没有结果变化时，这一轮只输出 [[hub:no-update]]。';
// 2026-11-22 hub 命令：负责人要另开会话、点名模型账号、给别的会话发话时用它，缺能力就说「Hub 缺 X」，不绕路。
function hubHint() {
  const file = require('node:path').join(require('../data-dir').getHubDataDir(), 'team', process.platform === 'win32' ? 'hub.cmd' : 'hub.sh');
  return require('node:fs').existsSync(file) ? `另开会话、点名模型账号、给别的会话发话用 \`"${file}" help\` 查用法；没有的能力直接告诉用户「Hub 缺 X」，不用后台命令行绕路。` : '';
}
function leadPrompt(text) {
  return `${text}

${LEAD_RULES}${hubHint()}`;
}
function runtime(session) {
  return { account: (session?.kind === 'codex' ? session.codexProfile : /^gemini/.test(session?.kind || '') ? session.antigravityProfile : session?.claudeProfile) || null,
    kind: session?.kind || null, model: require('../session-capabilities').sessionModelId(session) || null, effort: session?.effort || null, cwd: session?.cwd || null };
}
module.exports = { TYPES, GRANT_TTL_MS, candidates, findAccount, chooseAccount, pickAccount, launchOptions, teamPrompt, leadPrompt, LEAD_RULES, runtime };
