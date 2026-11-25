'use strict';

const fs = require('fs');
const path = require('path');
const { hookRunner, hookCommand } = require('./hook-runner');
const { community } = require('./distribution');

// 状态栏脚本由 node 执行；社区版的机器上不一定有 Node，找不到就不登记状态栏。
function nodeOnPath(env = process.env) {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  const names = process.platform === 'win32' ? ['node.exe', 'node.cmd'] : ['node'];
  return String(env[pathKey] || '').split(path.delimiter).filter(Boolean)
    .some(dir => names.some(name => fs.existsSync(path.join(dir.replace(/^"|"$/g, ''), name))));
}

const MANAGED_SCRIPT_FILES = [
  'session-hub-hook.py',
  'session-hub-hook.ps1',
  'claude-hub-statusline.js',
  'deepseek_repl.py',
];
const MANAGED_HOOK_MARKER = 'session-hub-hook';
const MEMBER_GUARD_MATCHER = 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit';
function memberGuardCommand(pythonCommand) {
  return `{ [ "$AI_HUB_MEMBER_GUARD" = 1 ] || { [ -n "$CLAUDE_HUB_SESSION_ID" ] && [ -n "$AI_HUB_MEMBER_GUARD_DIR" ] && [ -e "$AI_HUB_MEMBER_GUARD_DIR/$CLAUDE_HUB_SESSION_ID" ]; }; } || exit 0; ${pythonCommand}`;
}

function hasManagedHook(settings, eventName, expectedMatcher = null) {
  const entries = settings && settings.hooks && settings.hooks[eventName];
  return Array.isArray(entries) && entries.some(entry =>
    (expectedMatcher == null || String(entry && entry.matcher || '') === String(expectedMatcher))
    && Array.isArray(entry && entry.hooks)
    && entry.hooks.some(hook => String(hook && hook.command || '').includes(MANAGED_HOOK_MARKER))
  );
}

function readSettings(settingsPath, fsModule) {
  if (!fsModule.existsSync(settingsPath)) return { raw: '', settings: {} };
  const raw = fsModule.readFileSync(settingsPath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return { raw, settings: parsed && typeof parsed === 'object' ? parsed : {} };
  } catch (error) {
    // Never replace a user's malformed settings file with a mostly empty Hub
    // file. Surface the error and wait for the source file to become valid.
    throw new Error(`settings.json 不是有效 JSON：${error.message}`);
  }
}

