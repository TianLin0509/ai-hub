'use strict';
// 「个人」页的主进程接线（2026-11-12）：在各功能入口记一次使用、认人、回溯历史、把升级和成就告诉页面与桌宠。
// 计分不改各功能自己的代码：installProfileTap 在注册 IPC 时给下表里的入口套一层，用户真的点到那个功能才记。
const fs = require('node:fs');
const path = require('node:path');

// IPC 入口 → 记什么。feature 记「用过这个功能」（也可以是按请求判断的函数，这时 ids 列出它可能记的功能）；kind 记消息 / 新建会话。
// gap：页面打开时会反复调用的入口（读状态、边打字边搜），同一功能 5 分钟内只算一次，不让次数虚高。
const GAP = 5 * 60000;
const TAPS = {
  'session:send-prompt': { kind: 'prompt', when: (_req, res) => !(res && res.notSent) },
  'create-session': { kind: 'session' },
  'assistant:ask': { feature: 'assistant' },
  'assistant:send': { feature: 'assistant' },
  'team:decide': { feature: 'team', when: req => !!req && req.approve === true },
  // 写作也是用 create-meeting 建的群，靠 scene 区分
  'create-meeting': { feature: req => (req && req.scene === 'writing' ? 'writing' : 'roundtable'), ids: ['writing', 'roundtable'] },
  'writing:article-create': { feature: 'writing' },
  'web-roundtable:ask': { feature: 'webai' },
  'web-roundtable:create': { feature: 'webai' },
  'web-sessions:create': { feature: 'webai' },
  'memory:start-dream': { feature: 'memory' },
  'memory:merge-island': { feature: 'memory' },
  'btw-ask:ask': { feature: 'aside' },
  'study:ask': { feature: 'study' },
  'study:run-now': { feature: 'study' },
  'wireless:act': { feature: 'wireless' },
  'relay-tool:push': { feature: 'relay' },
  'relay-tool:pull-and-send': { feature: 'relay' },
  // 这个入口失败时回 { error }，不回 ok:false
  'sync-path-to-company': { feature: 'relay', when: (_req, res) => !(res && res.error) },
  'hub-rules:save-mine': { feature: 'rules' },
  'execute-disk-release': { feature: 'disk' },
  'get-disk-usage-analysis': { feature: 'disk', gap: GAP },
};
const ruleIds = rule => (rule.kind ? ['chat'] : typeof rule.feature === 'function' ? rule.ids || [] : [rule.feature]);

function installProfileTap(ipcMain, { now = () => Date.now() } = {}) {
  const tap = { profile: null, seen: new Set() };
  const lastAt = new Map();
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => {
    const rule = TAPS[channel];
    if (!rule) return handle(channel, handler);
    for (const id of ruleIds(rule)) { tap.seen.add(id); tap.profile?.registerFeature(id); }
    // 原处理照常执行，返回值和异常原样交回；它成功了（没抛错、没回 ok:false、满足这个入口自己的条件）才记一次。
    const note = (result, args) => {
      try {
        if (result && result.ok === false) return;
        if (rule.when && !rule.when(args[0], result)) return;
        if (rule.kind) tap.profile?.record(rule.kind);
        else {
          const id = typeof rule.feature === 'function' ? rule.feature(args[0], result) : rule.feature;
          if (id && (!rule.gap || now() - (lastAt.get(id) || -Infinity) >= rule.gap)) { lastAt.set(id, now()); tap.profile?.record('feature', { id }); }
        }
      } catch (error) { console.error('[profile] 计分失败：', error.message); }
    };
    return handle(channel, (event, ...args) => {
      const out = handler(event, ...args);
      if (out && typeof out.then === 'function') { out.then(result => note(result, args), () => {}); return out; }
      note(out, args);
      return out;
    });
  };
  tap.bind = profile => { tap.profile = profile; for (const id of tap.seen) profile.registerFeature(id); };
  return tap;
}

