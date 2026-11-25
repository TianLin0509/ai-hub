'use strict';
// What a new computer needs before the shared full build can start Claude: the CLI
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const INSTALL_COMMAND = 'irm https://claude.ai/install.ps1 | iex';
const AUTH_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];

function userHome(env) { return env.CLAUDE_HUB_HOME_DIR || env.USERPROFILE || env.HOME || os.homedir(); }

function claudeInstalled(env = process.env) {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const dirs = String(env[key] || '').split(path.delimiter).filter(Boolean).map(d => d.replace(/^"|"$/g, ''));
  dirs.push(path.join(userHome(env), '.local', 'bin'));
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
  return dirs.some(dir => ['claude.exe', 'claude.cmd', 'claude.bat'].some(name => fs.existsSync(path.join(dir, name))));
}

function settingsEnv(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) || {}; } catch { return {}; }
}

function hasOwnAuthSetup(env, claudeHome) {
  if (AUTH_KEYS.some(key => env[key])) return true;
  return ['settings.json', 'settings.local.json'].some(name => {
    const settings = settingsEnv(path.join(claudeHome, name));
    return !!settings.apiKeyHelper || AUTH_KEYS.some(key => settings.env?.[key]);
  });
}

// True only when Claude Code will open on its own sign-in screen.
function claudeNeedsSignIn(config = {}, env = process.env) {
  const tools = require('./claude-subscription-profiles');
  if (!require('./distribution').sharedBuild || !tools.noClaudeLoginYet(config, env)) return false;
  return !hasOwnAuthSetup(env, tools.resolveProfile(config, 'default', env).home);
}

module.exports = { INSTALL_COMMAND, claudeInstalled, claudeNeedsSignIn };
