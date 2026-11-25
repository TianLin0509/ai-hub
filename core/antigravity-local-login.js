'use strict';
//
// 做法：每个账号一份独立的 Chrome 资料目录（按「账号 + 专线」分开），启动参数只对这份资料强制走该专线的本机
// 不改系统代理、不动 Clash / TUN，别的软件和平时用的浏览器都不受影响。
//
// 2026-10 的教训（de9fc200）：带调试端口的浏览器做 Google 登录会被判为自动化。所以这里是普通 Chrome，
// 不开调试端口；授权码由 Hub 从这份资料的浏览历史里按 state 取回（Chrome 约 10 秒落盘一次），自动填进 agy。
// 打开前、授权后各核对一次出口 IP；已开着的同一资料窗口若不是同一专线参数，拒绝继续，请先关掉它。
const fs = require('fs');
const os = require('os');
const path = require('path');
const exitNet = require('./antigravity-exit');
const { parseAuthUrl, latestValidationUrl } = require('./antigravity-vps-login');

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const CALLBACK = 'https://antigravity.google/oauth-callback';

function browserDir(dataDir, profile) {
  const exit = String(profile.exit || 'none').replace(/[^\w-]/g, '_');
  return path.join(dataDir, 'antigravity-browsers', profile.id + '-' + exit);
}
function browserArgs(dir, proxy, url) {
  return ['--user-data-dir=' + dir, '--proxy-server=' + proxy, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--no-first-run', '--no-default-browser-check', '--new-window', url];
}
// A running copy of this profile must have been started with exactly this exit, and never with automation.
function ownerProblem(owners, proxy) {
  for (const o of owners) {
    if (o.automated) return '这个账号的专用浏览器开着调试/自动化模式，请先关掉它的全部窗口再点「授权」';
    if (!new RegExp('(?:^|\\s)"?--proxy-server=' + proxy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"?(?=\\s|$)').test(o.cmd || ''))
      return '这个账号的专用浏览器窗口不是按当前专线打开的，请先关掉它的全部窗口再点「授权」（避免出口不一致）';
  }
  return '';
}
async function browserOwners(dir) {
  const snapshot = await require('./process-inspector').createProcessInspector().snapshot({ force: true });
  const browsers = snapshot.processes.filter(p => /^(chrome|msedge)\.exe$/i.test(p.name));
  if (browsers.some(p => !p.cmd)) throw new Error('无法确认浏览器占用情况，请关闭这个账号的专用浏览器窗口后重试');
  const { matchesProfile } = require('./account-browser-processes');
  return browsers.filter(p => !/(?:^|\s)--type=/.test(p.cmd) && matchesProfile(p.cmd, dir))
    .map(p => ({ pid: p.pid, cmd: p.cmd, automated: /--remote-debugging-(?:port|pipe)|--headless|--enable-automation/.test(p.cmd) }));
}
// Reads the callback URL for this state from a copy of the profile's History (Chrome keeps the file open).
function codeFromHistory(dir, state, { tmpDir = os.tmpdir() } = {}) {
  const src = path.join(dir, 'Default', 'History');
  if (!fs.existsSync(src)) return '';
  const copy = path.join(tmpDir, 'ai-hub-agy-history-' + process.pid + '-' + Date.now() + '.db');
  try {
    fs.copyFileSync(src, copy);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const rows = db.prepare("SELECT url FROM urls WHERE url LIKE 'https://antigravity.google/oauth-callback%' ORDER BY last_visit_time DESC LIMIT 20").all();
      for (const { url } of rows) {
        let u; try { u = new URL(url); } catch { continue; }
        if (u.origin + u.pathname !== CALLBACK || u.searchParams.get('state') !== state) continue;
        const code = u.searchParams.get('code') || '';
        if (/^[\w./~-]{10,2048}$/.test(code)) return code;
      }
    } finally { db.close(); }
  } catch {} finally { try { fs.unlinkSync(copy); } catch {} }
  return '';
}
function authLogFile(dataDir) { return path.join(dataDir, 'antigravity-auth-log.json'); }
function recordAuth(dataDir, profileId, entry) {
  const file = authLogFile(dataDir);
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  all[profileId] = entry;
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, file);
}
function readAuthLog(dataDir) { try { return JSON.parse(fs.readFileSync(authLogFile(dataDir), 'utf8')) || {}; } catch { return {}; } }

// Profiles with a sign-in round in flight in this process (the bind handler must not move them to another exit meanwhile).
const inFlight = new Set();
function isPending(profileId) { return inFlight.has(profileId); }
class AntigravityLocalLogin {
  constructor({ dataDir, onComplete = () => {}, ptyImpl, spawnImpl, ownersImpl = browserOwners, executable, ipImpl,
    pollMs = 2000, finishMs = 90000, historyImpl = codeFromHistory } = {}) {
    Object.assign(this, { onComplete, ptyImpl, spawnImpl, ownersImpl, ipImpl, pollMs, finishMs, historyImpl });
    this.dataDir = dataDir || require('./data-dir').getHubDataDir();
    this.executable = executable || (() => new (require('./account-browser').AccountBrowser)({ dataDir: this.dataDir }).executable());
    this.flights = new Map();
  }
  pending(profileId) { return this.flights.has(profileId); }
  close() { for (const [id, e] of this.flights) { try { e.abort?.(); } catch {} inFlight.delete(id); } this.flights.clear(); }
  async login(row, profile, env) {
    if (this.flights.has(profile.id)) return { message: '授权已在进行中：请在弹出的专用浏览器里完成 Google 登录并点「继续」' };
    if (!profile?.network) throw new Error('这个 Antigravity 账号没有绑定专线，未打开浏览器');
    const proxy = profile.network.proxy;
    // 1) 出口自检：浏览器要走的同一个本机入口，必须从账号绑定的 IP 出去。
    const before = await exitNet.checkedNetwork(profile.network, { force: true, ipImpl: this.ipImpl });
    // 2) 已开着的同一资料窗口必须是同一专线参数。
    const dir = browserDir(this.dataDir, profile);
    const problem = ownerProblem(await this.ownersImpl(dir), proxy);
    if (problem) throw new Error(problem);
    // 第一次用这份资料（还没有任何 Google 登录）：先只打开 Google 登录页，不开 agy 的 60 秒计时，登好再点「授权」。
    const fresh = !fs.existsSync(path.join(dir, 'Default', 'Network', 'Cookies')) && !fs.existsSync(path.join(dir, 'Default', 'Cookies'));
    fs.mkdirSync(dir, { recursive: true });
    if (fresh) {
      await this.openBrowser(dir, proxy, 'https://accounts.google.com/');
      return { message: '第一次使用：已打开这个账号的专用浏览器（出口 ' + before.ip + '，与专线一致）。请先在里面登录 Google（不限时），登录好后回到 Hub 再点一次「授权」，几秒就能完成。' };
    }
    const entry = { ip: before.ip };
    this.flights.set(profile.id, entry);
    inFlight.add(profile.id);
    entry.done = this.round(row, profile, env, entry, dir).then(async () => {
      // 授权后复查：不符就报失败、不记录；复查不了就如实说「未能复查」。
      let ip = '', why = '';
      try { ip = (await exitNet.checkedNetwork(profile.network, { force: true, ipImpl: this.ipImpl })).ip; } catch (e) { why = e.message || '未知原因'; }
      if (/IP 不符/.test(why)) return this.onComplete({ id: row.id, profileId: profile.id, success: false,
        message: 'Antigravity 授权后复查出口不一致：' + why + '；请先检查专线，暂勿使用这个账号' });
      try { recordAuth(this.dataDir, profile.id, { exit: profile.exit, ip: ip || before.ip, expectedIp: profile.network.expectedIp, at: new Date().toISOString(), via: '本机浏览器', ...(ip ? {} : { verifiedAfter: false }) }); } catch {}
      this.onComplete({ id: row.id, profileId: profile.id, success: true,
        message: ip ? 'Antigravity 已在本机浏览器授权（授权前后出口都是 ' + ip + '）' : 'Antigravity 已在本机浏览器授权（授权前出口 ' + before.ip + '；授权后未能复查：' + why + '）' });
    }, e => this.onComplete({ id: row.id, profileId: profile.id, success: false, message: 'Antigravity 授权未完成：' + e.message }))
      .finally(() => { if (this.flights.get(profile.id) === entry) { this.flights.delete(profile.id); inFlight.delete(profile.id); } });
    try { await entry.opened; } catch {}
    if (entry.openError) throw entry.openError;
    if (!entry.browserOpened) { try { await entry.done; } catch {} return { message: '没有打开浏览器：agy 已结束，结果见账号状态' }; }
    return { message: '专用浏览器已打开（出口 ' + before.ip + '，与专线一致）：请在里面登录 Google 并点「继续」授权，授权码会自动填回。'
      + '一轮限时 60 秒；第一次登录来不及也没关系，登录状态会留在这个专用浏览器里，完成登录后再点一次「授权」即可。' };
  }
  openBrowser(dir, proxy, url) {
    const spawn = this.spawnImpl || require('child_process').spawn;
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable(), browserArgs(dir, proxy, url), { windowsHide: false, detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }
  round(row, profile, env, entry, dir) {
    const pty = this.ptyImpl || require('node-pty');
    const cfg = require('./antigravity-config');
    const command = cfg.resolveCommand(env), runEnv = cfg.backgroundEnv(env);
    const tokenFile = require('./antigravity-subscription-profiles').tokenFile(profile);
    const mtime = () => { try { return fs.statSync(tokenFile).mtimeMs; } catch { return 0; } };
    const before = mtime(), started = Date.now();
    let markOpened; entry.opened = new Promise(r => { markOpened = r; });
    return new Promise((resolve, reject) => {
      let out = '', link = null, sent = false, done = false, poll = null;
      const child = pty.spawn(command, ['-p', 'ok', '--print-timeout', '60s'], { name: 'xterm', cols: 3000, rows: 30, cwd: profile.home, env: runEnv });
      const timers = [];
      const finish = error => {
        if (done) return; done = true; markOpened();
        for (const t of timers) clearTimeout(t); clearInterval(poll);
        try { child.kill(); } catch {}
        error ? reject(error) : resolve();
      };
      entry.abort = () => finish(new Error('登录已取消'));
      timers.push(setTimeout(() => finish(new Error(link ? (sent ? '授权码已提交但 agy 没有结束' : '60 秒内没有完成授权；Google 登录会留在专用浏览器里，再点一次「授权」即可') : 'agy 没有给出 Google 授权链接')), this.finishMs));
      child.onData(d => {
        out = (out + d).slice(-20000);
        if (!link && (link = parseAuthUrl(out))) {
          this.openBrowser(dir, profile.network.proxy, link.url).then(() => { entry.browserOpened = true; markOpened(); if (!done) startPolling(); },
            e => { entry.openError = new Error('专用浏览器没打开：' + e.message); finish(entry.openError); });
        }
      });
      child.onExit(({ exitCode }) => {
        const text = out.replace(ANSI, '');
        // Already signed in: agy answers without asking, nothing to authorize.
        if (exitCode === 0 && (mtime() !== before || (!link && before))) return finish();
        const why = text.match(/(Eligibility check failed[^\r\n]*|error:[^\r\n]*|Error:[^\r\n]*)/i)?.[1];
        if (/verify your account|VALIDATION_REQUIRED/i.test(text)) {
          const verify = latestValidationUrl(profile.configDir || path.join(profile.home, '.gemini', 'antigravity-cli'), started - 5000);
          if (verify) return this.openBrowser(dir, profile.network.proxy, verify).then(
            () => finish(new Error('Google 要求先验证这个账号：验证页已在专用浏览器打开，按提示完成后再点一次「授权」')),
            () => finish(new Error('Google 要求先验证这个账号，但专用浏览器没打开验证页；请再点一次「授权」')));
        }
        if (!sent && /timed out|interrupted/i.test(text)) return finish(new Error('60 秒内没有完成授权；Google 登录会留在专用浏览器里，再点一次「授权」即可'));
        finish(new Error(why ? why.trim().slice(0, 300) : sent ? 'agy 退出（代码 ' + exitCode + '）' : '60 秒内没有完成授权；Google 登录会留在专用浏览器里，再点一次「授权」即可'));
      });
      const startPolling = () => {
        poll = setInterval(() => {
          if (done || sent) return;
          const code = this.historyImpl(dir, link.state);
          if (code) { sent = true; child.write(code + '\r'); }
        }, this.pollMs);
      };
    });
  }
}
module.exports = { AntigravityLocalLogin, isPending, browserDir, browserArgs, ownerProblem, codeFromHistory, recordAuth, readAuthLog, authLogFile, CALLBACK };