// 历史用量：Token 账本里有用量的日期 + 会话记录（transcripts）里每天的会话数、消息数 + 各功能留下的痕迹。
// 账本每行 [provider, model, account, fresh, cached, write, output]，不算缓存读取。
const yieldLoop = () => new Promise(resolve => setImmediate(resolve));
async function readLedger(dataDir, out) {
  const models = new Map();
  try {
    const ledger = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'token-usage-ledger.json'), 'utf8'));
    out.hasLedger = true;
    for (const [day, rows] of Object.entries(ledger.days || {})) {
      let sum = 0;
      for (const row of Array.isArray(rows) ? rows : []) {
        const n = (Number(row[3]) || 0) + (Number(row[5]) || 0) + (Number(row[6]) || 0);
        sum += n;
        const model = String(row[1] || row[0] || '其他').slice(0, 60);
        if (n > 0) models.set(model, (models.get(model) || 0) + n);
      }
      if (sum > 0) { out.activeDays.push(day); out.tokens += sum; }
    }
    out.models = [...models].map(([name, tokens]) => ({ name, tokens })).sort((a, b) => b.tokens - a.tokens).slice(0, 8);
  } catch { /* 还没有账本 */ }
}
// 会话记录：Hub 给每个会话生成一份 transcripts/<id>.md，用户的每条消息是一个「## 我 · YYYY-MM-DD HH:MM」小标题。
// 同一条消息会出现在多份记录里（群聊广播、组队派活），自动化循环也会重复发同一句：按「日期 + 正文前 80 字」去重，一天同一句只算一次。
// 会话数按每份记录第一条消息的日期计。
const MSG_RE = /^## 我 · (\d{4}-\d{2}-\d{2}) (\d{2}):\d{2}[^\n]*\n+([^\n]{0,80})/gm;
async function readTranscripts(dir, out) {
  let names;
  try { names = (await fs.promises.readdir(dir)).filter(name => name.endsWith('.md')); } catch { return false; }
  const seen = new Set(), night = new Set(), early = new Set();
  for (let i = 0; i < names.length; i++) {
    let text;
    try { text = await fs.promises.readFile(path.join(dir, names[i]), 'utf8'); } catch { continue; }
    let m, firstDay = '';
    MSG_RE.lastIndex = 0;
    while ((m = MSG_RE.exec(text))) {
      const [, day, hh, head] = m;
      if (!firstDay) firstDay = day;
      const key = day + '|' + head;
      if (seen.has(key)) continue;
      seen.add(key);
      out.promptDays[day] = (out.promptDays[day] || 0) + 1;
      // 这条消息后面紧跟着 AI 的小标题（「## Claude · …」之类）就算 AI 答完一轮
      const next = text.indexOf('\n## ', MSG_RE.lastIndex);
      if (next >= 0 && !text.startsWith('\n## 我 · ', next)) out.turnDays[day] = (out.turnDays[day] || 0) + 1;
      const h = Number(hh);
      if (h >= 23 || h < 4) night.add(day);
      if (h >= 6 && h < 8) early.add(day);
    }
    if (firstDay) out.sessionDays[firstDay] = (out.sessionDays[firstDay] || 0) + 1;
    if (i % 20 === 19) await yieldLoop();
  }
  out.nightDays = [...night]; out.earlyDays = [...early];
  return names.length > 0;
}
// 没有会话记录时的退路：按会话文件的创建时间计每天新建的会话数。
async function readSessionFiles(dir, out) {
  try {
    const names = (await fs.promises.readdir(dir)).filter(name => name.endsWith('.json'));
    for (let i = 0; i < names.length; i++) {
      try {
        const stat = await fs.promises.stat(path.join(dir, names[i]));
        const key = out.dayKey(new Date(stat.birthtimeMs || stat.mtimeMs));
        out.sessionDays[key] = (out.sessionDays[key] || 0) + 1;
      } catch { /* 文件刚被删 */ }
      if (i % 50 === 49) await yieldLoop();
    }
  } catch { /* 没有会话目录 */ }
}
// 功能痕迹：各功能在数据目录里留下的文件，只看文件名、小文件和一行一条的账本，不读大文件。推断不出的功能不补。
async function readFeatureTraces(dataDir) {
  const fsp = fs.promises, out = {};
  const list = async (rel, re) => { try { return (await fsp.readdir(path.join(dataDir, rel))).filter(n => re.test(n)); } catch { return []; } };
  const size = async rel => { try { return (await fsp.stat(path.join(dataDir, rel))).size; } catch { return 0; } };
  const teams = await list('teams', /\.json$/); if (teams.length) out.team = teams.length;
  // 圆桌与写作都是群聊：按群文件里的 scene 区分
  for (const name of await list('meetings', /\.json$/)) {
    try {
      const head = (await fsp.readFile(path.join(dataDir, 'meetings', name), 'utf8')).match(/"scene"\s*:\s*"([^"]*)"/);
      const id = head && head[1] === 'writing' ? 'writing' : 'roundtable';
      out[id] = (out[id] || 0) + 1;
    } catch { /* 读不了就跳过 */ }
  }
  const aside = await list('btw-ask', /\.json$/); if (aside.length) out.aside = aside.length;
  const web = await list('web-roundtable', /\.json$/); if (web.length) out.webai = web.length;
  if (await size(path.join('assistant', 'CONVERSATION.md')) > 0) out.assistant = 1;
  if (await size(path.join('study', 'study-state.json')) > 0) out.study = 1;
  return out;
}
// quick：只读账本和功能痕迹（几十毫秒，打开个人页时当场等）；否则连会话记录一起扫（老用户可能要几秒，放后台）。
async function readHistory(dataDir, dayKey, { quick = false } = {}) {
  const out = { activeDays: [], sessionDays: {}, promptDays: {}, turnDays: {}, nightDays: [], earlyDays: [], tokens: 0, hasLedger: false, hasTranscripts: false, models: [], features: {}, dayKey };
  await readLedger(dataDir, out);
  out.features = await readFeatureTraces(dataDir);
  if (!quick) {
    out.hasTranscripts = await readTranscripts(path.join(dataDir, 'transcripts'), out);
    if (!out.hasTranscripts) await readSessionFiles(path.join(dataDir, 'sessions'), out);
  }
  delete out.dayKey;
  return out;
}

