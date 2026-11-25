'use strict';
// AI 网页的谷歌登录交接（2026-11-06）。
// 谷歌不让「嵌在别的软件里的浏览器」登录账号：Hub 内嵌网页冒充 Chrome 时被拒（10-26），如实报 Electron 也没登进去
// （10-27、10-31 生产登录存储里都没有谷歌登录凭证）。所以谷歌这一步交给一个真 Chrome（登录助手），结果再交回内嵌网页：
// - 用谷歌登录的第三方网站（ChatGPT 等）：内嵌页要跳谷歌授权页时拦下，改在助手里打开。谷歌放行后要跳回网站的回调地址
//   （带一次性授权码）在助手的网络层截下、不让助手发出去，交给内嵌页加载。网站的登录直接建在 Hub 里，不复制任何 Cookie。
// - 谷歌自家网站（Gemini）：没有回调可交，助手登好谷歌后，把谷歌域的 Cookie 写进内嵌页的登录存储。
// 助手：每个身份一份独立资料目录，第一次在里面登录谷歌，以后一般只需点选账号。它带调试端口，但只在网络层拦截跳转、读 Cookie，
// 调试端口用固定端口号，不用随机端口（=0）：Chrome 153 起随机端口会让网页看到 navigator.webdriver=true（被自动化控制），
// 打开谷歌前先在助手自己的过渡页上看一眼这个标记；以后的 Chrome 若连固定端口也标记，就关掉重开并隐藏这个标记。
// 关掉设备绑定（DBSC）：否则谷歌会把登录绑在助手这台浏览器上，同步进内嵌页后很快失效。两个开关名在 Chrome 157 里都存在。
const fs = require('fs');
const net = require('net');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SIGNIN_ORIGIN = 'https://accounts.google.com';
const GOOGLE_OWNED = /(^|\.)(google(\.com|\.co)?\.[a-z]{2,3}|youtube\.com|gstatic\.com|googleusercontent\.com|googleapis\.com|withgoogle\.com|ggpht\.com)$/i;
const NO_DEVICE_BINDING = '--disable-features=EnableBoundSessionCredentials,DeviceBoundSessions';
const HIDE_AUTOMATION = '--disable-blink-features=AutomationControlled';
const PORT_FILE = 'HubDevToolsPort'; // 固定端口时 Chrome 不写 DevToolsActivePort，助手自己记下端口和这次浏览器的编号
const TIMEOUT_MS = 10 * 60 * 1000;
const START_FILE = 'web-login-start.html';
// 过渡页加载完把标题改成下面两种之一：网页能不能看到「被自动化控制」。Hub 只读标题，不在页面里执行任何东西。
const START_TITLE = 'AI Hub · 谷歌登录';
const AUTOMATED_TITLE = 'AI Hub · 谷歌登录（会被谷歌认成自动化）';
const START_HTML = `<!doctype html><meta charset="utf-8"><title>AI Hub · 谷歌登录…</title>
<body style="font:16px 'Microsoft YaHei',system-ui,sans-serif;padding:48px;color:#1f2937;background:#f5f7fa">
<h2 style="margin:0 0 10px">正在打开谷歌登录…</h2>
<p>这是 AI Hub 的谷歌登录助手（真 Chrome）。在这里登录谷歌，完成后会自动交回 Hub 里的网页，这个窗口随后自动关闭。</p>
<p id="hide-note" hidden>如果 Chrome 顶部出现黄色的「不受支持的命令行标记」提示，可以忽略：这是 Hub 为了不让谷歌把这个窗口认成自动化程序加的开关。</p>
<script>document.title = navigator.webdriver ? ${JSON.stringify(AUTOMATED_TITLE)} : ${JSON.stringify(START_TITLE)};
if (location.hash === '#hide') document.getElementById('hide-note').hidden = false;</script></body>`;
const DONE_HTML = `<!doctype html><meta charset="utf-8"><title>已交回 AI Hub</title>
<body style="font:16px 'Microsoft YaHei',system-ui,sans-serif;padding:48px;color:#1f2937;background:#f5f7fa">
<h2 style="margin:0 0 10px">✓ 谷歌登录已交回 AI Hub</h2><p>这个窗口会自动关闭，请回到 Hub 继续。</p></body>`;