// 但只登记它实测支持的事件，不接管状态栏、不改全局权限模式（那份 settings.json 同事的其他工具也在用）。
// choiceGateMatcher：另登记一条只匹配提问工具的同步 PreToolUse（ask-gate，core/auto-dispatch-rules.js）；
// 只有 Hub 给自动派活会话设了标记时它才拒绝，其余会话直接放行。
function ensureManagedSettings(claudeDir, { fsModule = fs, logger = console, events = null,
  manageStatusLine = true, managePermissionMode = true, choiceGateMatcher = null } = {}) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  const scriptsDir = path.join(claudeDir, 'scripts');
  let changed = false;
  let settings;
  try {
    ({ settings } = readSettings(settingsPath, fsModule));
  } catch (error) {
    return { changed: false, settingsPath, errors: [error.message] };
  }

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
    changed = true;
  }

  const runner = hookRunner();
  const hookScriptPath = path.join(scriptsDir, runner.script).replace(/\\/g, '\\\\');
  const hook = arg => hookCommand(runner, hookScriptPath, arg);
  const managed = [
    ['InstructionsLoaded', hook('instructions-loaded'), '', true],
    // PTY 模式下 /clear、/resume、重启会换原生身份；这两条是 Hub 跟随切换的证据。
    // 同步执行，保证 SessionEnd 先于随后的 SessionStart 到达。
    ['SessionStart', hook('session-start')],
    ['SessionEnd', hook('session-end')],
    // /compact 不触发 UserPromptSubmit；压缩开始的这条信号是它提交成功的确认。
    ['PreCompact', hook('pre-compact'), '', true],
    ['Stop', hook('stop')],
    ['StopFailure', hook('stop-failure')],
    ['UserPromptSubmit', hook('prompt')],
    ['PermissionRequest', hook('permission-request')],
    ['PreToolUse', hook('tool-start'), '', true],
    ['PostToolUse', hook('tool-complete'), '', true],
    ['PostToolUseFailure', hook('tool-failed'), '', true],
    ['SubagentStart', hook('subagent-start'), '', true],
    ['SubagentStop', hook('subagent-stop'), '', true],
    ['TaskCreated', hook('task-start'), '', true],
    ['TaskCompleted', hook('task-complete'), '', true],
    ['Notification', hook('notification'),
      'permission_prompt|agent_needs_input|agent_completed|quota_auto_resume_fired|quota_auto_resume_stale|quota_auto_resume_disabled|elicitation_dialog|elicitation_url_dialog'],
  ];
  // 同步执行：要在工具运行前给出拒绝。matcher 只含提问工具，其他工具不经过它。
  // 超时放宽到 20 秒：公司版用 PowerShell 跑，机器忙时光启动就要几秒，超时等于放行。
  const gateMatcher = typeof choiceGateMatcher === 'string' && /^[A-Za-z0-9_.:|-]{1,300}$/.test(choiceGateMatcher) ? choiceGateMatcher : null;
  if (gateMatcher) managed.push(['PreToolUse', hook('ask-gate'), gateMatcher, false, 20]);
  // 成员工具权限轻量版（main/team/member-guard.js，2026-11-23）：同步 PreToolUse，只匹配写类与命令类工具；
  // 非组队成员 Hub 直接放行。只走 Python 版：PowerShell 版的 hook 脚本没有这条判定，登记了反而走错路径。
  // 命令前的 shell 判断让非成员会话不起 Python（实测每次约 0.2 秒）；Claude 在 Git Bash 里跑 hook。
  // 成员标记两条来源：新建时的环境变量，或 Hub 按名册维护的标记文件（运行中才入队的 hub 子会话、手动挂的成员也立即生效）。
  if (runner.name === 'python') managed.push(['PreToolUse', memberGuardCommand(hook('member-guard')), MEMBER_GUARD_MATCHER, false, 20]);
  // 清掉过时的 ask-gate（开关关掉、或提问工具名改了之后留下的）：只摘 Hub 自己的 ask-gate 条目，
  // 同一组里别人的条目原样保留，组空了才删组。
  if (Array.isArray(settings.hooks.PreToolUse)) {
    const isGate = h => { const c = String(h && h.command || ''); return c.includes(MANAGED_HOOK_MARKER) && /\sask-gate\s*$/.test(c); };
    const kept = [];
    for (const group of settings.hooks.PreToolUse) {
      const hooks = group && Array.isArray(group.hooks) ? group.hooks : null;
      if (!hooks || !hooks.some(isGate) || (gateMatcher && String(group.matcher || '') === gateMatcher)) { kept.push(group); continue; }
      const rest = hooks.filter(h => !isGate(h));
      changed = true;
      if (rest.length) kept.push({ ...group, hooks: rest });
    }
    settings.hooks.PreToolUse = kept;
  }
  const wanted = Array.isArray(events) ? new Set(events) : null;
  for (const [eventName, command, matcher = '', asyncHook = false, timeout = 5] of managed) {
    if (wanted && !wanted.has(eventName)) continue;
    if (!Array.isArray(settings.hooks[eventName])) {
      settings.hooks[eventName] = [];
      changed = true;
    }
    const existingGroup = settings.hooks[eventName].find(entry =>
      String(entry && entry.matcher || '') === String(matcher)
      && Array.isArray(entry && entry.hooks)
      && entry.hooks.some(hook => String(hook && hook.command || '').includes(MANAGED_HOOK_MARKER))
    );
    if (!existingGroup) {
      settings.hooks[eventName].push({
        matcher,
        hooks: [{ type: 'command', command, timeout, ...(asyncHook ? { async: true } : {}) }],
      });
      changed = true;
    } else if (matcher === MEMBER_GUARD_MATCHER && eventName === 'PreToolUse') {
      // 守卫命令改过写法时原地更新（只动 Hub 自己的这一条）。
      const handler = existingGroup.hooks.find(h => /session-hub-hook[^"]*" member-guard$/.test(String(h && h.command || '')));
      if (handler && handler.command !== command) { handler.command = command; changed = true; }
    } else if (asyncHook) {
      const existingHandler = existingGroup.hooks.find(hook =>
        String(hook && hook.command || '').includes(MANAGED_HOOK_MARKER)
      );
      if (existingHandler && existingHandler.async !== true) {
        existingHandler.async = true;
        changed = true;
      }
    }
  }

  const statusJsPath = path.join(scriptsDir, 'claude-hub-statusline.js').replace(/\\/g, '/');
  // 社区版不覆盖用户已有的状态栏，也不改全局权限模式：Hub 启动的会话各自带
  // --permission-mode（session-manager.js），用户在终端里单独跑的 Claude 保持原样。
  const mayOwnStatusLine = manageStatusLine && (!community || (!settings.statusLine && nodeOnPath()));
  if (mayOwnStatusLine && (!settings.statusLine || !String(settings.statusLine.command || '').includes('claude-hub-statusline'))) {
    settings.statusLine = {
      type: 'command',
      command: `node "${statusJsPath}"`,
    };
    changed = true;
  }

  if (managePermissionMode && !community && settings.permissionMode !== 'bypassPermissions') {
    settings.permissionMode = 'bypassPermissions';
    changed = true;
  }

  if (changed) {
    fsModule.mkdirSync(claudeDir, { recursive: true });
    fsModule.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    logger.log?.(`[群聊] settings.json repaired with Hub hook config: ${settingsPath}`);
  }
  return { changed, settingsPath, errors: [] };
}

