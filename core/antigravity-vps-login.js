'use strict';
// 本机 agy 只经专线换令牌，三处同一出口 IP。
//
// 实测（agy 1.5.14）：无本地浏览器模式下 agy 打印 accounts.google.com 授权链接，回调是
// https://antigravity.google/oauth-callback（页面显示授权码，不回本机端口），然后等 60 秒、可粘贴授权码。
// （manager 1.1.11 的 oauth_code），自动填进去。60 秒内没完成就结束这一轮，再点一次「授权」换新链接。
const fs = require('fs');
const { ENV_ID, VpsLoginEnv } = require('./vps-login-env');
const exitNet = require('./antigravity-exit');

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
// When Google answers VALIDATION_REQUIRED ("Verify your account"), agy logs the official
// accounts.google.com verification link. Open it in the same remote browser (same exit IP).
function latestValidationUrl(configDir, since = 0) {
  try {
    const dir = require('path').join(configDir, 'log');
    const files = fs.readdirSync(dir).map(f => ({ f, t: fs.statSync(require('path').join(dir, f)).mtimeMs })).filter(x => x.t >= since).sort((a, b) => b.t - a.t);
    for (const { f } of files) {
      const text = fs.readFileSync(require('path').join(dir, f), 'utf8');
      const all = [...text.matchAll(/"validation_url":\s*"([^"]+)"/g)];
      if (!all.length) continue;
      const url = JSON.parse('"' + all[all.length - 1][1] + '"');
      const u = new URL(url);
      if (u.protocol === 'https:' && u.hostname === 'accounts.google.com') return u.href;
    }
  } catch {}
  return '';
}
function parseAuthUrl(raw) {
  const text = String(raw).replace(ANSI, '');
  const m = text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>]+/);
  if (!m) return null;
  let u; try { u = new URL(m[0]); } catch { return null; }
  const state = u.searchParams.get('state') || '';
  if (u.searchParams.get('redirect_uri') !== 'https://antigravity.google/oauth-callback' || !/^[A-Za-z0-9_-]{16,200}$/.test(state)) return null;
  return { url: u.href, state };
}

