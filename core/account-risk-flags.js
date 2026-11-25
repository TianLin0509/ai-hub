'use strict';
// 账号风控标记（2026-10-31）：人工记下某个账号被平台风控的时间与观察期。
// 观察期内仍可手动使用，只是不再被推荐、不再被自动换号选中。到期或解除后留作历史。
//   任何状态都：右侧栏默认隐藏、不推荐、不进自动换号与自动派工、不计入额度汇总。
//   会员到期、风控封禁的号用不了，手动切换和点名也拦下并写清原因；风控观察、暂停使用手动仍可选。
//   旧记录没有 status 字段，按「风控观察」处理。
//   登录过期（暂缓）：同会员到期一样拦手动，另外不做后台额度刷新、不因它弹授权页。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'account-risk-flags.json';
const DAY_MS = 24 * 3600 * 1000;
const KINDS = new Set(['claude', 'codex', 'gemini']);
const NOTE_MAX = 200;
const BATCH_MAX = 100;
const STATUSES = {
  expired: { label: '会员到期', blocksManual: true },
  banned: { label: '风控封禁', blocksManual: true },
  risk: { label: '风控观察', blocksManual: false },
  paused: { label: '暂停使用', blocksManual: false },
  relogin: { label: '登录过期（暂缓）', blocksManual: true, pausesRefresh: true },
};
const DEFAULT_STATUS = 'risk';

const keyOf = (kind, profileId) => kind + ':' + (profileId || 'default');
const inForce = (flag, now) => !!flag && (flag.until == null || flag.until > now);
const statusOf = flag => (flag && STATUSES[flag.status] ? flag.status : DEFAULT_STATUS);
const statusLabel = flag => STATUSES[statusOf(flag)].label;
const blocksManual = flag => !!flag && STATUSES[statusOf(flag)].blocksManual;
function shortDate(at) {
  const date = new Date(at);
  return `${date.getMonth() + 1}-${date.getDate()}`;
}
// 给推荐、点名、换号失败用的一句原因：「会员到期（11-24 标记：备注）」。
function reasonText(flag) {
  if (!flag) return '';
  const note = String(flag.note || '').trim();
  return `${statusLabel(flag)}（${shortDate(flag.updatedAt || flag.flaggedAt)} 标记${note ? '：' + (note.length > 40 ? note.slice(0, 39) + '…' : note) : ''}）`;
}

