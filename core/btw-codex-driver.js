'use strict';
// 问一下 · Codex（2026-11-05）：Codex 0.164 的 /side 会把整个 TUI 切进旁支对话，
// Hub 之后往主线程发的消息会串进旁支，所以不在 PTY 里敲 /side。改为后台起一个
// 隐藏的 `codex exec fork --ephemeral`：从同一份原生历史分叉、只读沙箱、不落盘，
// 主线程的 PTY、转录和 Hub 状态都不受影响，可以和主线程的回合同时进行。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: spawnDefault } = require('node:child_process');
const { PREFIX } = require('./btw-screen');

const SIDE_RULES = '【旁支提问】这是用户在主线程工作期间插入的旁支提问。这段问答结束后即丢弃，不会写回主线程。'
  + '依据已有对话作答，确有必要时才只读查看文件；不要修改文件，不要运行有副作用的命令，不要启动子 Agent，'
  + '也不要把这条问题当作主线程的新任务继续执行。';
// 跟随主会话 max 档也明显更慢。模型仍与主会话一致。
const SIDE_EFFORT = 'low';
const SIDE_SPEED_TIER = 'standard';
const MAX_ANSWER = 20000;
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function codexSideHomes(session, homeDir = os.homedir()) {
  const home = session.codexRuntimeHome
    || (session.codexSessionsRoot ? path.dirname(session.codexSessionsRoot) : path.join(homeDir, '.codex'));
  return { home, sqliteHome: session.codexHistorySqliteHome || home };
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isInside = (parent, child) => {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const driveOf = p => path.parse(path.resolve(p)).root.toLowerCase();

// 找这条会话的原生记录文件：优先 transcriptPath，否则在历史目录的 sessions 下按编号找。
function findRollout(session, historyHome) {
  const sid = String(session.codexSid || '').toLowerCase();
  const direct = session.transcriptPath;
  if (direct && path.basename(direct).toLowerCase().includes(sid) && fs.existsSync(direct)) return direct;
  for (const root of [session.codexSessionsRoot, path.join(historyHome, 'sessions')].filter(Boolean)) {
    let entries;
    try { entries = fs.readdirSync(root, { recursive: true }); } catch { continue; }
    const hit = entries.find(name => /rollout-.*\.jsonl$/i.test(name) && name.toLowerCase().includes(sid));
    if (hit) return path.join(root, hit);
  }
  return null;
}

// 有些会话（AI Hub 助理、早期组队成员）的原生记录留在另一个 Codex 目录，账号凭据却在会话自己的运行目录。
// Codex 0.164 的 fork 只接受 CODEX_HOME 之内的记录，直接分叉报 must be in Codex home directory（11-07 实测）。
// 这时临时搭一个分叉专用目录：记录用硬链接挂进去（不复制、不改原文件），配置照抄运行目录，
// 凭据只带 access token、不带 refresh token，避免分叉进程轮换掉主会话的登录。
function prepareForeignHistoryHome(session, home, tmpRoots) {
  const historyHome = session.codexHistoryStorageHome
    || (session.codexSessionsRoot ? path.dirname(session.codexSessionsRoot) : null);
  if (!historyHome || samePath(historyHome, home)) return null;
  const rollout = findRollout(session, historyHome);
  if (!rollout || isInside(home, rollout)) return null;
  const sessionsRoot = isInside(path.join(historyHome, 'sessions'), rollout) ? path.join(historyHome, 'sessions') : path.dirname(rollout);
  // 硬链接要求同一盘：优先选与记录同盘的临时根，没有就退回复制。
  const roots = tmpRoots.filter(Boolean);
  const root = roots.find(dir => driveOf(dir) === driveOf(rollout)) || roots[roots.length - 1];
  fs.mkdirSync(root, { recursive: true });
  const base = fs.mkdtempSync(path.join(root, 'hub-btw-codex-home-'));
  try {
    const target = path.join(base, 'sessions', path.relative(sessionsRoot, rollout));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.linkSync(rollout, target); } catch { fs.copyFileSync(rollout, target); }
    try { fs.copyFileSync(path.join(home, 'config.toml'), path.join(base, 'config.toml')); } catch { /* 没有配置就用默认 */ }
    const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
    if (auth && auth.tokens) auth.tokens.refresh_token = '';
    fs.writeFileSync(path.join(base, 'auth.json'), JSON.stringify(auth), { encoding: 'utf8', mode: 0o600 });
    return base;
  } catch (error) {
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    throw error;
  }
}

// 分叉进程不启动任何 MCP：它们可能带着会话身份向 Hub 报到，也会拖慢回答。
// `-c mcp_servers={}` 只会合并不会清空（11-05 实测），只能逐个 enabled=false。
function configuredMcpNames(files, readFile = file => fs.readFileSync(file, 'utf8')) {
  const { scanTomlStatements } = require('./toml-statements');
  const names = new Set();
  for (const file of files) {
    let text;
    try { text = readFile(file); } catch { continue; }
    try {
      for (const item of scanTomlStatements(text).statements) {
        const name = item.path[0] === 'mcp_servers' ? item.path[1] : null;
        if (name && /^[A-Za-z0-9_-]+$/.test(name)) names.add(name);
      }
    } catch { /* 解析不了的配置交给 Codex 自己报错 */ }
  }
  return [...names];
}

const quotedConfigs = text => [...String(text || '').matchAll(/-c '([^']+)'/g)].map(m => m[1]);

function buildCodexSideArgs({ session, outputFile, mcpNames = [], sqliteHome }) {
  if (!SID.test(session.codexSid || '')) throw new Error('Codex 原生会话编号无效');
  const effort = SIDE_EFFORT;
  const args = ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '-o', outputFile,
    '--disable', 'hooks', '--disable', 'daemon_auto_start', '--disable', 'memories', '--disable', 'multi_agent',
    '-c', 'check_for_update_on_startup=false', '-c', 'approval_policy="never"', '-c', 'windows.sandbox="unelevated"',
    '-c', `model_reasoning_effort="${effort}"`];
  if (session.cwd) args.push('-C', session.cwd);
  const model = session.currentModel && session.currentModel.id;
  if (typeof model === 'string' && /^[\w.:\-]+$/.test(model)) args.push('-m', model);
  for (const config of quotedConfigs(require('./codex-speed-tier').buildCodexSpeedTierArg(SIDE_SPEED_TIER))) args.push('-c', config);
  for (const name of mcpNames) args.push('-c', `mcp_servers.${name}.enabled=false`);
  // 运行目录的 config.toml 可能写死 sqlite_home 指向旧历史目录，它比环境变量优先，临时分叉目录要显式盖掉。
  if (sqliteHome) args.push('-c', `sqlite_home=${JSON.stringify(sqliteHome.split(path.sep).join('/'))}`);
  // 问题走 stdin：中文、引号和换行都不经过命令行转义。
  args.push('fork', session.codexSid, '-');
  return args;
}