// 端到端测试用本地「假谷歌」；只在隔离数据目录下生效，生产实例永远只认 accounts.google.com。
function fixtureOrigin(env = process.env) {
  const v = env.CLAUDE_HUB_DATA_DIR ? String(env.HUB_WEB_LOGIN_FIXTURE_GOOGLE || '') : '';
  return /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(v) ? new URL(v).origin : '';
}
function signInOrigin(env = process.env) { return fixtureOrigin(env) || SIGNIN_ORIGIN; }

// 内嵌页的主框架要去谷歌登录或授权：拦下交给助手。退出登录、退出选项不是登录，照常放行；
// 授权的静默检查（prompt=none）是网站自己探一下有没有登录、马上跳回，拦了会在你打开网页时无故弹出 Chrome，也照常放行。
// passive 不是静默标志：谷歌自家网站的「登录」按钮都带它（11-06 实测 Gemini 是 ServiceLogin?passive=1209600&continue=…），
// 意思是「多久内登过可以免输密码」，照样显示登录页。v1.6.785 把它当静默检查放行，Gemini 的登录就没交给真 Chrome。
function isSignInUrl(url, env = process.env) {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.origin !== signInOrigin(env)) return false;
  if (u.searchParams.get('prompt') === 'none') return false;
  return !/^\/(logout|signoutoptions)/i.test(u.pathname);
}

// 谷歌放行后要跳回的网站地址（授权地址里的 redirect_uri，有时套在 continue 里）。只认 https；本机回环地址给测试夹具用。
function redirectTarget(url, depth = 0) {
  let u; try { u = new URL(url); } catch { return null; }
  const raw = u.searchParams.get('redirect_uri');
  if (raw) {
    try {
      const t = new URL(raw);
      if (t.protocol === 'https:' || (t.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(t.hostname))) return { origin: t.origin, path: t.pathname };
    } catch {}
    return null;
  }
  if (depth >= 3) return null;
  for (const key of ['continue', 'followup', 'next']) {
    const inner = u.searchParams.get(key);
    const t = inner ? redirectTarget(inner, depth + 1) : null;
    if (t) return t;
  }
  return null;
}

// 谷歌自家网站登录完要回到的页面：优先用登录地址里的 continue，指回谷歌登录页本身时改用网站首页。
function continueUrl(url, fallback, env = process.env) {
  try {
    const c = new URL(new URL(url).searchParams.get('continue') || '');
    if (/^https?:$/.test(c.protocol) && c.origin !== signInOrigin(env) && c.origin === new URL(fallback).origin) return c.href;
  } catch {}
  return fallback;
}

function header(headers, name) {
  const h = (headers || []).find(x => String(x.name).toLowerCase() === name);
  return h ? String(h.value) : '';
}
function samePath(a, b) { return a === b || a.replace(/\/+$/, '') === b.replace(/\/+$/, ''); }
function isCallback(u, target, env) {
  if (target) return u.origin === target.origin && samePath(u.pathname, target.path);
  // 没解析出回调地址：离开谷歌之后的第一个网页就是回调。
  return /^https?:$/.test(u.protocol) && u.origin !== signInOrigin(env) && !GOOGLE_OWNED.test(u.hostname);
}

// 助手里每个网页请求怎么处理：'continue' 照常放行；'done' 回到了谷歌自家网站（Cookie 模式下登录完成）；
// { capture } 是跳回网站的回调，截下交回 Hub，不让助手发出去（授权码只能用一次）。
function decide({ mode, target, doneOrigin, env = process.env }, request, response) {
  let u; try { u = new URL(request.url); } catch { return 'continue'; }
  if (mode === 'oauth') {
    if (response) {
      // 谷歌用 3xx 跳回网站：在这一步就截下 Location，助手不会跟过去。
      if (!(response.status >= 300 && response.status < 400)) return 'continue';
      const loc = header(response.headers, 'location');
      let next; try { next = new URL(loc, request.url); } catch { return 'continue'; }
      return loc && isCallback(next, target, env) ? { capture: next.href, method: 'GET' } : 'continue';
    }
    if (!isCallback(u, target, env)) return 'continue';
    const method = String(request.method || 'GET').toUpperCase();
    return { capture: u.href, method, postData: method === 'POST' ? postBody(request) : '', contentType: header(Object.entries(request.headers || {}).map(([name, value]) => ({ name, value })), 'content-type') };
  }
  if (response) return 'continue';
  return u.origin === doneOrigin ? 'done' : 'continue';
}
function postBody(request) {
  if (typeof request.postData === 'string') return request.postData;
  if (Array.isArray(request.postDataEntries)) return request.postDataEntries.map(e => Buffer.from(e.bytes || '', 'base64').toString('utf8')).join('');
  return '';
}

