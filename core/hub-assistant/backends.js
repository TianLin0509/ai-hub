'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ALL_AI_KINDS, isCodexCliKind, getKindLabel } = require('../ai-kinds');
// 助理的 DeepSeek 后端仍是 Codex 运行时（依赖 Codex 的 MCP 注入）；DeepSeek on Claude Code 不作为助理后端单列。
const BACKENDS = ALL_AI_KINDS.filter(kind => kind !== 'deepseek-claude');
// 新选择只展示 DSH；BACKENDS 保留旧助理恢复能力。
const SELECTABLE_BACKENDS = BACKENDS.filter(kind => kind !== 'deepseek');
function backendKind(kind) {
  if (!BACKENDS.includes(kind)) throw new Error('请选择 Hub 支持的 AI 会话后端');
  return kind;
}
function bindings(store) {
  const saved = store.get('backendSessions') || {};
  const old = store.get('sessionId');
  if (old && !Object.values(saved).includes(old)) saved[store.get('backendKind') || 'codex'] = old;
  return saved;
}
function reserve(store, kind, id) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const rows = bindings(store);
    if (rows[kind] && rows[kind] !== id) throw new Error('助理创建已由另一请求预留，请重新读取助理状态');
    rows[kind] = id;
    store.set('backendSessions', rows);
    store.set('backendCreation:' + kind, {id, state:'reserved', createdAt:Date.now()});
    // Preserve the first-use reservation contract. A failed switch leaves the
    // previously active identity untouched; retries reconcile the new id only.
    if (!store.get('sessionId')) {
      store.set('sessionId', id); store.set('backendKind', kind);
      store.set('assistantCreation', {id, state:'reserved', createdAt:Date.now()});
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
// 换班：解除该后端与旧助理会话的绑定，下一次就绪时按同一档位新建；旧会话记入 retiredAssistants 以便查阅。
function retire(store, kind, id) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const rows = bindings(store);
    if (rows[kind] !== id) throw new Error('助理换班时绑定已变化，未换班');
    delete rows[kind];
    store.set('backendSessions', rows);
    if (store.get('sessionId') === id) store.set('sessionId', null);
    store.set('retiredAssistants', [...(store.get('retiredAssistants') || []), {kind, id, retiredAt: Date.now()}].slice(-50));
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
function unretire(store, kind, id) {
  const rows = bindings(store);
  rows[kind] = id; store.set('backendSessions', rows);
  store.set('sessionId', id); store.set('backendKind', kind);
  store.set('retiredAssistants', (store.get('retiredAssistants') || []).filter(row => row.id !== id));
}
function activate(store, kind, id) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (bindings(store)[kind] !== id) throw new Error('助理后端身份未预留');
    store.confirmAssistant(id);
    store.set('backendCreation:' + kind, {id, state:'confirmed', confirmedAt:Date.now()});
    store.set('backendKind', kind); store.set('sessionId', id);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
function launchOptions(service, kind, id) {
  return { ...providerLaunchOptions(service, kind, id), noInheritCursor: true };
}
// 助理常在没有界面终端的情况下由手机驱动（含按新模型重启后），ConPTY 不能等界面回应光标查询。
function providerLaunchOptions(service, kind, id) {
  const entry = service.getMcpEntry(id);
  if (isCodexCliKind(kind)) return {mcpProfile:'lean', codexMcpEntries:[entry]};
  if (require('../acp-profiles').isAcpKind(kind)) return {mcpProfile:'lean', assistantMcpServers:[{
    name:entry.name,command:entry.command,args:entry.args,
    env:Object.entries(entry.env).map(([name,value])=>({name,value}))
  }]};
  if (kind === 'gemini' || kind === 'kimi') return {mcpProfile:'lean', assistantMcpEntry:entry};
  const file = path.join(service.deps.dataDir, 'assistant', 'claude-' + id + '-mcp.json');
  const {command, args, env} = entry;
  fs.writeFileSync(file + '.tmp', JSON.stringify({mcpServers:{hub_assistant:{command,args,env}}}), {mode:0o600});
  require('./atomic-rename').renameRetry(file + '.tmp', file);
  // Dedicated assistant only. Hub still checks host identity and the current
  // user-request token on every management operation.
  return {mcpProfile:'lean', mcpConfigFile:file, autonomous:true,
    ...(kind === 'claude' ? frontLean(service, id) : service.memory ? {appendSystemPromptFile:service.memory.writePrompt()} : {})};
}
// 用不上编程助手那套行李——全局 CLAUDE.md、84 个技能清单、浏览器说明、全套内置工具（实测开工前 6.3 万 token，
// 每轮都要重读）。照会话场景的干净启动（core/session-scenes.js）换成自己的系统提示。
// 记忆目录（auto memory 打开、autoMemoryDirectory 指向共享目录，CLAUDE.md 继续关闭）；Hub 的 USER.md / MEMORY.md 退役。
// 写工具只为写共享记忆而开：前台是 bypassPermissions，写范围由 scripts/front-memory-hook.js 的 PreToolUse 钩子收口，
// 压缩：前台跑 1M 窗口（Opus/Sonnet/Haiku 5.5 原生 1M，无需 [1m] 后缀；不设 CLAUDE_CODE_DISABLE_1M_CONTEXT），约 65 万压缩。
// CLAUDE_CODE_AUTO_COMPACT_WINDOW 优先于 --autocompact、/autocompact 与 autoCompactWindow（官方 model-config
// 「Set the auto-compact window」），但它是「窗口」不是压缩点：CLI 2.1.322 实际压缩点 = 窗口 − 输出预留 2 万 − 摘要缓冲 1.3 万
// （默认 1M → 96.7 万，与文档「about 967K」一致）。要在 65 万压缩，窗口设 68.3 万；设 65 万会在 61.7 万就压。
const FRONT_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Write', 'Edit'];
const FRONT_COMPACT_WINDOW = '683000'; // 683000 − 20000 − 13000 = 650000
const MEMORY_WRITE_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit';
function frontRules(service) {
  if (!service.frontRules) {
    const { FrontRules } = require('./front-rules');
    service.frontRules = new FrontRules({ directory: path.join(service.deps.dataDir, 'assistant'),
      notify: change => service.watches?.addNotice?.({ id: 'front-rules:' + Date.now(), title: '前台守则', kind: 'memory-update', label: '前台守则已更新',
        text: '前台守则改了：' + change.text + '。改前已备份，不认可可以对我说。' }) });
  }
  return service.frontRules;
}
// 共享记忆目录：只有生产数据目录（~/.ai-hub-community）才指向真实共享目录；隔离 Hub 和单测一律用
function sharedMemoryDir(service) {
  if (service.deps.sharedMemoryDir) return path.resolve(service.deps.sharedMemoryDir);
  if (process.env.CLAUDE_HUB_SHARED_MEMORY_DIR) return path.resolve(process.env.CLAUDE_HUB_SHARED_MEMORY_DIR);
  const production = path.resolve(require('node:os').homedir(), '.ai-hub-community');
  if (path.resolve(service.deps.dataDir).toLowerCase() !== production.toLowerCase()) {
    const dir = path.join(service.deps.dataDir, 'shared-memory');
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, 'MEMORY.md'))) fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# 共享记忆索引（隔离）\n', 'utf8');
    return dir;
  }
  return require('./front-rules').sharedMemoryDir(process.env);
}
function frontPromptText(service) {
  const about = (() => { try { return require('../session-scenes').baseSection(process.env, service.deps.dataDir); } catch { return ''; } })();
  // 换掉 Claude Code 自带系统提示后，auto memory 的目录说明未必还在，这里把共享记忆目录的实际路径写明。
  const where = '共享记忆目录：' + sharedMemoryDir(service).replace(/\\/g, '/') + '（索引是其中的 MEMORY.md；一事一文件，格式照目录里已有条目）。';
  return [frontRules(service).read().trim(), '', where, '', about].join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
function frontSettings(service, id) {
  const q = value => '"' + String(value).replace(/\\/g, '/') + '"';
  const dir = sharedMemoryDir(service);
  const history = service.memory?.historyDir || path.join(service.deps.dataDir, 'assistant', 'memory', 'history');
  const script = path.resolve(__dirname, '../../scripts/front-memory-hook.js');
  // 安装包：钩子命令是一行 shell 文本，设不了环境变量，经数据目录里的小启动文件让 Hub 程序当 Node 跑（同 hub-team 命令）。
  const runner = service.deps.runAsNode
    ? [q(require('../../main/team/command-shim').writeTeamCommand(path.join(service.deps.dataDir, 'assistant', process.platform === 'win32' ? 'front-memory-hook.cmd' : 'front-memory-hook'), { nodeExecutable: service.deps.nodeExecutable, runAsNode: true, script }))]
    : [q(service.deps.nodeExecutable || 'node'), q(script)];
  const hook = mode => [...runner, mode,
    '--memory-dir', q(dir), '--history', q(history), '--endpoint', q(service.endpointFile), '--session', q(id || '')].join(' ');
  return { autoMemoryDirectory: dir, autoMemoryEnabled: true,
    hooks: { PreToolUse: [{ matcher: MEMORY_WRITE_MATCHER, hooks: [{ type: 'command', command: hook('pre'), timeout: 10 }] }],
      PostToolUse: [{ matcher: MEMORY_WRITE_MATCHER, hooks: [{ type: 'command', command: hook('post'), timeout: 10 }] }] } };
}
function frontLean(service, id) {
  const file = path.join(service.deps.dataDir, 'assistant', 'front-desk-system.md');
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file + '.tmp', frontPromptText(service), 'utf8');
  require('./atomic-rename').renameRetry(file + '.tmp', file);
  return {systemPromptFile:file, claudeTools:[...FRONT_TOOLS], disableSlashCommands:true, claudeNoChrome:true, claudeOutputStyle:'default',
    claudeSettingsOverlay: frontSettings(service, id),
    extraEnv:{CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1', CLAUDE_CODE_DISABLE_AUTO_MEMORY:'0', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS:'1',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW:FRONT_COMPACT_WINDOW}};
}
// 把前台的设置叠加到会话已有的 --settings 覆盖项上：普通键直接覆盖，hooks 按事件拼接（不能顶掉个人策略里
// 的 session-hub-hook 等钩子，Hub 靠它们感知会话状态）。session-manager 在拼 --settings 时调用。
function withSettingsOverlay(overrides, overlay) {
  if (!overlay) return overrides;
  const result = { ...overrides };
  for (const [key, value] of Object.entries(overlay)) {
    if (key !== 'hooks') { result[key] = value; continue; }
    const hooks = { ...(overrides.hooks || {}) };
    for (const [event, list] of Object.entries(value || {})) hooks[event] = [...(hooks[event] || []), ...list];
    result.hooks = hooks;
  }
  return result;
}
module.exports = {FRONT_TOOLS, FRONT_COMPACT_WINDOW, frontPromptText, frontSettings, frontRules, sharedMemoryDir, withSettingsOverlay, BACKENDS, SELECTABLE_BACKENDS, backendKind, bindings, reserve, activate, retire, unretire, launchOptions, getKindLabel};
