'use strict';
//
// 管家给每条专线的本机入口是 https://127.0.0.1:<端口>（私有 CA，Claude / Codex 天天在用）。agy 是 Go 程序、
// Chrome 也只认系统证书库，都不接受这个私有 CA；又不能把私有 CA 装进系统信任（会影响别的软件）。
// 所以 Hub 起一个只监听本机回环的「明文入口」进程：agy 和该账号的专用 Chrome 都走 http://127.0.0.1:<明文端口>，
// 它再按私有 CA 校验后转进管家的 https 入口。只转发，不直连兜底：上游不通就失败。
//
// 进程是隐藏的 Node 子进程（ELECTRON_RUN_AS_NODE），不弹窗、不调用任何命令行程序；Hub 退出后它自己留着也只占回环端口。
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const tls = require('tls');

const MARK = '/__ai_hub_agy_bridge';
const PORT_OFFSET = 1000; // https 入口 17893 → 明文入口 18893（固定映射，写进账号配置后不变）

function configFile(dataDir = require('./data-dir').getHubDataDir()) { return path.join(dataDir, 'agy-exit-bridges.json'); }
function plainPortFor(httpsProxy) {
  const u = new URL(httpsProxy);
  const port = Number(u.port) + PORT_OFFSET;
  if (u.protocol !== 'https:' || u.hostname !== '127.0.0.1' || !Number.isInteger(port) || port > 65535) throw new Error('专线入口地址无效');
  return port;
}
// The keeper route → the entry saved with the account. Pure.
function entryForRoute(route) {
  const n = route?.claudeNetwork;
  if (!route?.id || !net.isIPv4(route.ip || '') || n?.expectedIp !== route.ip || !/^https:\/\/127\.0\.0\.1:\d{1,5}$/.test(n?.proxy || '')
      || !n.proxyCaFile || !path.isAbsolute(n.proxyCaFile)) return null;
  const port = plainPortFor(n.proxy);
  return { exit: route.id, port, upstream: n.proxy, caFile: n.proxyCaFile, expectedIp: route.ip, proxy: 'http://127.0.0.1:' + port };
}

function readEntries(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(d.entries) ? d.entries : []; } catch { return []; }
}
function writeEntry(file, entry) {
  const rows = readEntries(file).filter(e => e.exit !== entry.exit && e.port !== entry.port);
  rows.push({ exit: entry.exit, port: entry.port, upstream: entry.upstream, caFile: entry.caFile, expectedIp: entry.expectedIp });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ entries: rows }, null, 2));
  fs.renameSync(tmp, file);
}

// ---- 明文入口进程 ----
function upstreamSocket(entry, onReady, onError) {
  const u = new URL(entry.upstream);
  let ca;
  try { ca = fs.readFileSync(entry.caFile); } catch { onError(new Error('专线证书不存在')); return null; }
  const s = tls.connect({ host: '127.0.0.1', port: Number(u.port), ca }, () => onReady(s));
  s.on('error', onError);
  return s;
}
function serveEntry(entry) {
  const server = http.createServer((req, res) => {
    if (req.url === MARK) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ exit: entry.exit, upstream: entry.upstream, expectedIp: entry.expectedIp })); }
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400); return res.end('absolute URL required'); }
    if (target.protocol !== 'http:') { res.writeHead(400); return res.end('unsupported'); }
    const up = http.request({ method: req.method, path: target.href, headers: { ...req.headers, connection: 'close' },
      createConnection: (_o, cb) => upstreamSocket(entry, s => cb(null, s), e => cb(e)) }, upRes => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('connect', (req, client, head) => {
    if (!/^[A-Za-z0-9.-]{1,253}:\d{1,5}$/.test(req.url || '')) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    client.on('error', () => {});
    let tunnel = false;
    const refuse = () => { if (tunnel) client.destroy(); else { try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {} } };
    const up = upstreamSocket(entry, s => {
      s.write('CONNECT ' + req.url + ' HTTP/1.1\r\nHost: ' + req.url + '\r\n\r\n');
      let buf = Buffer.alloc(0);
      const onData = d => {
        buf = Buffer.concat([buf, d]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) { if (buf.length > 16384) s.destroy(); return; }
        s.removeListener('data', onData);
        const status = Number(String(buf.subarray(0, end)).split(' ')[1]);
        if (status !== 200) { refuse(); s.destroy(); return; }
        tunnel = true;
        s.setTimeout(10 * 60000); // idle tunnel: 10 minutes
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        const rest = buf.subarray(end + 4);
        if (rest.length) client.write(rest);
        if (head?.length) s.write(head);
        s.pipe(client); client.pipe(s);
      };
      s.on('data', onData);
    }, refuse);
    if (up) {
      up.setTimeout(15000, () => up.destroy()); // handshake + CONNECT answer; replaced by the idle limit once tunnelled
      client.on('close', () => up.destroy());
      // Let pipe flush the tail before closing the client side.
      up.on('end', () => client.end());
      up.on('close', () => { if (!tunnel) refuse(); else setImmediate(() => client.end()); });
    }
  });
  server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch {} });
  return server;
}
function runBridge(file) {
  const live = new Map(); // port -> { key, server }
  const sync = () => {
    const want = new Map();
    for (const e of readEntries(file)) if (Number.isInteger(e.port) && e.port > 1024 && e.port < 65536 && e.upstream && e.caFile) want.set(e.port, e);
    for (const [port, item] of live) if (!want.has(port) || want.get(port).upstream + '|' + want.get(port).caFile !== item.key) { item.server.close(); live.delete(port); }
    for (const [port, e] of want) if (!live.has(port)) {
      const server = serveEntry(e), item = { key: e.upstream + '|' + e.caFile, server };
      live.set(port, item);
      server.once('error', () => { if (live.get(port) === item) live.delete(port); });
      server.listen(port, '127.0.0.1');
    }
  };
  sync();
  // Another copy already serves every port (e.g. one left from before a Hub restart): step aside after 30 s.
  let idle = 0;
  setInterval(() => {
    sync();
    const listening = [...live.values()].some(i => i.server.listening);
    idle = listening ? 0 : idle + 1;
    if (idle >= 15) process.exit(0);
  }, 2000);
}

