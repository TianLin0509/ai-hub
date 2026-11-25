'use strict';

// 成员（组队成员与挂到负责人名下的会话）调用写类、命令类工具前，Claude 的同步 PreToolUse hook
// （scripts/session-hub-hook.py 的 member-guard）把工具名和参数发到这里；Hub 按 core/member-guard-rules.js
// 负责人放行：hub-team pass --to <成员编号>，放行该成员最近被拦的那一条，30 分钟内原样重试一次有效。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { classify, memberFlagDir } = require('../../core/member-guard-rules');

const PASS_TTL_MS = 30 * 60 * 1000;
const NOTIFY_DEDUP_MS = 10 * 60 * 1000;

function gitBranch(dir) {
  return new Promise(resolve => {
    execFile('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true, timeout: 3000 },
      (error, stdout) => resolve(error ? null : String(stdout || '').trim() || null));
  });
}
async function dirBirth(dir) {
  try { const st = await fs.promises.stat(dir); return st.birthtimeMs || st.ctimeMs || 0; }
  catch (error) { return error && error.code === 'ENOENT' ? null : 0; }
}
const uniq = list => [...new Set(list.filter(Boolean).map(p => path.resolve(p)))];

function createMemberGuard({ getTeamService, getSession, hubDataDir, isolated = false, logger = console,
  now = () => Date.now(), branchOf = gitBranch, birthOf = dirBirth, env = process.env } = {}) {
  const lastBlocked = new Map(); // sid -> { fingerprint, category, label, reason, command, at }
  const passes = new Map();      // sid -> { fingerprint, until }
  const notified = new Map();    // sid + fingerprint -> at
  const home = os.homedir();
  const tempRoots = uniq([env.TEMP, env.TMP, os.tmpdir()]);
  // 生产数据目录始终保护；隔离 Hub 里另外保护它自己的数据目录（实测用）。
  const dataDirs = uniq([path.join(home, '.ai-hub-community'), hubDataDir]);
  const programDirs = uniq([]);
  const protectedPids = isolated ? new Set() : new Set([process.pid]);
  const logFile = hubDataDir ? path.join(hubDataDir, 'logs', 'member-guard.jsonl') : null;

  function log(entry) {
    if (!logFile) return;
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, JSON.stringify({ at: new Date(now()).toISOString(), ...entry }) + '\n', 'utf8'); }
    catch { /* 只是留痕 */ }
  }
  function fingerprintOf(toolName, toolInput) {
    const t = toolInput && typeof toolInput === 'object' ? toolInput : {};
    return `${toolName}\n${String(t.command || t.file_path || t.notebook_path || '').trim()}`;
  }

  async function check({ sessionId, toolName, toolInput, cwd } = {}) {
    try {
      const service = getTeamService && getTeamService();
      const found = service?.teamOfMember?.(sessionId);
      if (!found || !found.member) return { decision: 'allow' };
      const { team, member } = found;
      const session = getSession?.(sessionId);
      const sessionCwd = session?.info?.cwd || session?.cwd || '';
      const hit = await classify({ toolName, toolInput }, {
        cwd: cwd || sessionCwd, access: member.access === 'read' ? 'read' : 'write', env,
        allowRoots: uniq([sessionCwd, cwd, member.cwd, ...tempRoots]), tempRoots,
                workRoots: [require('../../core/storage-roots').workspaceRoot({ fallback: require('node:path').join(require('node:os').homedir(), 'AIWork') })], joinedAt: Number(member.joinedAt) || 0,
        hubDataDir: dataDirs, hubProgramDir: programDirs, protectedPids, branchOf, dirBirth: birthOf,
      });
      if (!hit) return { decision: 'allow' };
      const fingerprint = fingerprintOf(toolName, toolInput);
      const pass = passes.get(sessionId);
      if (pass && pass.fingerprint === fingerprint && pass.until >= now()) {
        passes.delete(sessionId);
        log({ event: 'passed', member: member.memberId, sid: sessionId, category: hit.category, command: hit.command });
        return { decision: 'allow', passed: true };
      }
      lastBlocked.set(sessionId, { fingerprint, ...hit, at: now() });
      log({ event: 'blocked', member: member.memberId, sid: sessionId, category: hit.category, reason: hit.reason, command: hit.command });
      if (hit.category === 'read') {
        return { decision: 'deny', reason: `已拦截：你是只读成员（审查类任务），不能写文件——${hit.reason}。请只读代码、跑只读检查，把结论写进回执；确需写文件先向负责人说明。` };
      }
      const key = sessionId + '\n' + fingerprint;
      if (!(notified.get(key) > now() - NOTIFY_DEDUP_MS)) {
        notified.set(key, now());
        try {
          service.notifyLead?.(team.leadSid, `【权限拦截】${member.memberId}（${member.title || member.role || ''}）的命令被拦下：${hit.label}。\n原因：${hit.reason}\n命令：${hit.command}\n` +
            `能定就自己定：放行这一条用 \`hub-team pass --to ${member.memberId}\`（30 分钟内原样重试一次有效）；不可逆或对外的事走「等你拍板」问用户。`, { wake: true });
        } catch (error) { logger.warn?.('[member-guard] 通知负责人失败', error.message); }
      }
      return { decision: 'deny', reason: `已拦截，已报告负责人：${hit.label}——${hit.reason}。不要换别的命令或通道绕过；等负责人放行后原样重试这一条，或改用不触碰这条边界的做法。` };
    } catch (error) {
      logger.warn?.('[member-guard] 判定出错，放行', error && error.message);
      return { decision: 'allow', error: String(error && error.message || error) };
    }
  }

  // 负责人放行某成员最近被拦的一条（一次性、30 分钟内有效）。
  function pass(callerSid, args = {}) {
    const service = getTeamService && getTeamService();
    const team = service?.teamOfLead?.(callerSid);
    if (!team) throw Error('只有负责人能放行被拦的命令');
    const memberId = String(args.to || args.memberId || '').trim();
    const member = (team.members || []).find(m => m.memberId === memberId && m.sid);
    if (!member) throw Error('用法：pass --to <成员编号>（如 m3）');
    const last = lastBlocked.get(member.sid);
    if (!last) throw Error(`${memberId} 最近没有被拦的命令`);
    passes.set(member.sid, { fingerprint: last.fingerprint, until: now() + PASS_TTL_MS });
    log({ event: 'pass-granted', member: memberId, sid: member.sid, by: callerSid, command: last.command });
    Promise.resolve().then(() => service.invoke?.(callerSid, 'send', { to: memberId, message: `负责人放行了你刚才被拦的命令（${last.label}）：30 分钟内原样重试这一条一次有效。\n${last.command}`, wake: true }))
      .catch(error => logger.warn?.('[member-guard] 通知成员失败', error && error.message));
    return { ok: true, memberId, command: last.command, validMinutes: PASS_TTL_MS / 60000 };
  }

  // 按名册维护标记文件：在队成员（与 teamOfMember 同口径：有会话、未离队）各一个空文件，其余删掉。
  // hook 的 shell 判断看到文件才去问 Hub，所以运行中才入队的会话也立即受保护。
  const flagDir = hubDataDir ? memberFlagDir(hubDataDir) : null;
  // addOnly：只补不删（名册落盘时只看这一队，其余队的标记不能因此被删）；整体对账由定时同步做。
  function syncFlags({ teams = null, addOnly = false } = {}) {
    if (!flagDir) return { ok: false };
    const service = getTeamService && getTeamService();
    const want = new Set();
    for (const team of teams || service?.listTeams?.() || []) for (const m of team.members || []) {
      if (m && m.sid && m.status !== 'dismissed' && /^[\w-]{4,80}$/.test(m.sid)) want.add(m.sid);
    }
    fs.mkdirSync(flagDir, { recursive: true });
    const have = new Set(fs.readdirSync(flagDir));
    for (const sid of want) if (!have.has(sid)) fs.writeFileSync(path.join(flagDir, sid), '', 'utf8');
    if (!addOnly) for (const name of have) if (!want.has(name)) { try { fs.unlinkSync(path.join(flagDir, name)); } catch {} }
    return { ok: true, members: want.size };
  }

  return { check, pass, syncFlags, flagDir, _state: { lastBlocked, passes } };
}

module.exports = { createMemberGuard, PASS_TTL_MS };
