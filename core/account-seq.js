'use strict';
// 删号后序号不回收、不重排、不复用。右侧栏、点名「账号N」、推荐顺序、额度汇总都用它。
// 数据存在 Hub 数据目录 account-seq.json：{ version, providers: { claude: { ids: { profileId: n }, high: n } } }。
// 首次迁移：Claude 取账号名里的「账号N」（名字就是当初建号时的序号），我的账号=1、账号 2=2；
// Codex / Antigravity 名字里没有序号且从没删过号，按当时右侧栏的顺序 1、2、3… 记下。
const fs = require('fs');
const path = require('path');

const FILE = 'account-seq.json';
const BUILTIN = { claude: { default: 1, second: 2 }, antigravity: {}, codex: {} };

function labelNo(label) {
  const m = /^(?:账号|帐号)\s*(\d{1,4})(?!\d)/.exec(String(label || '').trim());
  return m ? Number(m[1]) : null;
}

function createAccountSeq({ file, fsImpl = fs } = {}) {
  let cache = null;
  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      cache = raw && typeof raw.providers === 'object' && raw.providers ? raw : { version: 1, providers: {} };
    } catch { cache = { version: 1, providers: {} }; }
    return cache;
  }
  function save() {
    const tmp = file + '.tmp';
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fsImpl.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fsImpl.renameSync(tmp, file);
  }
  // rows: [{ profileId, profileLabel }]，按当前显示顺序。返回 Map(profileId → 序号)，新见到的号就地领号并落盘。
  function assign(provider, rows) {
    const state = load();
    const first = !state.providers[provider];
    const p = state.providers[provider] || (state.providers[provider] = { ids: {}, high: 0 });
    const used = new Set(Object.values(p.ids));
    let changed = first;
    const want = (row, index) => {
      const id = row.profileId;
      if (BUILTIN[provider]?.[id]) return BUILTIN[provider][id];
      if (provider === 'claude') return labelNo(row.profileLabel);
      return first ? index + 1 : null;
    };
    // 先认领名字/位置给出的序号，再给其余的号按「历史最大值 + 1」续号，避免新号抢走旧号的数字。
    const pending = [];
    (rows || []).forEach((row, index) => {
      const id = row?.profileId;
      if (!id || p.ids[id]) return;
      const n = want(row, index);
      if (Number.isInteger(n) && n > 0 && !used.has(n)) { p.ids[id] = n; used.add(n); changed = true; }
      else pending.push(id);
    });
    p.high = Math.max(p.high || 0, ...used);
    for (const id of pending) { if (p.ids[id]) continue; p.ids[id] = ++p.high; used.add(p.high); changed = true; }
    if (changed) { try { save(); } catch (error) { console.warn('[account-seq] save', error.message); } }
    return new Map(Object.entries(p.ids));
  }
  // 下一个新号会拿到的序号（新建账号的默认名「账号N」用它，和序号一致）。
  function next(provider) { const p = load().providers[provider]; return (p?.high || 0) + 1; }
  return { assign, next, load, file };
}

let shared = null;
function sharedSeq() {
  const dir = require('./data-dir').getHubDataDir();
  const file = path.join(dir, FILE);
  if (!shared || shared.file !== file) shared = createAccountSeq({ file });
  return shared;
}

// 给额度快照的每一行挂上 seq（不改顺序）。
function stampRows(provider, rows, seq = sharedSeq()) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const map = seq.assign(provider, rows);
  for (const row of rows) { const n = map.get(row.profileId); if (n) row.seq = n; }
  return rows;
}

module.exports = { createAccountSeq, sharedSeq, stampRows, labelNo, FILE };
