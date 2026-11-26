'use strict';
// agy 跑在隐藏伪终端里、走账号绑定的专线；打开前、授权后各核对一次出口 IP，授权后记录出口与时间。
const fs = require('fs');
const path = require('path');
const exitNet = require('./antigravity-exit');
const { parseAuthUrl } = require('./antigravity-vps-login');
const { recordAuth } = require('./antigravity-local-login');

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const CODE = /^[\w./~-]{10,2048}$/;
const inFlight = new Set();
function isPending(profileId) { return inFlight.has(profileId); }

class AntigravityPasteLogin {
  constructor({ dataDir, onComplete = () => {}, ptyImpl, ipImpl, linkMs = 25000, finishMs = 75000 } = {}) {
    Object.assign(this, { onComplete, ptyImpl, ipImpl, linkMs, finishMs });
    this.dataDir = dataDir || require('./data-dir').getHubDataDir();
    this.flights = new Map();
  }
  pending(profileId) { return this.flights.has(profileId); }
  close() { for (const [id, f] of this.flights) { try { f.abort(); } catch {} inFlight.delete(id); } this.flights.clear(); }
  // Starts one agy round and returns the consent link for the person to open in their own browser.
  async start(row, profile, env) {
    if (!profile?.network) throw new Error('这个 Antigravity 账号没有绑定专线');
    const running = this.flights.get(profile.id);
    if (running?.link) return this.ticket(profile, running);
    if (running) throw new Error('授权链接正在生成，请稍候');
    const before = await exitNet.checkedNetwork(profile.network, { force: true, ipImpl: this.ipImpl });
    const flight = { ip: before.ip };
    this.flights.set(profile.id, flight); inFlight.add(profile.id);
    const linkReady = new Promise((resolve, reject) => { flight.gotLink = resolve; flight.noLink = reject; });
    let rounding;
    try { rounding = this.round(row, profile, env, flight); }
    catch (e) { this.flights.delete(profile.id); inFlight.delete(profile.id); throw new Error('agy 没能启动：' + (e.message || '未知原因')); }
    flight.done = rounding.then(async () => {
      let ip = '', why = '';
      try { ip = (await exitNet.checkedNetwork(profile.network, { force: true, ipImpl: this.ipImpl })).ip; } catch (e) { why = e.message || '未知原因'; }
      if (/IP 不符/.test(why)) return this.onComplete({ id: row.id, profileId: profile.id, success: false,
        message: 'Antigravity 授权后复查出口不一致：' + why + '；请先检查专线，暂勿使用这个账号' });
      try { recordAuth(this.dataDir, profile.id, { exit: profile.exit, ip: ip || before.ip, expectedIp: profile.network.expectedIp, at: new Date().toISOString(), via: '本人 Chrome', ...(ip ? {} : { verifiedAfter: false }) }); } catch {}
      this.onComplete({ id: row.id, profileId: profile.id, success: true,
        message: ip ? 'Antigravity 授权完成（授权前后出口都是 ' + ip + '）' : 'Antigravity 授权完成（授权前出口 ' + before.ip + '；授权后未能复查：' + why + '）' });
    }, e => this.onComplete({ id: row.id, profileId: profile.id, success: false, message: 'Antigravity 授权未完成：' + e.message }))
      .finally(() => { if (this.flights.get(profile.id) === flight) { this.flights.delete(profile.id); inFlight.delete(profile.id); } });
    await linkReady;
    return this.ticket(profile, flight);
  }
  ticket(profile, flight) {
    return { agyPaste: true, profileId: profile.id, url: flight.link.url, expiresAt: flight.expiresAt, ip: flight.ip,
      message: '授权链接已生成（出口 ' + flight.ip + '，与专线一致）：复制到你装好专线扩展的 Chrome 资料里打开，点「继续」后把页面上的授权码粘回这里。60 秒内有效。' };
  }
  submit(profileId, code) {
    const flight = this.flights.get(profileId);
    if (!flight?.link) throw new Error('这一轮授权已结束，请重新点「授权」拿新链接');
    const value = String(code || '').trim();
    if (!CODE.test(value)) throw new Error('授权码格式不对：请复制回调页上完整的授权码');
    if (flight.sent) throw new Error('授权码已提交，正在等确认');
    flight.sent = true;
    try { flight.child.write(value + '\r'); } catch { flight.sent = false; throw new Error('这一轮授权已结束，请重新点「授权」拿新链接'); }
    flight.secret = value;
    return { message: '授权码已提交，正在等 agy 确认（几秒）' };
  }
  round(row, profile, env, flight) {
    const pty = this.ptyImpl || require('node-pty');
    const cfg = require('./antigravity-config');
    const tokenFile = require('./antigravity-subscription-profiles').tokenFile(profile);
    const mtime = () => { try { return fs.statSync(tokenFile).mtimeMs; } catch { return 0; } };
    const before = mtime();
    return new Promise((resolve, reject) => {
      let out = '', done = false, child;
      try { child = pty.spawn(cfg.resolveCommand(env), ['-p', 'ok', '--print-timeout', '60s'], { name: 'xterm', cols: 3000, rows: 30, cwd: profile.home, env: cfg.backgroundEnv(env) }); }
      catch (e) { const err = new Error('agy 没能启动：' + (e.message || '未知原因')); flight.noLink(err); return reject(err); }
      flight.child = child;
      const timers = [];
      const finish = error => {
        if (done) return; done = true;
        for (const t of timers) clearTimeout(t);
        try { child.kill(); } catch {}
        if (!flight.link) flight.noLink(error || new Error('agy 没有给出授权链接'));
        error ? reject(error) : resolve();
      };
      flight.abort = () => finish(new Error('授权已取消'));
      timers.push(setTimeout(() => { if (!flight.link) finish(new Error('agy 没有给出 Google 授权链接')); }, this.linkMs));
      timers.push(setTimeout(() => finish(new Error(flight.sent ? '授权码已提交但 agy 没有结束' : '60 秒内没有粘回授权码，请重新点「授权」拿新链接')), this.finishMs));
      child.onData(d => {
        out = (out + d).slice(-20000);
        if (!flight.link) {
          const link = parseAuthUrl(out);
          if (link) { flight.link = link; flight.expiresAt = Date.now() + 58000; flight.gotLink(); }
        }
      });
      child.onExit(({ exitCode }) => {
        const text = out.replace(ANSI, '');
        if (exitCode === 0 && (mtime() !== before || (!flight.link && before))) return finish();
        if (/verify your account|VALIDATION_REQUIRED/i.test(text)) return finish(new Error('Google 要求先验证这个账号：请在你的 Chrome 里打开 Google 账号页按提示完成验证，再重新授权'));
        if (!flight.sent && /timed out|interrupted/i.test(text)) return finish(new Error('60 秒内没有粘回授权码，请重新点「授权」拿新链接'));
        const why = text.match(/(Eligibility check failed[^\r\n]*|error:[^\r\n]*|Error:[^\r\n]*)/i)?.[1];
        // The pasted code is echoed by the terminal; never let it reach a message.
        const safe = why && flight.secret ? why.split(flight.secret).join('…') : why;
        finish(new Error(safe ? safe.trim().slice(0, 300) : 'agy 退出（代码 ' + exitCode + '）'));
      });
    });
  }
}
module.exports = { AntigravityPasteLogin, isPending, CODE };
