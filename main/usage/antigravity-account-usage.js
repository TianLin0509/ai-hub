'use strict';
const { resolveCommand, cliEnv, runCli } = require('../../core/antigravity-config');

function parseUsage(payload, observedAt) {
  if (payload?.status !== 'SUCCESS' || payload.num_turns !== 0 || payload.command?.name !== 'usage') throw Error('Antigravity 未返回有效的只读用量结果');
  const groups = (payload.command.data?.groups || []).map(group => {
    const windows = {};
    for (const bucket of group.buckets || []) {
      const fraction = bucket.remaining_fraction;
      if (!['weekly','5h'].includes(bucket.window) || typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      windows[bucket.window === 'weekly' ? 'usage7d' : 'usage5h'] = { pct: (1-fraction)*100, resetsAt: bucket.reset_time || null, observedAt };
    }
    const id = group.buckets?.some(b => String(b.id || '').startsWith('gemini-')) ? 'gemini' : group.buckets?.some(b => String(b.id || '').startsWith('3p-')) ? 'thirdParty' : group.name;
    return { id, label: group.name, ...windows };
  }).filter(g => g.usage5h || g.usage7d);
  if (!groups.length) throw Error('Antigravity 返回的额度窗口为空');
  const tightest = key => groups.map(g=>g[key]).filter(Boolean).sort((a,b)=>b.pct-a.pct)[0] || null;
  return { groups, usage5h: tightest('usage5h'), usage7d: tightest('usage7d'), observedAt, source: 'antigravity-cli' };
}
// agy 失败时把它自己给的原因带出来（去掉链接），不再一律说「请确认已登录且网络可用」。
// 2026-11-21 实测：账号被 Google 要求验证时 agy 输出 Eligibility check failed … not eligible。
function failureReason(result) {
  let text = '';
  try { text = JSON.parse(result.stdout)?.error || ''; } catch {}
  text = String(text || result.stderr || '').replace(/^error:\s*/i, '');
  if (/not eligible|verify your account/i.test(text)) return 'Google 要求验证这个账号（agy：not eligible），请用这个号在浏览器里登录 Google 完成验证';
  // 2026-11-22 实测：开机后专线 / Clash 还没起来，agy 报 proxyconnect … refused，原样截 100 字只剩一串英文调用链。
  const proxy = /proxyconnect tcp: dial tcp ([\d.]+:\d+)/i.exec(text);
  if (proxy) return '连不上出口代理 ' + proxy[1] + '（专线或 Clash 没在运行），这次没查到';
  const line = text.split(/\r?\n/).map(s => s.replace(/https?:\/\/\S+/g, '').trim()).find(Boolean) || '';
  return line ? 'Antigravity 用量查询失败：' + line.slice(0, 100) : 'Antigravity 用量查询失败，请确认官方 CLI 已登录且网络可用';
}
// 出口代理是本机回环端口时，先花 1.5 秒确认它在监听（2026-11-22 实测：开机后 Clash 主核心没起来、7890 无人监听，
// agy 刷新不了登录就转去等交互式登录，每次空等 30 秒超时，报的还是「查询超时」）。
function loopbackProxy(env) {
  // 只认 127.0.0.1：localhost 可能先解析成 ::1，代理只听 IPv4 时会误判成不通、把能用的号拦住。
  const m = /^https?:\/\/127\.0\.0\.1:(\d+)\/?$/i.exec(String(env.HTTPS_PROXY || env.https_proxy || '').trim());
  return m ? { host: '127.0.0.1', port: Number(m[1]) } : null;
}
function probePort({ host, port }, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = require('net').connect({ host, port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
// keepTier：账号归属里带登录身份的号（非我的账号），这次没读到 credits 时沿用上次的档位判断；
// 我的账号登录在系统钥匙串里、换了 Google 号认不出来，照旧当档位未知。
// 只有「代理没在监听」这种没起 agy 的失败，1 分钟后就允许再查（开机时专线晚起来，不用干等 5 分钟）；
// 其他失败（Google 要求验证、超时等）仍按 ttlMs，不因为重试变快而更频繁地访问 Google。
function createAntigravityUsage({ env = process.env, runImpl = runCli, probeImpl, now = Date.now, ttlMs = 300000, retryMs = 60000, initial = null, keepTier = false } = {}) {
  let cached = initial, inflight = null, lastAttempt = -Infinity, proxyDown = false;
  async function query(name) {
    const childEnv = cliEnv(env);
    const result = await runImpl(resolveCommand(childEnv), ['--output-format','json','-p','/'+name], childEnv, 30000);
    if (result.code !== 0) throw Error(failureReason(result));
    let payload;
    try { payload = JSON.parse(result.stdout); } catch { throw Error('Antigravity 用量结果不是有效 JSON'); }
    if (payload?.status !== 'SUCCESS' || payload.num_turns !== 0 || payload.command?.name !== name) throw Error('Antigravity 未返回有效的只读查询结果');
    return payload;
  }
  function refresh(force = false) {
    if (env.CLAUDE_HUB_HOME_DIR && !env.AI_HUB_ANTIGRAVITY_COMMAND) return Promise.reject(Error('隔离 Hub 未配置 Antigravity 用量夹具'));
    if (inflight) return inflight;
    if (!force && now()-lastAttempt < (proxyDown ? Math.min(retryMs, ttlMs) : ttlMs)) return Promise.resolve(cached);
    lastAttempt = now();
    // 注入了假 runImpl 的单测不探真实端口；要测探测时显式传 probeImpl。
    const probe = probeImpl === undefined ? (runImpl === runCli ? probePort : null) : probeImpl;
    let proxy = null;
    try { proxy = probe ? loopbackProxy(cliEnv(env)) : null; } catch { proxy = null; } // 环境不合法时交给 query 照常报错
    const reachable = proxy ? Promise.resolve(probe(proxy)).catch(() => false) : Promise.resolve(true);
    inflight = reachable.then(ok => {
      proxyDown = !ok;
      if (ok) return Promise.allSettled([query('usage'), query('credits')]);
      const reason = Error('出口代理 ' + proxy.host + ':' + proxy.port + ' 没在监听（专线或 Clash 没在运行），这次没查；恢复后约 2 分钟内自动重查');
      return [{ status: 'rejected', reason }, { status: 'rejected', reason }];
    }).then(([usage, credits]) => {
      let next;
      try {
        if (usage.status === 'rejected') throw usage.reason;
        next = parseUsage(usage.value, now());
      } catch (error) {
        next = { ...cached, error: error.message, attemptedAt: now() };
        // 探测时端口还通、agy 拨号时不通（开机代理刚起或刚挂），同样按代理没起来处理，1 分钟后可再查。
        if (/连不上出口代理/.test(error.message)) proxyDown = true;
      }
      const value = credits.status === 'fulfilled' ? credits.value.command.data?.remaining_credits : undefined;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        next.credits = value; next.creditsObservedAt = now(); delete next.creditsError;
      } else {
        next.credits = cached?.credits ?? null; next.creditsObservedAt = cached?.creditsObservedAt || 0;
        next.creditsError = 'credits 余额未刷新' + (next.creditsObservedAt ? '，保留旧值' : '');
      }
      // 档位推测（2026-11-22）：还能升级的号 /credits 会附升级链接，没有就是已在最高档。
      // 这次没读到 credits：带登录身份的号沿用上次判断（keepTier）；我的账号登录在系统钥匙串里、换了 Google 号认不出来，当档位未知。
      if (typeof value === 'number' && Number.isFinite(value)) next.upgradeOffered = !!credits.value.command.data?.upgrade_uri;
      else if (keepTier && typeof cached?.upgradeOffered === 'boolean') next.upgradeOffered = cached.upgradeOffered;
      else delete next.upgradeOffered;
      cached = next; return next;
    }).finally(() => { inflight = null; });
    return inflight;
  }
  return { refresh };
}
module.exports = { createAntigravityUsage, parseUsage, loopbackProxy };