function createProfileController({ ipcMain, tap, dataDir, sendToRenderer, getPet = () => null, transcriptTap = null, app = null, debug = false, identitySources = {} }) {
  const { Profile, dayKey } = require('../core/profile/service');
  const identity = require('../core/profile/identity');
  const profile = new Profile({ dataDir });
  tap?.bind(profile);
  let identityBusy = null, historyBusy = null, lastOpenDay = '', models = [];

  // 入口按钮和页面头像用当前桌宠的形象；没有桌宠的版本用名字里的字。
  const petInfo = () => { try { const pet = getPet(); if (!pet) return { available: false }; const st = pet.getSettings(); return { available: true, enabled: !!st.enabled, role: st.role || '' }; } catch { return { available: false }; } };
  const brief = () => ({ ...profile.brief(), pet: petInfo() });
  const pushPet = () => { try { getPet()?.setProfile?.(profile.brief()); } catch { /* 桌宠没开 */ } };
  const changed = () => { sendToRenderer('profile:changed', brief()); pushPet(); };
  let changedTimer = null;
  profile.on('changed', () => { if (!changedTimer) changedTimer = setTimeout(() => { changedTimer = null; changed(); }, 400); });
  // 升级、解锁成就：页面弹一条提示；桌宠开着就让它庆祝。一次解锁多枚时合成一条。
  profile.on('achievement', ({ list, evolved }) => {
    const first = list[0], more = list.length - 1;
    const payload = { type: 'achievement', icon: first.icon, title: more > 0 ? `解锁 ${list.length} 枚成就` : `解锁成就「${first.name}」`, text: more > 0 ? list.map(a => a.name).join('、') : first.desc, list };
    sendToRenderer('profile:event', payload);
    if (!evolved) try { getPet()?.celebrate?.({ id: 'ach-' + first.id, title: payload.title, text: payload.text, art: 'badge-' + first.icon }); } catch { /* 桌宠没开 */ }
  });
  profile.on('level-up', ev => {
    const perk = petInfo().available ? ev.perks.map(p => `桌宠解锁「${p.name}」`).join('，') : '';
    const evolution = ev.evolution;
    const numeral = ['一', '二', '三', '四', '五', '六'];
    const payload = { type: 'level-up', level: ev.to, rank: ev.rank.n, title: evolution ? `进化了！形态${numeral[evolution.n - 1]} · ${evolution.name}` : ev.rankUp ? `升到 Lv.${ev.to} · 晋升${ev.rank.name}` : `升到 Lv.${ev.to}`, text: evolution ? `升到 Lv.${ev.to}，解锁新形态${perk ? '，' + perk : ''}` : perk || `${ev.rank.name}，继续加油` };
    sendToRenderer('profile:event', payload);
    pushPet();
    try { getPet()?.celebrate?.({ id: 'lv-' + ev.to, title: payload.title, text: payload.text, big: ev.rankUp, art: evolution ? 'evolve-' + evolution.n : 'rank-' + ev.rank.n, ...(evolution ? { evolution, fromEvolution: require('../core/profile/rules').evolutionOf(ev.from) } : {}) }); } catch { /* 桌宠没开 */ }
  });

  function noteOpen() {
    const key = dayKey(new Date());
    if (key === lastOpenDay) return;
    lastOpenDay = key; profile.record('open');
  }
  // 回溯历史分两步：先读账本和功能痕迹（几十毫秒，打开个人页时当场等）；会话记录可能几百 MB，后台扫完再补一次，
  // 补完页面和桌宠跟着刷新。同一时刻只跑一次；会话记录只在第一次扫。
  function applyHistory(history) {
    const done = profile.state.backfill || {};
    const ready = history.hasLedger || history.hasTranscripts || Object.keys(history.sessionDays).length || Object.keys(history.features).length;
    // 账本要等首次统计才有：什么都没有时先不结案，下次再试
    if (ready && (!profile.state.backfill || (!done.ledger && history.hasLedger) || (!done.transcripts && history.hasTranscripts) || !done.features)) {
      profile.backfill({ ...history, ledger: history.hasLedger, transcripts: history.hasTranscripts });
    }
    profile.setTokens(history.tokens); models = history.models;
    try { if (getPet()?.isActive?.()) profile.petCompany(); } catch { /* 桌宠没开 */ }
  }
  let fullBusy = null;
  function syncHistory() {
    if (historyBusy) return historyBusy;
    historyBusy = (async () => {
      applyHistory(await readHistory(dataDir, dayKey, { quick: true }));
    })().catch(error => { console.error('[profile] 回溯失败：', error.message); }).finally(() => { historyBusy = null; });
    // 会话记录还没扫过：接着在后台扫（不等它）
    if (!fullBusy && !(profile.state.backfill && profile.state.backfill.transcripts)) {
      const t0 = Date.now();
      fullBusy = historyBusy.then(() => readHistory(dataDir, dayKey)).then(history => {
        applyHistory(history);
        console.log(`[profile] 会话记录回溯完成：${Object.values(history.promptDays).reduce((a, b) => a + b, 0)} 条消息、${Object.values(history.sessionDays).reduce((a, b) => a + b, 0)} 个会话，用时 ${Date.now() - t0} ms`);
      }).catch(error => { console.error('[profile] 会话记录回溯失败：', error.message); }).finally(() => { fullBusy = null; profile.emit('changed'); });
    }
    return historyBusy;
  }
  const historyDone = () => fullBusy || historyBusy || Promise.resolve();
  function refreshIdentity({ force = false } = {}) {
    if (identityBusy) return identityBusy;
    identityBusy = (async () => {
      // 缓存还新鲜就不读本机；要读时 git 走异步子进程，不阻塞主进程
      const next = await identity.resolveIdentity({ cached: profile.state.identity, read: () => identity.localIdentity(identitySources), force });
      if (JSON.stringify(next) !== JSON.stringify(profile.state.identity)) profile.setIdentity(next);
      return next;
    })().catch(error => { console.error('[profile] 认人失败：', error.message); return profile.state.identity; }).finally(() => { identityBusy = null; });
    return identityBusy;
  }

  transcriptTap?.on('turn-complete', () => { try { profile.record('turn'); } catch (error) { console.error('[profile] 计分失败：', error.message); } });
  app?.on('browser-window-focus', noteOpen);
  app?.on('before-quit', () => { try { profile.flush(); } catch { /* 退出时保存失败不拦退出 */ } });

  // 足迹页和名片页另外要的：各模型用量、版本、数据放在哪。
  const extra = () => ({ models, version: app?.getVersion?.() || '', dataDir: path.join(dataDir, 'profile'), scanning: !!fullBusy });
  const full = () => ({ ok: true, snapshot: profile.snapshot(), brief: brief(), extra: extra() });
  const handlers = {
    // 打开页面时先和文件对一次：别的 Hub 窗口记的经验也算进来；还没回溯过、名字还没认就当场补上
    state: async () => {
      if (!profile.state.backfill) await syncHistory();
      if (!profile.state.identity) await refreshIdentity();
      profile.save(); return full();
    },
    brief: () => ({ ok: true, brief: brief() }),
    seen: () => { profile.markSeen(); return { ok: true }; },
    'set-nickname': request => { profile.setNickname(request && request.name); return { ok: true, brief: brief() }; },
    'refresh-identity': async () => { await refreshIdentity({ force: true }); return full(); },
  };
  // 测试开关（只在隔离 Hub 且 CLAUDE_HUB_PROFILE_DEBUG=1 时注册）：直接加经验，用来验收升级撒花和进化形态。
  if (debug) handlers['debug-add-xp'] = request => {
    const n = Math.max(0, Math.min(1e7, Number(request && request.xp) || 0));
    profile.gain(profile.today(), n); profile.settle(); profile.save(); profile.emit('changed');
    return full();
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('profile:' + name, async (_event, request = {}) => { try { return await handler(request); } catch (error) { return { ok: false, error: error.message }; } });
  }

  let timer = null;
  function start() {
    noteOpen();
    // 认人只读本机文件和 git 配置，立刻做；回溯稍后在后台做，不和启动抢。
    void refreshIdentity();
    setTimeout(() => { void syncHistory().then(pushPet); }, 4000).unref?.();
    // 定时只同步历史和身份；「今天用过」只在启动、窗口获得焦点和实际操作时记，Hub 挂在后台不算。
    timer = setInterval(() => { void syncHistory().then(() => { try { profile.save(); } catch { /* 下次再试 */ } }); void refreshIdentity(); }, 30 * 60000); timer.unref?.();
  }
  return { profile, start, refreshIdentity, syncHistory, historyDone, brief: () => profile.brief(),
    // 桌宠被摸了一下。
    notePet: () => profile.record('pet'),
    noteFeature: id => profile.record('feature', { id }),
    stop: () => { clearInterval(timer); profile.flush(); } };
}

module.exports = { installProfileTap, createProfileController, readHistory, readFeatureTraces, TAPS };