// ---- Hub 侧：确保明文入口在跑 ----
function probe(port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: MARK, timeout: timeoutMs }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', d => { body += d; if (body.length > 2000) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}
let spawnedAt = 0, current = null;
// in 3 s so running agy sessions get their exit back. A second copy only fails to listen and retries harmlessly.
function spawnBridge(file, { spawn = require('child_process').spawn, env = process.env } = {}) {
  if (current || Date.now() - spawnedAt < 5000) return;
  spawnedAt = Date.now();
  const child = spawn(process.execPath, [__filename, '--serve', file], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'ignore', detached: false });
  current = child;
  child.on('error', () => { if (current === child) current = null; });
  child.on('exit', () => {
    if (current !== child) return;
    current = null;
    setTimeout(async () => {
      const rows = readEntries(file);
      const served = await Promise.all(rows.map(e => probe(e.port).then(r => r?.exit === e.exit)));
      if (served.some(ok => !ok)) spawnBridge(file, { spawn, env });
    }, 3000).unref?.();
  });
  child.unref();
}
// port stopped answering (e.g. the copy that served it belonged to an earlier Hub and has gone). Loopback only.
let watching = null;
function watch(file, spawn) {
  if (watching) return;
  watching = setInterval(async () => {
    const rows = readEntries(file);
    if (!rows.length) return;
    const served = await Promise.all(rows.map(e => probe(e.port).then(r => r?.exit === e.exit)));
    if (served.some(ok => !ok)) spawnBridge(file, { spawn });
  }, 60000);
  watching.unref?.();
}
async function waitReady(entry, waitMs = 6000) {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const r = await probe(entry.port, 800);
    if (r && r.exit === entry.exit && r.upstream === entry.upstream) return true;
    await new Promise(res => setTimeout(res, 300));
  }
  return false;
}
function entryForProxy(proxy, file = configFile()) { return readEntries(file).find(e => 'http://127.0.0.1:' + e.port === proxy) || null; }
async function ensure(entry, { file = configFile(), spawn, waitMs = 6000 } = {}) {
  if (!entry?.port || !entry.upstream) throw new Error('专线明文入口配置无效');
  const ok = r => r && r.exit === entry.exit && r.upstream === entry.upstream && r.expectedIp === entry.expectedIp;
  watch(file, spawn);
  if (ok(await probe(entry.port))) return entry;
  const have = readEntries(file).find(e => e.exit === entry.exit);
  if (!have || have.port !== entry.port || have.upstream !== entry.upstream || have.caFile !== entry.caFile || have.expectedIp !== entry.expectedIp) writeEntry(file, entry);
  const until = Date.now() + waitMs;
  let tried = false;
  while (Date.now() < until) {
    const r = await probe(entry.port, 800);
    if (ok(r)) return entry;
    if (r && !ok(r)) throw new Error('本机端口 ' + entry.port + ' 已被另一条专线占用，未使用');
    if (!tried) { tried = true; spawnBridge(file, { spawn }); }
    await new Promise(res => setTimeout(res, 300));
  }
  throw new Error('专线明文入口没起来（本机端口 ' + entry.port + ' 可能被别的程序占用）');
}
// Same, for the synchronous session launch path: spawn (non-blocking) and let the hidden check child retry.
function ensureSoon(entry, { file = configFile(), spawn } = {}) {
  try {
    const have = readEntries(file).find(e => e.exit === entry.exit);
    if (!have || have.port !== entry.port || have.upstream !== entry.upstream || have.caFile !== entry.caFile || have.expectedIp !== entry.expectedIp) writeEntry(file, entry);
    watch(file, spawn);
    // Synchronously: the caller is about to block on a hidden check child, so an async probe would never run.
    spawnBridge(file, { spawn });
  } catch {}
}

module.exports = { MARK, PORT_OFFSET, configFile, plainPortFor, entryForRoute, entryForProxy, readEntries, writeEntry, serveEntry, probe, ensure, ensureSoon, waitReady };
if (require.main === module && process.argv[2] === '--serve') runBridge(process.argv[3]);
