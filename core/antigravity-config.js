'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const ENGINE = 'antigravity';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MODEL = 'gemini-3.1-pro-high';
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
function home(env = process.env) { return env.AI_HUB_ANTIGRAVITY_HOME || env.CLAUDE_HUB_HOME_DIR || env.USERPROFILE || env.HOME || os.homedir(); }
function configRoot(env = process.env) { return path.join(home(env), '.gemini', 'antigravity-cli'); }
function resolveCommand(env = process.env) {
  if (env.AI_HUB_ANTIGRAVITY_COMMAND) return env.AI_HUB_ANTIGRAVITY_COMMAND;
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path');
  const dirs = String(env[key] || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(env.LOCALAPPDATA || path.join(home(env), 'AppData', 'Local'), 'agy', 'bin'));
  for (const dir of dirs) {
    const file = path.join(dir.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'agy.exe' : 'agy');
    if (fs.existsSync(file)) return file;
  }
  return process.platform === 'win32' ? 'agy.exe' : 'agy';
}
// Google OAuth refresh and model calls cross the same proxy as the session PTY.
// A Hub started from the desktop shortcut has no proxy env; without this agy
// waits 10 s on the expired-token refresh and then reports "not logged in".
function cliEnv(env = process.env, proxy = require('./hub-config').getConfig().proxy) {
  require('./antigravity-subscription-profiles').assertProfileEnv(env);
  const out = {...env};
  // A dedicated-exit account already carries its own loopback proxy (applyProfileEnv); the Hub-wide
  // proxy must never replace it, or Google would see a second IP for the same account.
  const value = String(env.AI_HUB_ANTIGRAVITY_PROXY || proxy || '').trim();
  if (!value) return out;
  for (const key of Object.keys(out)) if (/^(https?|all|no)_proxy$/i.test(key)) delete out[key];
  Object.assign(out, {HTTP_PROXY:value, HTTPS_PROXY:value, http_proxy:value, https_proxy:value,
    NO_PROXY:'localhost,127.0.0.1', no_proxy:'localhost,127.0.0.1'});
  return out;
}
function isAntigravity(session = {}) {
  return session.geminiProjectHash === ENGINE || /[\\/]antigravity-cli[\\/]brain[\\/]/i.test(session.transcriptPath || session.resumeTranscriptPath || '');
}
const EFFORT_SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/i;
function parseModelEffort(modelId) {
  const raw = String(modelId || '').trim();
  const match = EFFORT_SUFFIX.exec(raw);
  if (!match) return { base: raw, effort: '' };
  return { base: raw.slice(0, match.index), effort: match[1].toLowerCase() };
}
function inferContextWindow(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return 1000000;
  if (id.includes('claude')) return /\[1m\]/.test(id) ? 1000000 : 200000;
  if (id.includes('gpt-oss')) return 128000;
  return 1000000;
}
const BYPASS_SETTINGS = Object.freeze({
  agentMode: 'accept-edits',
  enableTerminalSandbox: false,
  toolPermission: 'always-proceed',
  allowNonWorkspaceAccess: true,
  artifactReviewPolicy: 'always-proceed',
});
function ensureBypassSettingsFile(env = process.env) {
  const file = path.join(configRoot(env), 'ai-hub-bypass-settings.json');
  const raw = JSON.stringify(BYPASS_SETTINGS, null, 2) + '\n';
  try { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === raw) return file; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, raw, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}