function sidePrompt(question) {
  return SIDE_RULES + '\n\n' + PREFIX + String(question || '').trim();
}

function killTree(child, spawn) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.on?.('error', () => { try { child.kill(); } catch {} });
      killer.unref?.();
      return;
    } catch {}
  }
  try { child.kill(); } catch {}
}

function friendlyError(raw) {
  const text = String(raw || '');
  if (/usage limit|hit your usage/i.test(text)) return '当前 Codex 账号额度已用完，问一下没有发出；可切换账号后再问';
  // 记录在别处的会话分叉时只带 access token（不带 refresh token），主会话闲置久了 token 会过期。
  if (/\b401\b|unauthorized|token (?:is )?expired|refresh.?token|log ?in again|sign in again/i.test(text)) return 'Codex 登录凭据已过期，问一下没能分叉；在主会话里发一句话让它续期后再问';
  if (/no (?:rollout|thread|session)|not found|找不到/i.test(text)) return 'Codex 还没找到这条会话的原生记录，请等首轮回答结束后再问';
  return text.slice(-300) || 'Codex 没有返回回答';
}

async function askCodexSide({ session, question, env: baseEnv = process.env, spawn = spawnDefault, now = Date.now,
  timeoutMs = 300000, resolveCommand, applyNetwork, tmpRoot = os.tmpdir(), historyTmpRoots = [], profiles }) {
  const q = String(question || '').trim();
  if (!q) throw new Error('请先填写问题');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(q)) throw new Error('问题含有终端控制字符');
  const homes = codexSideHomes(session);
  let forkHome;
  try { forkHome = prepareForeignHistoryHome(session, homes.home, [...historyTmpRoots, tmpRoot]); }
  catch (error) { throw new Error('无法准备这条 Codex 会话的历史记录：' + error.message); }
  try {
    return await runFork({ session, q, homes, forkHome, baseEnv, spawn, now, timeoutMs, resolveCommand, applyNetwork, tmpRoot, profiles });
  } finally {
    // 只删临时目录里的硬链接本身，原记录文件不受影响。
    if (forkHome) try { fs.rmSync(forkHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

async function runFork({ session, q, homes, forkHome, baseEnv, spawn, now, timeoutMs, resolveCommand, applyNetwork, tmpRoot, profiles }) {
  const home = forkHome || homes.home, sqliteHome = forkHome || homes.sqliteHome;
  const env = require('../main/codex-account-namespace').cleanCodexAccountEnv({ ...baseEnv });
  Object.assign(env, { CODEX_HOME: home, CODEX_SQLITE_HOME: sqliteHome, NO_COLOR: '1' });
  // 账号绑定了专属出口时，分叉必须走同一出口；检查失败就不发。
  if (applyNetwork) await applyNetwork(env, session, profiles);
  const launch = (resolveCommand || (e => process.platform === 'win32'
    ? require('../main/codex-windows-command').resolveWindowsCodex(e)
    : { command: 'codex', args: [], env: e }))(env);
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'hub-btw-codex-'));
  const outputFile = path.join(dir, 'answer.md');
  const mcpNames = configuredMcpNames([path.join(homes.home, 'config.toml'), ...(session.cwd ? [path.join(session.cwd, '.codex', 'config.toml')] : [])]);
  const args = [...(launch.args || []), ...buildCodexSideArgs({ session, outputFile, mcpNames, sqliteHome: forkHome })];
  const started = now();
  try {
    const result = await new Promise((resolve) => {
      let child, done = false, buffer = '', stderr = '', failure = '', usage = null;
      const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { killTree(child, spawn); finish({ code: -1, timeout: true }); }, timeoutMs);
      timer.unref?.();
      try {
        child = spawn(launch.command, args, { cwd: session.cwd || dir, env: launch.env || env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) { finish({ code: -3, spawnError: error.message }); return; }
      child.stdout.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'turn.completed') usage = event.usage || null;
          if (event.type === 'error') failure = event.message || failure;
          if (event.type === 'turn.failed') failure = event.error?.message || failure;
        }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
      child.on('error', error => finish({ code: -3, spawnError: error.message }));
      child.on('close', code => finish({ code, failure, stderr, usage }));
      child.stdin.on('error', () => {});
      child.stdin.end(sidePrompt(q), 'utf8');
    });
    let answer = '';
    try { answer = fs.readFileSync(outputFile, 'utf8').trim(); } catch { /* 下面按失败处理 */ }
    if (result.timeout) throw Object.assign(new Error(`问一下等待超过 ${Math.round(timeoutMs / 60000)} 分钟，已停止这次旁支提问`), { code: 'BTW_TIMEOUT' });
    if (result.spawnError) throw new Error('无法启动 Codex：' + result.spawnError);
    if (!answer) throw new Error(friendlyError(result.failure || result.stderr));
    const truncated = answer.length > MAX_ANSWER;
    return { answer: truncated ? answer.slice(0, MAX_ANSWER) : answer, truncated,
      wall_s: Math.round((now() - started) / 100) / 10, usage: result.usage };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

// 账号绑定专属出口时沿用 PTY 启动时的同一套检查（core/codex-exit-network.js）。
async function applyCodexSideNetwork(env, session, profiles) {
  const network = require('./codex-exit-network');
  const list = profiles || require('./hub-config').getConfig().codexSubscriptionProfiles || [];
  const profile = list.find(p => p.id === session.codexProfile);
  if (network.dedicated(profile)) network.applyEnvironment(env, (await network.checkedRoute(profile)).env);
  return env;
}

module.exports = { askCodexSide, applyCodexSideNetwork, buildCodexSideArgs, codexSideHomes, configuredMcpNames, sidePrompt, prepareForeignHistoryHome };
