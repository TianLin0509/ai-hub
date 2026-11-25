'use strict';
//   - 同一个 Hub 里 CLI 被重开：cli-<旧 CLI 进程号或快照时间>。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KEEP_MS = 14 * 24 * 3600_000;

function claimsDir(dataDir) { return path.join(dataDir, 'auto-resume', 'claims'); }
function claimKey(sessionId, interruption) { return `${sessionId}|${interruption}`; }
function fileFor(dataDir, sessionId, interruption) {
  const hash = crypto.createHash('sha1').update(claimKey(sessionId, interruption)).digest('hex').slice(0, 32);
  return path.join(claimsDir(dataDir), hash + '.json');
}

function claimResume(dataDir, sessionId, interruption, owner, { now = Date.now() } = {}) {
  if (!dataDir || !sessionId || !interruption) return { ok: false, by: null, error: '认领参数不全' };
  const file = fileFor(dataDir, sessionId, interruption);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const held = peekClaim(dataDir, sessionId, interruption);
    return { ok: false, by: held?.owner || 'unknown', at: held?.at || null };
  }
  try { fs.writeFileSync(fd, JSON.stringify({ sessionId, interruption, owner, at: now, pid: process.pid })); }
  finally { fs.closeSync(fd); }
  return { ok: true };
}

function peekClaim(dataDir, sessionId, interruption) {
  try { return JSON.parse(fs.readFileSync(fileFor(dataDir, sessionId, interruption), 'utf8')); }
  catch { return null; }
}