function launchArgs(opts = {}) {
  // Never send a legacy Gemini UUID to an unrelated Antigravity conversation.
  if (opts.useResume && opts.geminiChatId && !isAntigravity(opts))
    throw new Error('这是旧 Gemini CLI 历史，可继续查看；请新建 Antigravity 会话，旧会话 ID 不能直接迁移。');
  // Hub runs every agent unattended (Codex/Claude also bypass approvals); a tool
  // review prompt would stall group-chat members that must write answer files.
  const args = ['--dangerously-skip-permissions'];
  if (opts.settingsFile) {
    args.push('--mode', 'accept-edits', '--settings', String(opts.settingsFile));
  }
  const model = opts.model || DEFAULT_MODEL;
  if (!/^[\w.-]+$/.test(model)) throw new Error('Antigravity 模型 ID 无效');
  args.push('--model', model);
  // 型号自带思考档（gemini-3.8-flash-low、gemini-4-neon-high…）时不再加 --effort：agy 判定冲突，丢掉点名型号、退回默认 Neon High
  // （2026-11-22 m5 实测 agy 日志：--model gemini-3.8-flash-low conflicts with --effort=max）。
  if (opts.effort && !EFFORT_SUFFIX.test(model)) {
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(opts.effort)) throw new Error('Antigravity 思考档无效');
    args.push('--effort', opts.effort);
  }
  if (opts.useResume && opts.geminiChatId) {
    if (!UUID.test(opts.geminiChatId)) throw new Error('Antigravity conversation ID 无效');
    args.push('--conversation', opts.geminiChatId);
  } else if (opts.useResume) throw Error('请从历史记录选择具体的 Antigravity 会话；缺少会话 ID，无法安全恢复。');
  return args;
}
// agy asks "Do you trust the contents of this project?" for every new folder,
// and Hub creates a fresh folder per default session, so the TUI would sit on
// that prompt. Same pre-trust as Claude's hasTrustDialogAccepted.
function ensureWorkspaceTrusted(cwd, env = process.env) {
  if (!cwd) return false;
  const file = path.join(configRoot(env), 'settings.json'), target = path.resolve(cwd);
  let settings = {};
  if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim() || '{}');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Antigravity settings.json 格式无效');
  if (settings.trustedWorkspaces !== undefined && !Array.isArray(settings.trustedWorkspaces)) throw new Error('Antigravity trustedWorkspaces 不是数组，未改写');
  const list = settings.trustedWorkspaces || [];
  const same = value => process.platform === 'win32' ? String(value).toLowerCase() === target.toLowerCase() : value === target;
  if (list.some(same)) return false;
  settings.trustedWorkspaces = [...list, target];
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return true;
}
// Newest conversation that has at least one user message, by transcript mtime.
function latestConversation(env = process.env) {
  const brain = path.join(configRoot(env), 'brain');
  let best = null;
  let entries = [];
  try { entries = fs.readdirSync(brain, {withFileTypes: true}); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const transcriptPath = path.join(brain, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    let stat;
    try { stat = fs.statSync(transcriptPath); } catch { continue; }
    if (best && stat.mtimeMs <= best.mtimeMs) continue;
    if (!/"type"\s*:\s*"USER_INPUT"/.test(fs.readFileSync(transcriptPath, 'utf8'))) continue;
    best = {conversationId: entry.name, transcriptPath, mtimeMs: stat.mtimeMs};
  }
  return best;
}
function launchCommand(opts, env = process.env) {
  require('./antigravity-subscription-profiles').assertProfileEnv(env);
  let settingsFile = opts?.settingsFile === false ? '' : (opts?.settingsFile || '');
  if (!settingsFile && opts?.settingsFile !== false) {
    try { settingsFile = ensureBypassSettingsFile(env); } catch {}
  }
  const args = launchArgs(settingsFile ? { ...opts, settingsFile } : opts);
  return ' & ' + [resolveCommand(env), ...args].map(quote).join(' ') + '\r\n';
}
function eventsFile(dataDir, id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('Hub session ID 无效');
  return path.join(dataDir, 'antigravity-events', id + '.jsonl');
}
function receiptsFile(id, dataDir = require('./data-dir').getHubDataDir()) {
  if(!UUID.test(id))throw Error('Antigravity conversation ID 无效');
  return path.join(dataDir,'antigravity-events','native-'+id+'.json');
}
function migrateConfiguration(env=process.env) {
  const receipt=path.join(configRoot(env),'ai-hub-migration.json');
  if(fs.existsSync(receipt)&&JSON.parse(fs.readFileSync(receipt,'utf8')).version===1)return;
  const root=path.join(home(env),'.gemini'),legacy=path.join(root,'settings.json');
  const target=path.join(root,'config','mcp_config.json');
  if(fs.existsSync(legacy)){
    const old=JSON.parse(fs.readFileSync(legacy,'utf8').replace(/^\uFEFF/,''));
    const current=fs.existsSync(target)?JSON.parse(fs.readFileSync(target,'utf8').replace(/^\uFEFF/,'').trim()||'{}'):{};
    let changed=false;
    for(const [name,server] of Object.entries(old.mcpServers||{})){
      current.mcpServers ||= {};
      if(Object.hasOwn(current.mcpServers,name))continue;
      const {url,httpUrl,trust,...entry}=server;
      current.mcpServers[name]={...entry,...(httpUrl||url?{serverUrl:httpUrl||url}:{})};changed=true;
    }
    if(changed){
      fs.mkdirSync(path.dirname(target),{recursive:true});
      if(fs.existsSync(target))fs.copyFileSync(target,target+'.before-hub-'+Date.now());
      fs.writeFileSync(target,JSON.stringify(current,null,2)+'\n','utf8');
    }
  }
  const skills=path.join(root,'skills'),newSkills=path.join(configRoot(env),'skills');
  if(fs.existsSync(skills))for(const entry of fs.readdirSync(skills,{withFileTypes:true})){
    const destination=path.join(newSkills,entry.name);
    if(!entry.isDirectory()||entry.isSymbolicLink()||fs.existsSync(destination))continue;
    fs.cpSync(path.join(skills,entry.name),destination,{recursive:true,errorOnExist:true,force:false});
  }
  fs.mkdirSync(path.dirname(receipt),{recursive:true});
  fs.writeFileSync(receipt,JSON.stringify({version:1,completedAt:new Date().toISOString()}),'utf8');
}
function installHooks(env, dataDir, id) {
  migrateConfiguration(env);
  const root = configRoot(env), configFile = path.join(home(env), '.gemini', 'config', 'hooks.json');
  let config = {};
  if (fs.existsSync(configFile)) config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '').trim()||'{}');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Antigravity hooks.json 格式无效');
  const script = path.join(root, 'ai-hub-hook.cjs');
  fs.mkdirSync(root, {recursive: true});
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'antigravity-hub-hook.cjs'), script);
  const node = process.execPath;
  const prefix = process.versions.electron ? process.platform==='win32' ? 'set "ELECTRON_RUN_AS_NODE=1" && ' : 'ELECTRON_RUN_AS_NODE=1 ' : '';
  // agy's Go cmd /c launcher escapes embedded quotes on Windows. Encoding the
  // PowerShell command preserves paths with spaces and inherited JSON stdin.
  const cmd = event => {
    if (process.platform !== 'win32') return prefix + '"' + node + '" "' + script + '" ' + event;
    const ps = (process.versions.electron ? "$env:ELECTRON_RUN_AS_NODE='1'; " : '') +
      '& ' + [node, script, event].map(quote).join(' ') + '; exit $LASTEXITCODE';
    return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(ps, 'utf16le').toString('base64');
  };
  config['ai-hub-lifecycle'] = {enabled:true,
    PreInvocation:[{type:'command',command:cmd('PreInvocation'),timeout:5}],
    PostInvocation:[{type:'command',command:cmd('PostInvocation'),timeout:5}],
    Stop:[{type:'command',command:cmd('Stop'),timeout:5}]};
  fs.mkdirSync(path.dirname(configFile), {recursive:true});
  const raw = JSON.stringify(config, null, 2) + '\n';
  if (!fs.existsSync(configFile) || fs.readFileSync(configFile, 'utf8') !== raw) {
    if (fs.existsSync(configFile)) fs.copyFileSync(configFile, configFile + '.before-hub-' + Date.now());
    fs.writeFileSync(configFile, raw, 'utf8');
  }
  const file = eventsFile(dataDir, id);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  env.AI_HUB_ANTIGRAVITY_EVENTS_FILE = file;
  env.AI_HUB_ANTIGRAVITY_SESSION_ID = id;
  return {eventsFile:file, configFile};
}
// Background agy queries (usage every 5 min, model list) must not flash a window.
// 2026-10-29 reproduced on Windows 11 with Windows Terminal as the default console:
// a console-less Node parent (Electron) running agy.exe directly with windowsHide
// still opens a "Terminal" window, while git the same way, or agy through a hidden
// cmd.exe, opens none. So on Windows agy goes through cmd /d /s /c. The argv is a
// fixed set of plain tokens; anything cmd could interpret is refused, not escaped.
function windowsCmdLine(command, args) {
  if (/["%^&|<>\r\n]/.test(String(command))) throw Error('Antigravity 命令路径含有不支持的字符');
  for (const arg of args) if (!/^[\w./:=@-]+$/.test(String(arg))) throw Error('Antigravity 后台查询参数含有不支持的字符');
  return '"' + ['"' + command + '"', ...args].join(' ') + '"';
}
// Same contract as account-adapters.run: resolves {code, stdout, stderr} for any exit
// code, rejects on spawn failure / timeout. Through cmd a missing agy is cmd's exit 1
// "not recognized", so that is turned back into ENOENT; on timeout the whole tree
// (cmd and agy, which boots a language server) is killed, not just cmd.
const NOT_FOUND = /is not recognized as an internal or external command|不是内部或外部命令/i;
// Background agy runs never open a browser (2026-11-05). When the primary account's
// Credential Manager token has expired and the refresh cannot reach Google, `agy -p`
// falls back to interactive OAuth and opens the sign-in page through `rundll32` — from
// the 5-minute usage poll that meant a new Google tab every 5 minutes. These hidden
// children get a no-op rundll32 first on PATH; agy then just prints its sign-in prompt
// and the query fails as "not signed in". Interactive sessions and the explicit login
// keep the real PATH, so signing in still opens the browser.
const NO_BROWSER_STUB = '@exit /b 0\r\n';
function noBrowserDir({dir = path.join(os.tmpdir(), 'ai-hub-agy-no-browser'), fsImpl = fs} = {}) {
  const file = path.join(dir, 'rundll32.cmd');
  try { if (fsImpl.readFileSync(file, 'utf8') === NO_BROWSER_STUB) return dir; } catch {}
  fsImpl.mkdirSync(dir, {recursive: true});
  fsImpl.writeFileSync(file, NO_BROWSER_STUB);
  return dir;
}
function backgroundEnv(env, {platform = process.platform, stubDir = noBrowserDir} = {}) {
  // agy only honours "true" (verified 2026-11-04: "1" still spawned the updater)
  const out = {...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true'};
  if (platform !== 'win32') return out;
  const key = Object.keys(out).find(k => k.toLowerCase() === 'path') || 'Path';
  for (const k of Object.keys(out)) if (k !== key && k.toLowerCase() === 'path') delete out[k];
  out[key] = stubDir() + path.win32.delimiter + (out[key] || '');
  return out;
}
function runCli(command, args, env, timeout = 15000, {platform = process.platform, execFileImpl = require('child_process').execFile,
  killTree = pid => require('child_process').execFile('taskkill', ['/T', '/F', '/PID', String(pid)], {windowsHide: true}, () => {}), stubDir} = {}) {
  return new Promise((resolve, reject) => {
    const viaCmd = platform === 'win32';
    const file = viaCmd ? (env.ComSpec || env.COMSPEC || 'cmd.exe') : command;
    const argv = viaCmd ? ['/d', '/s', '/c', windowsCmdLine(command, args)] : args;
    let timedOut = false, timer = null;
    // Background queries never start agy's self-updater (2026-11-04): `agy --bg-updater` is spawned in a
    // console of its own, which Windows Terminal shows on top of whatever the person is doing (and steals
    // focus). Interactive Antigravity sessions are not affected and keep updating as before.
    try { env = backgroundEnv(env, {platform, ...(stubDir ? {stubDir} : {})}); }
    catch (error) { return reject(Object.assign(Error('Antigravity 后台查询无法准备免弹窗环境：' + error.message), {code: error.code})); }
    const child = execFileImpl(file, argv,
      {env, windowsHide: true, windowsVerbatimArguments: viaCmd, timeout: viaCmd ? 0 : timeout, maxBuffer: 1024 * 1024, encoding: 'utf8'},
      (error, stdout, stderr) => {
        clearTimeout(timer);
        if (timedOut) return reject(Object.assign(Error('Antigravity 查询超时'), {code: 'ETIMEDOUT', killed: true}));
        if (error && (!Number.isInteger(error.code) || error.killed)) return reject(error);
        if (viaCmd && error?.code === 1 && NOT_FOUND.test(String(stderr)))
          return reject(Object.assign(Error('找不到 Antigravity 命令：' + command), {code: 'ENOENT'}));
        resolve({code: error?.code || 0, stdout, stderr});
      });
    if (viaCmd && timeout > 0) timer = setTimeout(() => {
      timedOut = true;
      if (child?.pid) killTree(child.pid);
      setTimeout(() => { try { child?.kill(); } catch {} }, 3000).unref?.();  // taskkill 失败时至少停掉 cmd，回调一定会到
    }, timeout);
  });
}
module.exports = {ENGINE, UUID, DEFAULT_MODEL, EFFORT_SUFFIX, BYPASS_SETTINGS, parseModelEffort, inferContextWindow, home, configRoot, resolveCommand, cliEnv, runCli, backgroundEnv, noBrowserDir, windowsCmdLine, ensureWorkspaceTrusted, ensureBypassSettingsFile, latestConversation, isAntigravity, launchArgs, launchCommand, eventsFile, receiptsFile, migrateConfiguration, installHooks};