function createAccountRiskStore({ dataDir, now = Date.now, logger = console }) {
  const file = path.join(dataDir, FILE_NAME);

  // 文件损坏时抛错而不是当成「没有标记」，否则一次写入就会把记录冲掉。
  function read() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, accounts: {} }; throw error; }
    const data = JSON.parse(text);
    return { version: 1, accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {} };
  }
  // 两个 Hub 实例共用这份文件：锁住整个读改写，避免后写者覆盖另一实例的更新。
  function withWriteLock(change) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = file + '.lock', deadline = Date.now() + 2000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    let fd;
    while (fd === undefined) {
      try { fd = fs.openSync(lock, 'wx'); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 10000) {
            fs.unlinkSync(lock);
            continue;
          }
        } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
        if (Date.now() >= deadline) throw new Error('账号状态记录正被另一个 Hub 实例写入，请稍后重试');
        Atomics.wait(sleeper, 0, 0, Math.min(25, deadline - Date.now()));
      }
    }
    try { return change(); }
    finally {
      try { fs.closeSync(fd); }
      finally { fs.unlinkSync(lock); }
    }
  }
  function write(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
    try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  function validate(kind, profileId) {
    if (!KINDS.has(kind) || !/^[\w-]{1,64}$/.test(profileId || '')) throw new Error('账号信息不完整，未保存账号状态');
  }
  function itemsOf(payload) {
    const items = Array.isArray(payload.items) ? payload.items : [{ kind: payload.kind, profileId: payload.profileId }];
    if (!items.length) throw new Error('没有选中账号');
    if (items.length > BATCH_MAX) throw new Error(`一次最多标记 ${BATCH_MAX} 个账号`);
    for (const item of items) validate(item?.kind, item?.profileId);
    return items;
  }

  // 界面只需要：现在是否在观察期，以及最近一次结束的记录。
  function snapshot() {
    const at = now(), result = {};
    for (const [key, row] of Object.entries(read().accounts)) {
      const active = inForce(row.active, at) ? { ...row.active, status: statusOf(row.active) } : null;
      const expired = row.active && !active ? { ...row.active, endedAt: row.active.until } : null;
      const last = expired || (row.history || []).at(-1) || null;
      if (active || last) result[key] = { active, last };
    }
    return result;
  }
  // 单个或批量（items）标记；status 缺省为风控观察，与旧版一致。
  function flag(payload = {}) {
    const items = itemsOf(payload);
    const { note = '', at, days } = payload;
    const status = payload.status == null ? DEFAULT_STATUS : payload.status;
    if (!STATUSES[status]) throw new Error('未知的账号状态：' + status);
    const flaggedAt = Number(at) || now();
    if (flaggedAt > now() + 60000) throw new Error('发生时间不能晚于现在');
    if (days !== null && !(Number.isInteger(days) && days > 0)) throw new Error('观察期需要是正整数天，或选择手动解除');
    const until = days === null ? null : flaggedAt + days * DAY_MS;
    if (until !== null && until <= now()) throw new Error('按这个发生时间，观察期已经结束，请延长观察期');
    return withWriteLock(() => {
      const data = read();
      for (const item of items) {
        const key = keyOf(item.kind, item.profileId), row = data.accounts[key] || { history: [] };
        // 已有标记被改成别的状态时，旧的一条进历史，留下何时从什么改成什么。
        if (row.active) row.history = [...(row.history || []), { ...row.active, endedAt: inForce(row.active, now()) ? now() : row.active.until }];
        row.active = { flaggedAt, until, note: String(note).trim().slice(0, NOTE_MAX), status, updatedAt: now() };
        data.accounts[key] = row;
      }
      write(data);
      return snapshot();
    });
  }
  // 恢复正常：单个或批量；没有标记的号跳过。
  function clear(payload = {}) {
    const items = itemsOf(payload);
    return withWriteLock(() => {
      const data = read();
      let changed = false;
      for (const item of items) {
        const row = data.accounts[keyOf(item.kind, item.profileId)];
        if (!row?.active) continue;
        const endedAt = inForce(row.active, now()) ? now() : row.active.until;
        row.history = [...(row.history || []), { ...row.active, endedAt }];
        row.active = null;
        changed = true;
      }
      if (changed) write(data);
      return snapshot();
    });
  }
  function activeFlag(kind, profileId) {
    try { const flag = read().accounts[keyOf(kind, profileId)]?.active; return inForce(flag, now()) ? flag : null; }
    catch (error) { logger.warn?.('[account-risk] 账号状态读取失败：' + error.message); return null; }
  }
  // 自动换号的候选过滤：读不出记录时记日志，按没有标记处理，不让换号流程卡死。
  const isFlagged = (kind, profileId) => !!activeFlag(kind, profileId);
  // 不推荐、不自动选的原因（没有标记时为空串）。
  const reasonOf = (kind, profileId) => reasonText(activeFlag(kind, profileId));
  // 会员到期、风控封禁：手动切换与点名也拦下，返回原因；其余状态返回空串。
  function manualBlock(kind, profileId) {
    const flag = activeFlag(kind, profileId);
    if (!blocksManual(flag)) return '';
    const after = statusOf(flag) === 'relogin' ? '要用时先到账号页点「授权」重新登录，再在右侧账号额度栏右键这个号选「恢复正常」' : '若已恢复，请在右侧账号额度栏右键这个号选「恢复正常」';
    return `账号已标记${reasonText(flag)}；${after}`;
  }
  // 后台额度刷新、登录刷新要跳过的号（登录过期暂缓）。
  function pausesRefresh(kind, profileId) {
    const flag = activeFlag(kind, profileId);
    return !!flag && !!STATUSES[statusOf(flag)].pausesRefresh;
  }
  // 一次读出一批号的原因：Map(profileId → 原因)，给推荐排序用（Map 也有 has，旧调用照旧）。
  function reasonMap(kind, ids) {
    let accounts = {};
    try { accounts = read().accounts; } catch (error) { logger.warn?.('[account-risk] 账号状态读取失败：' + error.message); }
    const at = now(), out = new Map();
    for (const id of ids || []) {
      const flag = accounts[keyOf(kind, id)]?.active;
      if (inForce(flag, at)) out.set(id, reasonText(flag));
    }
    return out;
  }
  return { file, snapshot, flag, clear, isFlagged, reasonOf, manualBlock, pausesRefresh, reasonMap };
}

module.exports = { BATCH_MAX, DAY_MS, DEFAULT_STATUS, FILE_NAME, STATUSES, blocksManual, createAccountRiskStore, inForce, keyOf, reasonText, statusLabel, statusOf };