// 只同步网站所在的那个域（Gemini → google.com 及其子域）。分区 Cookie 是给别的网站嵌入用的，内嵌页用不上。
function registrable(host) {
  const h = String(host || '').toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h === 'localhost') return h;
  return h.split('.').slice(-2).join('.');
}
function loginCookies(all, siteHost) {
  const base = registrable(siteHost);
  return (all || []).filter(c => {
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    return !c.partitionKey && (d === base || d.endsWith('.' + base));
  });
}
function hasGoogleLogin(cookies) { return (cookies || []).some(c => /^(SID|__Secure-1PSID)$/.test(c.name)); }

// 浏览器调试协议里的 Cookie → Electron 的写入参数。不带点的域是只认本主机的 Cookie，不能写 domain（__Host- 前缀也要求如此）。
function electronCookie(c) {
  if (!c || !c.name || c.partitionKey) return null;
  const host = String(c.domain || '').replace(/^\./, '');
  if (!host) return null;
  const local = /^(127\.0\.0\.1|localhost)$/.test(host);
  const out = { url: `${c.secure || !local ? 'https' : 'http'}://${host}${c.path || '/'}`, name: c.name, value: String(c.value ?? ''), path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
  if (String(c.domain).startsWith('.') && !c.name.startsWith('__Host-')) out.domain = c.domain;
  if (!c.session && Number(c.expires) > 0) out.expirationDate = Number(c.expires);
  const sameSite = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }[c.sameSite];
  if (sameSite) out.sameSite = sameSite;
  return out;
}

function helperArgs({ profile, proxyArgs = [], headless = false, startUrl, port, hideAutomation = false, extraArgs = [] }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('登录助手的调试端口无效：' + port);
  return [
    ...proxyArgs,
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + port,
    '--no-first-run', '--no-default-browser-check',
    NO_DEVICE_BINDING,
    ...(hideAutomation ? [HIDE_AUTOMATION] : []),
    ...(headless ? ['--headless=new'] : ['--new-window', '--window-size=1080,860']),
    ...extraArgs,
    startUrl,
  ];
}