function ensureClaudeHookIntegration({
  claudeDir,
  sourceScriptsDir,
  fsModule = fs,
  logger = console,
  settingsOptions = {},
} = {}) {
  const result = {
    claudeDir,
    scriptsUpdated: [],
    settingsUpdated: false,
    errors: [],
  };
  if (!claudeDir || !sourceScriptsDir) {
    result.errors.push('claudeDir/sourceScriptsDir 缺失');
    return result;
  }

  const scriptsDir = path.join(claudeDir, 'scripts');
  for (const file of MANAGED_SCRIPT_FILES) {
    const src = path.join(sourceScriptsDir, file);
    const dest = path.join(scriptsDir, file);
    try {
      if (!fsModule.existsSync(src)) continue;
      fsModule.mkdirSync(scriptsDir, { recursive: true });
      let needsCopy = !fsModule.existsSync(dest);
      if (!needsCopy) {
        try { needsCopy = !fsModule.readFileSync(src).equals(fsModule.readFileSync(dest)); }
        catch { needsCopy = true; }
      }
      if (needsCopy) {
        fsModule.copyFileSync(src, dest);
        result.scriptsUpdated.push(file);
        logger.log?.(`[群聊] deployed ${file} -> ${dest}`);
      }
    } catch (error) {
      result.errors.push(`${file} 部署失败：${error.message}`);
    }
  }

  try {
    const settingsResult = ensureManagedSettings(claudeDir, { ...settingsOptions, fsModule, logger });
    result.settingsUpdated = settingsResult.changed;
    result.errors.push(...settingsResult.errors);
  } catch (error) {
    result.errors.push(`settings.json 修复失败：${error.message}`);
  }
  return result;
}

function startClaudeHookIntegrationWatchdog({
  claudeDirs,
  sourceScriptsDir,
  intervalMs = 10 * 1000,
  fsModule = fs,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onRepair = null,
} = {}) {
  // 每项可以是目录字符串，或 { dir, settingsOptions }（见 ensureManagedSettings 的选项）。
  const targets = new Map();
  for (const item of claudeDirs || []) {
    const dir = typeof item === 'string' ? item : item && item.dir;
    if (dir && !targets.has(dir)) targets.set(dir, typeof item === 'string' ? {} : (item.settingsOptions || {}));
  }
  const dirs = Array.from(targets.keys());
  let auditing = false;
  const audit = () => {
    if (auditing) return [];
    auditing = true;
    try {
      const results = dirs.map(claudeDir => ensureClaudeHookIntegration({
        claudeDir,
        settingsOptions: targets.get(claudeDir),
        sourceScriptsDir,
        fsModule,
        logger,
      }));
      for (const result of results) {
        const repaired = result.settingsUpdated || result.scriptsUpdated.length > 0;
        if (repaired) {
          logger.warn?.(`[claude-hooks] 检测到配置漂移并已自愈：${result.claudeDir}`);
          if (typeof onRepair === 'function') onRepair(result);
        }
        if (result.errors.length) {
          logger.warn?.(`[claude-hooks] ${result.claudeDir}: ${result.errors.join('；')}`);
        }
      }
      return results;
    } finally {
      auditing = false;
    }
  };
  const timer = setIntervalFn(audit, Math.max(1000, Number(intervalMs) || 10000));
  timer && timer.unref?.();
  return {
    audit,
    stop() { if (timer) clearIntervalFn(timer); },
  };
}

module.exports = {
  MANAGED_SCRIPT_FILES,
  MANAGED_HOOK_MARKER,
  MEMBER_GUARD_MATCHER,
  hasManagedHook,
  ensureManagedSettings,
  ensureClaudeHookIntegration,
  startClaudeHookIntegrationWatchdog,
};
