'use strict';

// 做法：主进程最早处把 process.env.TZ 设成 Asia/Shanghai。2026-11-13 在 Electron 41 / Windows 实测：
// 主进程与之后拉起的界面进程（renderer）的 getHours()/toLocaleString()/Intl 都随之变成北京时间，系统时区不动。
// 反过来，Hub 拉起的子进程（Claude/Codex 等 AI 会话、PowerShell 终端、浏览器、Python 脚本）一律还原成系统时区：
//  - Windows 上 Python 等 C 运行库把 TZ=Asia/Shanghai 当成 POSIX 写法解析，会错成 UTC。
// 所以这里同时包一层 child_process 的派生入口（spawn/exec/execFile/fork 及其同步版），
// node-pty 不走 child_process，由 core/pty-host.js 调 childEnv() 单独还原。

const childProcess = require('child_process');
const { promisify } = require('util');

const BEIJING_TZ = 'Asia/Shanghai';
const STATE_KEY = '__hubTimezone';

function state() {
  return process[STATE_KEY] || null;
}

function isTzKey(key) {
  return String(key).toUpperCase() === 'TZ';
}

// 子进程环境：去掉 Hub 自己注入的 TZ，还原成 Hub 启动前的值（通常是没有）。
function childEnv(env) {
  const st = state();
  const source = env || process.env;
  if (!st) return env;
  const out = {};
  for (const [key, value] of Object.entries(source)) if (!isTzKey(key)) out[key] = value;
  if (st.originalTz !== undefined) out.TZ = st.originalTz;
  return out;
}

function needsRewrite(env) {
  const st = state();
  if (!st) return false;
  if (!env) return true;
  for (const key of Object.keys(env)) if (isTzKey(key) && env[key] === BEIJING_TZ && st.originalTz !== BEIJING_TZ) return true;
  return false;
}

function isOptions(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 找出调用里的 options 对象；没有就在回调前（或末尾）补一个。各入口都接受「省略 args 直接传 options」。
function withChildEnv(args) {
  const list = Array.from(args);
  for (let i = 1; i < list.length; i += 1) {
    if (isOptions(list[i])) {
      if (needsRewrite(list[i].env)) list[i] = { ...list[i], env: childEnv(list[i].env) };
      return list;
    }
    if (typeof list[i] === 'function') {
      list.splice(i, 0, { env: childEnv() });
      return list;
    }
  }
  list.push({ env: childEnv() });
  return list;
}

const WRAPPED = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

function wrapChildProcess() {
  for (const name of WRAPPED) {
    const original = childProcess[name];
    if (typeof original !== 'function' || original.__hubTzWrapped) continue;
    const wrapped = function hubTzChildProcess(...args) {
      return original.apply(this, withChildEnv(args));
    };
    wrapped.__hubTzWrapped = true;
    wrapped.__hubTzOriginal = original;
    // exec/execFile 的 util.promisify 版本走这个自定义入口（返回 {stdout, stderr}），同样要还原 TZ。
    const custom = original[promisify.custom];
    if (typeof custom === 'function') wrapped[promisify.custom] = function hubTzPromisified(...args) { return custom.apply(this, withChildEnv(args)); };
    childProcess[name] = wrapped;
  }
}

function currentTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

// 电脑本身的时区（Hub 设北京时间之前的）。没装北京时间时就是当前时区。
function systemTimeZone() {
  const st = state();
  return st ? st.systemTimeZone || '' : currentTimeZone();
}

function installBeijingTimezone({ wrapChildren = true } = {}) {
  if (state()) return state();
  const st = { originalTz: process.env.TZ, timeZone: BEIJING_TZ, systemTimeZone: currentTimeZone() };
  Object.defineProperty(process, STATE_KEY, { value: st, enumerable: false, configurable: true });
  process.env.TZ = BEIJING_TZ;
  if (wrapChildren) wrapChildProcess();
  return st;
}

module.exports = { BEIJING_TZ, installBeijingTimezone, childEnv, withChildEnv, systemTimeZone };