// 过渡页报出网页能看到「被自动化控制」时怎么办（automated 为 null 表示没读到，照常继续）：
// 复用的是旧窗口（可能是旧版本按随机端口开的）→ 关掉按正常方式重开；新开的也被标记（以后的 Chrome 改了规则）→ 关掉、隐藏标记重开；
// 隐藏后仍被标记 → 放弃并说明，不让你白输一遍账号再被谷歌拒。
function automationVerdict({ automated, launched, hidden }) {
  if (!automated) return 'go';
  if (!launched) return 'relaunch';
  return hidden ? 'fail' : 'relaunch-hidden';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
// Chrome 运行时独占资料目录里的 lockfile（退出时自动删掉）；删得掉说明是异常退出留下的，不算占用。
function profileBusy(profile) {
  const f = path.join(profile, 'lockfile');
  if (!fs.existsSync(f)) return false;
  try { fs.unlinkSync(f); return false; } catch { return true; }
}

// 最小的调试协议客户端：命令按 id 回复，事件（含扁平会话里的）交给订阅者。
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = new Set(); this.closed = false;
    ws.on('message', bytes => {
      let m; try { m = JSON.parse(bytes); } catch { return; }
      if (m.id) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result || {});
        return;
      }
      for (const fn of this.listeners) { try { fn(m); } catch {} }
    });
    const fail = () => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('登录助手浏览器已断开')); }
      this.pending.clear();
      for (const fn of this.listeners) { try { fn({ method: 'Hub.closed' }); } catch {} }
    };
    ws.on('close', fail); ws.on('error', fail);
  }
  static connect(url) {
    const u = new URL(url);
    if (u.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('登录助手地址无效');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(u.href, { perMessageDeflate: false });
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('连不上登录助手浏览器')); }, 8000);
      ws.once('open', () => { clearTimeout(timer); resolve(new Cdp(ws)); });
      ws.once('error', e => { clearTimeout(timer); reject(e); });
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('登录助手浏览器已断开')); return; }
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('登录助手没有响应：' + method)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function createGoogleLogin({ dataDir, getProxy = () => null, chromeExecutable, env = process.env, logger = console, spawnImpl = spawn } = {}) {
  const root = path.join(dataDir, 'web-login-chrome');
  const jobs = new Map(); // 身份 → 进行中的交接
  const closing = new Map(); // 身份 → 上一个助手正在退出（同一资料目录要等它完全退出才能再开，否则会接到正在关闭的那个）
  const headless = () => !!env.CLAUDE_HUB_DATA_DIR && env.HUB_WEB_LOGIN_HEADLESS === '1';
  // 端到端测试用：隔离数据目录下给助手多加开关（如 --enable-automation，模拟以后的 Chrome 把助手标成自动化），生产实例不认。
  const testArgs = () => (env.CLAUDE_HUB_DATA_DIR ? String(env.HUB_WEB_LOGIN_TEST_ARGS || '').split(/\s+/).filter(a => /^--[a-z][a-z0-9-]*(=[\w.,:-]*)?$/i.test(a)) : []);

  // 还在运行的助手：端口文件两行，端口和这次浏览器的编号；编号对不上说明端口已换了主人，不认。
  // 也认旧版本按随机端口开的助手（DevToolsActivePort），接手后过渡页会报出标记，再关掉重开。
  async function endpoint(profile) {
    for (const name of [PORT_FILE, 'DevToolsActivePort']) {
      let lines;
      try { lines = fs.readFileSync(path.join(profile, name), 'utf8').trim().split(/\r?\n/); } catch { continue; }
      if (!lines[1]) continue;
      const ep = await probe(Number(lines[0]), lines[1].trim());
      if (ep) return ep;
    }
    return null;
  }
  async function probe(port, wsPath = '') {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return null;
      const p = new URL((await r.json()).webSocketDebuggerUrl).pathname;
      if (wsPath && p !== wsPath) return null;
      return { port, ws: `ws://127.0.0.1:${port}${p}` };
    } catch { return null; }
  }
  function startPage() {
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, START_FILE);
    try { if (fs.readFileSync(file, 'utf8') === START_HTML) return pathToFileURL(file).href; } catch {}
    fs.writeFileSync(file, START_HTML, 'utf8');
    return pathToFileURL(file).href;
  }
  function proxyArgs() {
    try { return getProxy()?.args || []; } catch (e) { logger.warn?.('[web-google-login] Hub 代理无效，助手改跟随系统网络：', e.message); return []; }
  }

  async function launch(profile, startUrl, hideAutomation) {
    const running = await endpoint(profile);
    if (running) return { ep: running, launched: false };
    // 资料目录被一个连不上的 Chrome 占着（正在退出，或是你手动开的）：等一会儿，还占着就说明原因，不硬开。
    const t1 = Date.now();
    while (profileBusy(profile) && Date.now() - t1 < 6000) await sleep(300);
    if (profileBusy(profile)) throw new Error('这个身份的登录 Chrome 还开着，请先关掉那个 Chrome 窗口再试');
    for (const f of [PORT_FILE, 'DevToolsActivePort']) { try { fs.unlinkSync(path.join(profile, f)); } catch {} }
    const port = await freePort();
    const exe = chromeExecutable(env);
    let failed = null;
    const child = spawnImpl(exe, helperArgs({ profile, proxyArgs: proxyArgs(), headless: headless(), startUrl, port, hideAutomation, extraArgs: testArgs() }), { detached: true, stdio: 'ignore', windowsHide: headless() });
    child.on?.('error', e => { failed = e; });
    child.unref?.();
    const t0 = Date.now();
    for (;;) {
      if (failed) throw new Error('真 Chrome 启动失败：' + failed.message);
      const ep = await probe(port);
      if (ep) {
        fs.writeFileSync(path.join(profile, PORT_FILE), `${port}\n${new URL(ep.ws).pathname}\n`);
        return { ep, launched: true };
      }
      if (Date.now() - t0 > 25000) throw new Error('真 Chrome 25 秒内没有启动完成');
      await sleep(250);
    }
  }
  // 关掉助手并等它完全退出（资料目录解锁），同一身份才能再开。
  async function shutdown(cdp, profile) {
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
    const t0 = Date.now();
    while (Date.now() - t0 < 10000 && (profileBusy(profile) || await endpoint(profile))) await sleep(200);
  }
  // 读过渡页的标题：true 网页能看到「被自动化控制」，false 看不到，null 是 5 秒内没读到（照常继续）。
  async function automationVisible(cdp, targetId) {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const info = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.targetId === targetId);
      if (info?.title === AUTOMATED_TITLE) return true;
      if (info?.title === START_TITLE) return false;
      await sleep(150);
    }
    return null;
  }

  async function drive(job, { identity, mode, url, siteUrl }) {
    const profile = path.join(root, identity);
    await closing.get(identity)?.catch(() => {});
    fs.mkdirSync(profile, { recursive: true });
    const startUrl = startPage();
    let cdp = null, targetId = null, sessionId = null;
    for (let hidden = false, round = 0; ; round++) {
      const pageUrl = hidden ? startUrl + '#hide' : startUrl;
      const { ep, launched } = await launch(profile, pageUrl, hidden);
      cdp = await Cdp.connect(ep.ws);
      targetId = null;
      try {
        await cdp.send('Target.setDiscoverTargets', { discover: true });
        if (launched) {
          const t0 = Date.now();
          while (!targetId && Date.now() - t0 < 10000) {
            const { targetInfos } = await cdp.send('Target.getTargets');
            targetId = targetInfos.find(t => t.type === 'page' && t.url.startsWith(startUrl))?.targetId || null;
            if (!targetId) await sleep(200);
          }
        }
        if (!targetId) targetId = (await cdp.send('Target.createTarget', { url: pageUrl, newWindow: !headless() })).targetId;
        // 打开谷歌之前先看过渡页报的标记：网页能看到「被自动化控制」，谷歌会在输完邮箱时拒绝登录。
        const automated = await automationVisible(cdp, targetId);
        if (automated === null) logger.warn?.(`[web-google-login] ${identity} 没读到过渡页的检查结果，照常继续`);
        const verdict = automationVerdict({ automated, launched, hidden });
        if (verdict !== 'go') {
          await shutdown(cdp, profile);
          if (verdict === 'fail' || round >= 2) throw new Error('这个 Chrome 会被谷歌认成自动化程序，登录会被拒（Chrome 的规则可能又变了），请把这条提示告诉开发者');
          logger.log?.(`[web-google-login] ${identity} 网页能看到「被自动化控制」，谷歌会拒绝登录：${verdict === 'relaunch' ? '关掉旧的助手窗口重开' : '隐藏这个标记重开'}`);
          if (verdict === 'relaunch-hidden') hidden = true;
          continue;
        }
        ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
        const patterns = [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }];
        if (mode === 'oauth') patterns.push({ urlPattern: signInOrigin(env) + '/*', resourceType: 'Document', requestStage: 'Response' });
        await cdp.send('Fetch.enable', { patterns }, sessionId);
      } catch (e) { cdp.close(); throw e; }
      break;
    }

    const ctx = { mode, target: mode === 'oauth' ? redirectTarget(url) : null, doneOrigin: new URL(siteUrl).origin, env };
    const siteHost = new URL(siteUrl).hostname;
    logger.log?.(`[web-google-login] ${identity} 开始（${mode === 'oauth' ? '授权回调' : '同步谷歌登录'}），回调：${ctx.target ? ctx.target.origin + ctx.target.path : '离开谷歌的第一个网页'}`);

    return await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error('10 分钟内没有完成，已取消')), TIMEOUT_MS);
      const off = cdp.on(m => { void handle(m).catch(e => finish(e)); });
      job.cancel = reason => finish(new Error(reason || '已取消'));
      job.front = () => { if (sessionId) void cdp.send('Page.bringToFront', {}, sessionId).catch(() => {}); };
      // 先挂好拦截再打开谷歌页：已登录谷歌时它可能立刻跳回网站，不能漏掉那一跳。
      void (async () => {
        try {
          const nav = await cdp.send('Page.navigate', { url }, sessionId);
          if (nav.errorText && !/ERR_ABORTED/.test(nav.errorText)) finish(new Error('真 Chrome 打不开谷歌登录页（' + nav.errorText + '），请检查网络或 Hub 代理'));
          else if (!headless()) job.front();
        } catch (e) { finish(e); }
      })();
      async function handle(m) {
        if (settled) return;
        if (m.method === 'Hub.closed') return finish(new Error('登录窗口已关闭'));
        if (m.method === 'Target.targetDestroyed' && m.params?.targetId === targetId) return finish(new Error('登录窗口已关闭'));
        if (m.method === 'Target.detachedFromTarget' && m.params?.sessionId === sessionId) return finish(new Error('登录窗口已关闭'));
        if (m.method === 'Target.targetInfoChanged' && mode === 'cookies' && m.params?.targetInfo?.targetId === targetId) {
          let origin = ''; try { origin = new URL(m.params.targetInfo.url).origin; } catch {}
          if (origin === ctx.doneOrigin) return complete();
          return;
        }
        if (m.method !== 'Fetch.requestPaused' || m.sessionId !== sessionId) return;
        const p = m.params;
        const response = p.responseStatusCode !== undefined || p.responseErrorReason ? { status: p.responseStatusCode || 0, headers: p.responseHeaders } : null;
        const verdict = decide(ctx, p.request, response);
        if (verdict === 'continue') { await cdp.send('Fetch.continueRequest', { requestId: p.requestId }, sessionId).catch(() => {}); return; }
        await cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(DONE_HTML).toString('base64') }, sessionId).catch(() => {});
        if (verdict === 'done') return complete();
        finish(null, { callbackUrl: verdict.capture, method: verdict.method, postData: verdict.postData || '', contentType: verdict.contentType || '' });
      }
      async function complete() {
        if (settled) return;
        const { cookies } = await cdp.send('Storage.getCookies', {});
        const picked = loginCookies(cookies, siteHost);
        if (!hasGoogleLogin(picked)) return finish(new Error('没有检测到谷歌登录，请在 Chrome 窗口里完成登录'));
        finish(null, { cookies: picked, continueUrl: continueUrl(url, siteUrl, env) });
      }
      function finish(err, value) {
        if (settled) return;
        settled = true; clearTimeout(timer); off();
        job.cancel = () => {}; job.front = () => {};
        // 交回或取消后都关掉助手：Cookie 落盘，下次一般免输密码；不留孤儿窗口。等它完全退出再允许同一身份开下一次。
        const exit = (async () => {
          if (!err && !headless()) await sleep(700);
          await shutdown(cdp, profile);
        })();
        closing.set(identity, exit);
        void exit.finally(() => { if (closing.get(identity) === exit) closing.delete(identity); });
        logger.log?.(`[web-google-login] ${identity} ${err ? '未完成：' + err.message : '完成'}`);
        if (err) reject(err); else resolve(value);
      }
    });
  }

  async function run(request) {
    const { identity, mode } = request || {};
    if (!/^(main|alt)$/.test(identity || '')) throw new Error('未知的身份');
    if (!['oauth', 'cookies'].includes(mode)) throw new Error('未知的登录方式');
    const busy = jobs.get(identity);
    if (busy) { busy.front(); throw Object.assign(new Error('这个身份的谷歌登录窗口已经开着，请先在那个 Chrome 窗口里完成，或关掉它再试'), { code: 'WEB_LOGIN_BUSY' }); }
    const job = { cancel: () => {}, front: () => {} };
    jobs.set(identity, job);
    try { return await drive(job, request); } finally { jobs.delete(identity); }
  }
  function cancel(identity, reason) { jobs.get(identity)?.cancel(reason); }
  function dispose() { for (const identity of [...jobs.keys()]) cancel(identity, 'Hub 正在关闭'); }
  return { run, cancel, dispose, busy: identity => jobs.has(identity), isSignInUrl: url => isSignInUrl(url, env), root };
}

module.exports = { createGoogleLogin, isSignInUrl, redirectTarget, continueUrl, decide, loginCookies, hasGoogleLogin, electronCookie, helperArgs, automationVerdict, signInOrigin, GOOGLE_OWNED, NO_DEVICE_BINDING, HIDE_AUTOMATION, PORT_FILE, START_HTML, START_TITLE, AUTOMATED_TITLE };
