'use strict';
// 即从本机经这条线路到目标往返一次。四条线路口径一致（共享线路的本机代理会立刻应答隧道，只有这一段可比）。
//   自动：测 Google 的 generate_204（不碰 Anthropic），右侧看板在读时才触发，同一线路 5 分钟最多一次。
//   手动：悬停卡「测到 Claude」测 api.anthropic.com，不带任何账号信息，3 次取中位数，同一线路 1 分钟冷却。
// 实测（11-01）：共享 223–236ms，专线 212–234 / 307–522 / 325–1245ms。
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const { exitList } = require('./claude-exit-check');

const TARGETS = {
  google: { host: 'www.gstatic.com', path: '/generate_204' },
  claude: { host: 'api.anthropic.com', path: '/' },
};
const AUTO_EVERY_MS = 5 * 60_000;
const MANUAL_COOLDOWN_MS = 60_000;
const KEEP_SAMPLES = 3;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// 一次计时。只走显式代理隧道，失败不回落其他出口；返回毫秒或抛错。
function timeFirstByte({ proxy, proxyCaFile }, target, { timeoutMs = 10_000, now = () => Date.now() } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(proxy); } catch { return reject(new Error('bad proxy')); }
    const plain = u.protocol === 'http:' && LOOPBACK.has(u.hostname);
    if (!plain && (u.protocol !== 'https:' || !proxyCaFile)) return reject(new Error('proxy must be loopback http or https with CA'));
    let sock, secure, done = false, tlsAt = 0;
    const finish = (err, ms) => {
      if (done) return; done = true; clearTimeout(timer);
      try { secure?.destroy(); } catch {} try { sock?.destroy(); } catch {}
      err ? reject(err) : resolve(ms);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    sock = plain ? net.connect({ host: u.hostname, port: Number(u.port) })
      : tls.connect({ host: u.hostname, port: Number(u.port), ca: fs.readFileSync(proxyCaFile), rejectUnauthorized: true,
        checkServerIdentity: (_n, cert) => tls.checkServerIdentity(u.hostname, cert) });
    sock.on('error', finish);
    sock.once(plain ? 'connect' : 'secureConnect', () => sock.write(`CONNECT ${target.host}:443 HTTP/1.1\r\nHost: ${target.host}:443\r\n\r\n`));
    let buf = Buffer.alloc(0);
    const onData = chunk => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > 16384) finish(new Error('proxy header')); return; }
      sock.removeListener('data', onData);
      if (!/^HTTP\/1\.[01] 200\b/.test(buf.subarray(0, end).toString('ascii'))) return finish(new Error('proxy refused'));
      secure = tls.connect({ socket: sock, servername: target.host, rejectUnauthorized: true });
      secure.on('error', finish);
      secure.once('secureConnect', () => {
        tlsAt = now();
        secure.write(`HEAD ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`);
        secure.once('data', () => finish(null, now() - tlsAt));
      });
    };
    sock.on('data', onData);
  });
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

// 每条线路的读数。键是出口 IP（共享线路用共享出口 IP），看板按账号的出口 IP 取。
function createRouteLatency({ routes, measure = timeFirstByte, now = () => Date.now(), autoEveryMs = AUTO_EVERY_MS, cooldownMs = MANUAL_COOLDOWN_MS } = {}) {
  const state = new Map();   // ip -> { google: {samples, at, error}, claude: {ms, samples, at, error}, running }
  let lastAuto = -Infinity, autoRunning = null;
  const entry = ip => { if (!state.has(ip)) state.set(ip, { google: { samples: [] }, claude: {} }); return state.get(ip); };

  async function autoProbe() {
    const list = routes();
    await Promise.all(list.map(async r => {
      const e = entry(r.ip);
      try {
        const ms = await measure(r, TARGETS.google);
        e.google = { samples: [...e.google.samples, ms].slice(-KEEP_SAMPLES), at: now(), error: '' };
      } catch (err) { e.google = { ...e.google, at: now(), error: String(err?.message || err) }; }
    }));
  }
  function snapshot() {
    const out = {};
    for (const [ip, e] of state) {
      out[ip] = {
        google: e.google.samples.length || e.google.error ? { ms: median(e.google.samples), at: e.google.at || 0, error: e.google.error || '' } : null,
        claude: e.claude.at ? { ms: e.claude.ms ?? null, samples: e.claude.samples || [], at: e.claude.at, error: e.claude.error || '' } : null,
      };
    }
    return out;
  }
  return {
    // 看板每次读时调用：到点就在后台测一轮 Google，立即返回现有读数，不等待。
    get() {
      if (!autoRunning && now() - lastAuto >= autoEveryMs) {
        lastAuto = now();
        autoRunning = autoProbe().finally(() => { autoRunning = null; });
      }
      return snapshot();
    },
    async probeClaude(ip, rounds = 3) {
      const r = routes().find(x => x.ip === ip);
      if (!r) throw new Error('找不到这条线路');
      const e = entry(ip);
      if (e.claude.at && now() - e.claude.at < cooldownMs) return { ...snapshot()[ip].claude, cooldown: true };
      if (e.running) return e.running;
      e.running = (async () => {
        const samples = []; let error = '';
        for (let i = 0; i < rounds; i++) {
          try { samples.push(await measure(r, TARGETS.claude)); } catch (err) { error = String(err?.message || err); }
        }
        e.claude = { ms: median(samples), samples, at: now(), error: samples.length ? '' : error };
        return snapshot()[ip].claude;
      })().finally(() => { e.running = null; });
      return e.running;
    },
    _autoDone: () => autoRunning || Promise.resolve(),
  };
}

// 线路清单：复用「检查出口」的出口列表（共享 + 每个专线 IP），只留有代理可走的。
function routesFrom({ profiles, sharedProxy, sharedIp }) {
  return exitList({ profiles, sharedProxy, sharedIp })
    .filter(e => e.proxy && (e.shared ? sharedIp : e.expected))
    .map(e => ({ ip: e.shared ? sharedIp : e.expected, proxy: e.proxy, proxyCaFile: e.proxyCaFile, shared: !!e.shared }));
}

module.exports = { timeFirstByte, createRouteLatency, routesFrom, median, TARGETS, AUTO_EVERY_MS, MANUAL_COOLDOWN_MS };