// 短锁（O_EXCL 建锁文件，用完删）：读-改-写认领文件时防两个 Hub 实例同时改。锁残留超过 10 秒视为崩溃遗留，清掉重来。
// 锁忙（对方正在读写，通常几毫秒）：短等重试 5 次 × 100 ms 再判定忙（P2 返工 1 第 6 条）。
const pause = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
function withLock(file, fn, { now = Date.now(), retries = 5, retryMs = 100 } = {}) {
  const lock = file + '.lock';
  let fd = null;
  for (let i = 0; i <= retries && fd == null; i++) {
    try { fd = fs.openSync(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false; try { stale = now - fs.statSync(lock).mtimeMs > 10_000; } catch {}
      if (stale) { try { fs.rmSync(lock, { force: true }); } catch {} continue; }
      if (i < retries) pause(retryMs);
    }
  }
  if (fd == null) return { ok: false, by: 'busy' };
  try { fs.closeSync(fd); return fn(); }
  finally { try { fs.rmSync(lock, { force: true }); } catch {} }
}

// 认领交接：只有当前 owner 是 from 时才改成 to（自动续跑复核拦下、一个字没写时交给「续跑」按钮）。
// 改写走「写临时文件再改名」，并在短锁里做（P2：两个 Hub 实例同时交接 / 同时点按钮，只有一个成）。
function handoffClaim(dataDir, sessionId, interruption, from, to, { now = Date.now() } = {}) {
  const file = fileFor(dataDir, sessionId, interruption);
  return withLock(file, () => {
    const held = peekClaim(dataDir, sessionId, interruption);
    if (!held || held.owner !== from) return { ok: false, by: held?.owner || null };
    const tmp = `${file}.${process.pid}.${now}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...held, owner: to, at: now, pid: process.pid, from }));
    fs.renameSync(tmp, file);
    return { ok: true };
  }, { now });
}

// —— 会话级短租约（P2 统一认领收口）——
// 租约默认 3 分钟，到期自动作废。（团队消息不是续跑语，不取租约。）
//
// 返工 1（负责人定的原则）：
//     会话已开出新回合 → 记「已由 X 续上」；否则自己再发。
//   - 明确没写入（notSent / 复核拦下一个字没写）→ 立即还；已写入或结果不明 → 留到过期，不重发。
function leaseFile(dataDir, sessionId) {
  const hash = crypto.createHash('sha1').update('lease|' + sessionId).digest('hex').slice(0, 32);
  return path.join(claimsDir(dataDir), 'lease-' + hash + '.json');
}
function readLease(dataDir, sessionId) { try { return JSON.parse(fs.readFileSync(leaseFile(dataDir, sessionId), 'utf8')); } catch { return null; } }
const LEASE_TTL_MS = 3 * 60_000;
const writeLease = (file, lease, now) => { const tmp = `${file}.${process.pid}.${now}.${crypto.randomBytes(3).toString('hex')}.tmp`; fs.writeFileSync(tmp, JSON.stringify(lease)); fs.renameSync(tmp, file); };
const guard = (fn, fallback) => { try { return fn(); } catch (error) { return { ...fallback, error: error.message }; } };
// 取租约。返回 { ok:true, token, until } 或 { ok:false, by, at, until, note }（by='busy' 锁忙、'error' 读写出错）。
function claimSession(dataDir, sessionId, owner, { now = Date.now(), ttlMs = LEASE_TTL_MS, note = '', token = null } = {}) {
  if (!dataDir || !sessionId || !owner) return { ok: false, by: null, error: '租约参数不全' };
  return guard(() => {
    const file = leaseFile(dataDir, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withLock(file, () => {
      const held = readLease(dataDir, sessionId);
      if (held && held.until > now && !(token && held.token === token)) return { ok: false, by: held.owner, at: held.at, until: held.until, note: held.note || '' };
      const mine = token && held && held.token === token ? token : crypto.randomUUID();
      writeLease(file, { sessionId, owner, token: mine, at: now, until: now + ttlMs, pid: process.pid, note }, now);
      return { ok: true, token: mine, until: now + ttlMs };
    }, { now });
  }, { ok: false, by: 'error' });
}
function renewSession(dataDir, sessionId, token, { now = Date.now(), ttlMs = LEASE_TTL_MS } = {}) {
  if (!token) return false;
  const r = guard(() => {
    const file = leaseFile(dataDir, sessionId);
    return withLock(file, () => {
      const held = readLease(dataDir, sessionId);
      if (!held || held.token !== token || held.until <= now) return { ok: false };
      writeLease(file, { ...held, until: now + ttlMs }, now);
      return { ok: true };
    }, { now });
  }, { ok: false });
  return r.ok === true;
}
function holdsSession(dataDir, sessionId, token, { now = Date.now() } = {}) {
  const held = readLease(dataDir, sessionId);
  return !!(token && held && held.token === token && held.until > now);
}
// 归还：在锁里核对 token 再删（旧任务删不掉已被别人重新取走的新租约）。
function releaseSession(dataDir, sessionId, token) {
  if (!token) return false;
  const r = guard(() => {
    const file = leaseFile(dataDir, sessionId);
    return withLock(file, () => {
      const held = readLease(dataDir, sessionId);
      if (!held || held.token !== token) return { ok: false };
      fs.rmSync(file, { force: true });
      return { ok: true };
    });
  }, { ok: false });
  return r.ok === true;
}
// 被挡后多久再查：对方租约到期后 1 秒（读不到到期时间按 30 秒）。
function leaseRetryDelay(blocked, now = Date.now()) {
  const until = Number(blocked && blocked.until) || 0;
  return Math.max(1000, (until > now ? until - now : 30_000) + 1000);
}

function releaseClaim(dataDir, sessionId, interruption, owner) {
  const held = peekClaim(dataDir, sessionId, interruption);
  if (!held || held.owner !== owner) return false;
  try { fs.rmSync(fileFor(dataDir, sessionId, interruption), { force: true }); return true; } catch { return false; }
}

// 只清两周前的认领：中断标识里带进程号，进程号复用的概率在两周内可忽略。
function pruneClaims(dataDir, { now = Date.now(), keepMs = KEEP_MS } = {}) {
  const dir = claimsDir(dataDir);
  let removed = 0;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs <= keepMs) continue;
      // 租约文件：还没到期的不删（按租约里的到期时间判，不按文件时间）。
      if (name.startsWith('lease-')) { const held = JSON.parse(fs.readFileSync(file, 'utf8')); if (held.until > now) continue; }
      fs.rmSync(file, { force: true }); removed++;
    } catch {}
  }
  return removed;
}

const OWNER_LABEL = { 'auto-resume': '自动续跑', 'hub-restart': '重启续作', 'restart-card': '重启续跑卡', 'user-button': '用户一键续跑',
  'user-button-ready': '用户一键续跑', 'account-switch': '换号续作', 'soft-compact': '软压缩续跑', 'quota-resume': '额度续跑', patrol: '巡逻自动续',
  busy: '另一条续跑通道', error: '另一条续跑通道' };
const ownerLabel = owner => OWNER_LABEL[owner] || owner || '另一条通道';

module.exports = { OWNER_LABEL, ownerLabel, claimResume, peekClaim, pruneClaims, handoffClaim, releaseClaim, claimSession, renewSession, holdsSession, releaseSession, leaseRetryDelay, readLease, claimKey, claimsDir, LEASE_TTL_MS };