class AntigravityVpsLogin {
  constructor({ manager, keeper, ptyImpl, onComplete = () => {}, pollMs = 2500, roundMs = 58000, finishMs = 90000, ipImpl } = {}) {
    Object.assign(this, { manager, keeper, ptyImpl, onComplete, pollMs, roundMs, finishMs, ipImpl });
    this.flights = new Map();
  }
  service() { return this.manager ||= new VpsLoginEnv({ dataDir: require('./data-dir').getHubDataDir(), keeper: this.keeper }); }
  pending(profileId) { return this.flights.has(profileId); }
  close() {
    for (const entry of this.flights.values()) { try { entry.abort?.(); } catch {} }
    this.flights.clear();
  }
  async validate(profile) {
    if (!profile?.network || !ENV_ID.test(profile.loginEnv || '')) throw new Error('这个 Antigravity 账号还没有绑定专线和远程浏览器，未打开任何浏览器');
    await exitNet.checkedNetwork(profile.network, { ipImpl: this.ipImpl });
    const status = await this.service().status({ fresh: true });
    const bound = status.accounts?.[profile.loginEnv];
    if (!bound || (bound.managed && !bound.provisioned)) throw new Error('VPS 上没有这个账号的远程浏览器（或尚未建好），请刷新账号页');
  }
  // Returns once the consent page is open in the remote browser (or a confirmation is needed).
  async login(row, profile, env, { confirmed = false } = {}) {
    if (this.flights.has(profile.id)) return { message: '授权已在进行中：请在远程窗口里完成 Google 登录并点「继续」' };
    await this.validate(profile);
    const opened = await this.service().open(profile.loginEnv, { url: 'https://accounts.google.com/', confirmed });
    if (opened.needsConfirmation) return opened;
    const entry = {};
    this.flights.set(profile.id, entry);
    entry.done = this.round(row, profile, env, entry).then(
      () => this.closeBrowser(profile.loginEnv),
      e => this.onComplete({ id: row.id, profileId: profile.id, success: false, message: 'Antigravity 授权未完成：' + e.message }))
      .finally(() => { if (this.flights.get(profile.id) === entry) this.flights.delete(profile.id); });
    try { await entry.opened; } catch {}
    return { message: '远程窗口已打开（出口 ' + profile.network.expectedIp + '）：请在里面登录 Google 并点「继续」授权，授权码会自动填回本机。'
      + '一轮限时 60 秒；需要先登录或验证账号、来不及的话，完成后再点一次「授权」即可。' };
  }
  round(row, profile, env, entry) {
    const pty = this.ptyImpl || require('node-pty');
    const command = require('./antigravity-config').resolveCommand(env);
    const runEnv = require('./antigravity-config').backgroundEnv(env);
    const tokenFile = require('./antigravity-subscription-profiles').tokenFile(profile);
    const before = (() => { try { return fs.statSync(tokenFile).mtimeMs; } catch { return 0; } })();
    let markOpened; entry.opened = new Promise(r => { markOpened = r; });
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let out = '', link = null, sent = false, done = false, poll = null;
      const child = pty.spawn(command, ['-p', 'ok', '--print-timeout', '60s'], { name: 'xterm', cols: 3000, rows: 30, cwd: profile.home, env: runEnv });
      const timers = [];
      const finish = (error) => {
        if (done) return; done = true; markOpened();
        for (const t of timers) clearTimeout(t); clearInterval(poll);
        try { child.kill(); } catch {}
        error ? reject(error) : resolve();
      };
      entry.abort = () => finish(new Error('登录已取消'));
      timers.push(setTimeout(() => finish(new Error(link ? (sent ? '授权码已提交但 agy 没有结束' : '60 秒内没有在远程窗口完成授权，可再点一次「授权」') : 'agy 没有给出 Google 授权链接')), this.finishMs));
      child.onData(d => {
        out = (out + d).slice(-20000);
        if (!link && (link = parseAuthUrl(out))) {
          this.service().remoteOf(profile.loginEnv).call('open', { id: profile.loginEnv, url: link.url }, 60000)
            .then(() => { markOpened(); if (!done) startPolling(); }, e => finish(new Error('远程浏览器没打开授权页：' + e.message)));
        }
      });
      child.onExit(({ exitCode }) => {
        const text = out.replace(ANSI, '');
        const changed = (() => { try { return fs.statSync(tokenFile).mtimeMs !== before; } catch { return false; } })();
        if (exitCode === 0 && changed) return finish();
        const why = text.match(/(Eligibility check failed[^\r\n]*|error:[^\r\n]*|Error:[^\r\n]*)/i)?.[1];
        if (/verify your account|VALIDATION_REQUIRED/i.test(text)) {
          const verify = latestValidationUrl(profile.configDir || require('path').join(profile.home, '.gemini', 'antigravity-cli'), started - 5000);
          if (verify) {
            return this.service().remoteOf(profile.loginEnv).call('open', { id: profile.loginEnv, url: verify }, 60000).then(
              () => finish(new Error('Google 要求先验证这个账号：验证页已在远程窗口打开，按提示完成（扫码或自拍）后再点一次「授权」')),
              () => finish(new Error('Google 要求先验证这个账号，但远程窗口没打开验证页；请再点一次「授权」')));
          }
        }
        finish(new Error(why ? why.trim().slice(0, 300) : sent ? 'agy 退出（代码 ' + exitCode + '）' : '60 秒内没有在远程窗口完成授权，可再点一次「授权」'));
      });
      const startPolling = () => {
        const started = Date.now();
        poll = setInterval(async () => {
          if (done || sent || poll.busy) return;
          if (Date.now() - started > this.roundMs) return;
          poll.busy = true;
          try {
            const r = await this.service().remoteOf(profile.loginEnv).call('oauth_code', { id: profile.loginEnv, state: link.state }, 20000);
            if (!done && !sent && r?.code) { sent = true; child.write(r.code + '\r'); }
          } catch {} finally { poll.busy = false; }
        }, this.pollMs);
      };
    });
  }
  async closeBrowser(id) {
    try { await this.service().stop(id, { closeViewer: true }); } catch {}
  }
}
module.exports = { AntigravityVpsLogin, parseAuthUrl, latestValidationUrl };
