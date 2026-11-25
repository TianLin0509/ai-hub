'use strict';
// 各家 AI 的本机用量记录 → 按「天 / 产品 / 模型 / 账号」聚合（2026-11-08）。只读，不调用模型。
// 口径：fresh=未命中缓存的输入，cached=缓存读取，write=缓存写入，output=输出（含思考）；四项之和是总量。
// 运行方式和产品不是一回事（DeepSeek 可跑在 Claude Code / Codex / DSH 上），所以产品优先按模型名判断。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROVIDERS = ['claude', 'codex', 'antigravity', 'deepseek', 'kimi', 'qwen', 'glm'];
function providerOf(model, fallback) {
  const m = String(model || '').toLowerCase();
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('glm')) return 'glm';
  if (m.includes('kimi')) return 'kimi';
  if (m.startsWith('claude')) return 'claude';
  if (/^(gpt-|o\d)/.test(m)) return 'codex';
  return fallback;
}
const pad = n => String(n).padStart(2, '0');
function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
const parseTime = v => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : 0; };
const SEP = '\u0000';

class Tally {
  constructor(sinceMs) { this.sinceMs = sinceMs; this.rows = new Map(); }
  add(at, provider, model, account, usage) {
    if (!at || at < this.sinceMs) return;
    const fresh = num(usage.fresh), cached = num(usage.cached), write = num(usage.write), output = num(usage.output);
    if (!fresh && !cached && !write && !output) return;
    const key = [dayKey(at), provider, model || 'unknown', account || ''].join(SEP);
    const row = this.rows.get(key) || [0, 0, 0, 0];
    row[0] += fresh; row[1] += cached; row[2] += write; row[3] += output;
    this.rows.set(key, row);
  }
  byDay() {
    const days = {};
    for (const [key, v] of this.rows) { const [day, provider, model, account] = key.split(SEP); (days[day] ||= []).push([provider, model, account, ...v]); }
    return days;
  }
}

function walk(root, match, sinceMs, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // 目录链接指向的内容在它的真实位置已经统计过
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, match, sinceMs, out); }
    else if (e.isFile() && match(e.name)) { try { if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p); } catch {} }
  }
  return out;
}
const subdirs = root => { try { return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => e.name); } catch { return []; } };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// 逐行读，needle 先在字节层筛一遍，日志动辄几 GB，绝大多数行不用解析。
async function eachLine(file, needle, onLine) {
  const needleBuf = Buffer.from(needle);
  let carry = [];
  const take = buf => { if (buf.includes(needleBuf)) { let r; try { r = JSON.parse(buf.toString('utf8')); } catch { return; } onLine(r); } };
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    let start = 0, nl;
    while ((nl = chunk.indexOf(10, start)) !== -1) {
      const part = chunk.subarray(start, nl);
      if (carry.length) { carry.push(part); take(Buffer.concat(carry)); carry = []; } else take(part);
      start = nl + 1;
    }
    if (start < chunk.length) carry.push(Buffer.from(chunk.subarray(start)));
  }
  if (carry.length) take(Buffer.concat(carry));
}

function roots({ homeDir, dataDir: hub }) {
  const claude = [], codex = [], agy = [];
  for (const id of subdirs(path.join(hub, 'claude-account-runtimes'))) {
    const dir = path.join(hub, 'claude-account-runtimes', id);
    claude.push({ dir: path.join(dir, 'projects'), account: readJson(path.join(dir, '.hub-account.json'))?.profile || '' });
  }
  claude.push({ dir: path.join(homeDir, '.claude', 'projects'), account: 'default' });
  for (const id of subdirs(path.join(homeDir, '.claude-profiles'))) claude.push({ dir: path.join(homeDir, '.claude-profiles', id, 'projects'), account: id });
  claude.push({ dir: path.join(homeDir, '.claude-deepseek', 'projects'), account: '', provider: 'deepseek' });
  for (const id of subdirs(path.join(hub, 'codex-account-runtime'))) {
    const dir = path.join(hub, 'codex-account-runtime', id);
    codex.push({ dir: path.join(dir, 'sessions'), account: readJson(path.join(dir, '.hub-codex-account-runtime.json'))?.profile || '' });
  }
  codex.push({ dir: path.join(homeDir, '.codex', 'sessions'), account: 'default' });
  for (const id of subdirs(path.join(homeDir, '.codex-profiles'))) codex.push({ dir: path.join(homeDir, '.codex-profiles', id, 'sessions'), account: id });
  codex.push({ dir: path.join(hub, 'deepseek-codex-profile', 'sessions'), account: '', provider: 'deepseek' });
  for (const id of subdirs(path.join(hub, 'writing-codex-homes'))) codex.push({ dir: path.join(hub, 'writing-codex-homes', id, 'sessions'), account: '' });
  agy.push({ dir: path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations'), account: 'default' });
  for (const id of subdirs(path.join(homeDir, '.antigravity-profiles'))) agy.push({ dir: path.join(homeDir, '.antigravity-profiles', id, '.gemini', 'antigravity-cli', 'conversations'), account: id });
  agy.push({ dir: path.join(hub, 'writing-antigravity-home', '.gemini', 'antigravity-cli', 'conversations'), account: '' });
  const acp = subdirs(path.join(hub, 'acp')).map(id => path.join(hub, 'acp', id, 'home'));
  return { claude, codex, agy, acp, kimi: path.join(homeDir, '.kimi-code', 'sessions') };
}

// Claude：一条回复的多个内容块共用 message.id 和累计用量；分支会话也会抄历史，所以跨文件去重，各字段取最大。
async function scanClaude(list, tally, ctx) {
  const seen = new Map();
  for (const src of list) for (const file of walk(src.dir, n => n.endsWith('.jsonl'), ctx.sinceMs)) {
    ctx.files++;
    try {
      await eachLine(file, '"usage"', r => {
        if (r?.type !== 'assistant' || !r.message?.usage || r.message.model === '<synthetic>') return;
        const key = r.message.id || r.requestId, u = r.message.usage, at = parseTime(r.timestamp);
        if (!key || !at) return;
        const v = [num(u.input_tokens), num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens), num(u.output_tokens)];
        const old = seen.get(key);
        if (old) old.v = old.v.map((x, i) => Math.max(x, v[i]));
        else seen.set(key, { v, at, model: r.message.model, account: src.account, provider: src.provider });
      });
    } catch { ctx.errors++; }
  }
  for (const m of seen.values()) tally.add(m.at, m.provider || providerOf(m.model, 'claude'), m.model, m.account, { fresh: m.v[0], cached: m.v[1], write: m.v[2], output: m.v[3] });
}

// Codex：每次调用都有 last_token_usage；恢复、分支会把旧记录重放到新文件，用累计值+本次值识别同一次调用。
async function scanCodex(list, tally, ctx) {
  const seen = new Set();
  for (const src of list) for (const file of walk(src.dir, n => n.endsWith('.jsonl'), ctx.sinceMs)) {
    ctx.files++;
    let model = '';
    try {
      await eachLine(file, '_', r => {
        if (r?.type === 'turn_context') { model = r.payload?.model || model; return; }
        if (r?.type !== 'event_msg' || r.payload?.type !== 'token_count') return;
        const info = r.payload.info, last = info?.last_token_usage, at = parseTime(r.timestamp);
        if (!last || !at) return;
        const key = [info.total_token_usage?.total_tokens, last.total_tokens, last.input_tokens, last.output_tokens].join(':');
        if (seen.has(key)) return;
        seen.add(key);
        const cached = num(last.cached_input_tokens);
        tally.add(at, src.provider || providerOf(model, 'codex'), model, src.account, { fresh: num(last.input_tokens) - cached, cached, output: num(last.output_tokens) });
      });
    } catch { ctx.errors++; }
  }
}

function varint(b, i) {
  let v = 0, m = 1, x;
  do { x = b[i++]; if (x === undefined) throw Error('eof'); v += (x & 127) * m; m *= 128; } while (x >= 128);
  return [v, i];
}
function protoFields(b) {
  const out = new Map();
  let i = 0;
  while (i < b.length) {
    let tag; [tag, i] = varint(b, i);
    const field = Math.floor(tag / 8), wire = tag & 7;
    let v;
    if (wire === 0) [v, i] = varint(b, i);
    else if (wire === 2) { let n; [n, i] = varint(b, i); if (i + n > b.length) throw Error('len'); v = b.subarray(i, i + n); i += n; }
    else if (wire === 1) { v = b.subarray(i, i + 8); i += 8; }
    else if (wire === 5) { v = b.subarray(i, i + 4); i += 4; }
    else throw Error('wire');
    if (!out.has(field)) out.set(field, v);
  }
  return out;
}
// Antigravity 没有公开字段说明：步骤元数据的第 9 段是用量（2=输入，3=输出=9+10，5=缓存读取），由数值关系反推。
function antigravityStep(metadata) {
  const top = protoFields(metadata), raw = top.get(9);
  if (!raw || typeof raw === 'number') return null;
  const u = protoFields(raw);
  let at = 0;
  for (const v of top.values()) {
    if (typeof v === 'number' || v.length < 6 || v.length > 14) continue;
    try { const s = protoFields(v).get(1); if (s > 1.7e9 && s < 1.9e9 && (!at || s < at)) at = s; } catch {}
  }
  return at ? { at: at * 1000, fresh: num(u.get(2)), output: num(u.get(3)), cached: num(u.get(5)) } : null;
}
function antigravityModelsForDb(dbFile) {
  const convId = path.basename(dbFile, '.db');
  const brainDir = path.join(path.dirname(path.dirname(dbFile)), 'brain', convId, '.system_generated', 'logs');
  const file = path.join(brainDir, 'transcript.jsonl');
  const models = [];
  try {
    if (!fs.existsSync(file)) return models;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"model"')) continue;
      try {
        const r = JSON.parse(line);
        if (r?.type === 'PLANNER_RESPONSE' && typeof r.model === 'string' && r.model.trim()) {
          models.push({ at: parseTime(r.created_at), model: r.model.trim() });
        }
      } catch {}
    }
  } catch {}
  return models;
}
function scanAntigravity(list, tally, ctx) {
  const { DatabaseSync } = require('node:sqlite');
  const seen = new Set();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-token-usage-'));
  try {
    for (const src of list) for (const file of walk(src.dir, n => n.endsWith('.db'), ctx.sinceMs)) {
      ctx.files++;
      const copy = path.join(temp, 'c.db');
      const stepModels = antigravityModelsForDb(file);
      const fallbackModel = stepModels.at(-1)?.model || '';
      let db;
      try {
        // 读副本：Antigravity 可能正在写这个库，不和它抢锁。
        fs.copyFileSync(file, copy);
        try { fs.copyFileSync(file + '-wal', copy + '-wal'); } catch { fs.rmSync(copy + '-wal', { force: true }); }
        db = new DatabaseSync(copy);
        for (const row of db.prepare('select metadata from steps where metadata is not null').iterate()) {
          let s; try { s = antigravityStep(Buffer.from(row.metadata)); } catch { continue; }
          if (!s) continue;
          const key = [s.at, s.fresh, s.cached, s.output].join(':');
          if (seen.has(key)) continue;
          seen.add(key);
          const matched = stepModels.find(m => Math.abs(m.at - s.at) <= 5000)?.model || fallbackModel;
          tally.add(s.at, 'antigravity', matched, src.account, s);
        }
      } catch { ctx.errors++; } finally { try { db?.close(); } catch {} }
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function scanAcp(homes, tally, ctx) {
  const seen = new Set();
  const once = key => { if (seen.has(key)) return false; seen.add(key); return true; };
  for (const home of homes) {
    for (const file of walk(path.join(home, '.qwen', 'usage'), n => n.startsWith('token-usage-') && n.endsWith('.jsonl'), ctx.sinceMs)) {
      ctx.files++;
      try {
        await eachLine(file, 'inputTokens', r => {
          if (r?.id && !once(r.id)) return;
          const cached = num(r?.cachedTokens);
          tally.add(parseTime(r?.timestamp), 'qwen', r?.model, '', { fresh: num(r?.inputTokens) - cached, cached, output: num(r?.outputTokens) });
        });
      } catch { ctx.errors++; }
    }
    for (const file of walk(path.join(home, '.dsh', 'hub-events'), n => n.endsWith('.jsonl'), ctx.sinceMs)) {
      ctx.files++;
      try {
        await eachLine(file, 'cacheReadTokens', r => {
          for (const e of r?.events || []) {
            const u = e?.data?.usage;
            if (!u || !Number.isFinite(u.outputTokens) || !once(file + ':' + e.seq)) continue;
            const model = e.data.message?.source?.model || e.data.model || r.model;
            tally.add(parseTime(e.time), providerOf(model, 'deepseek'), model, '', { fresh: u.inputTokens, cached: u.cacheReadTokens, output: u.outputTokens });
          }
        });
      } catch { ctx.errors++; }
    }
    for (const file of walk(path.join(home, '.zcode', 'cli', 'rollout'), n => n.endsWith('.jsonl'), ctx.sinceMs)) {
      ctx.files++;
      try {
        await eachLine(file, '"usage"', r => {
          const u = r?.response?.usage;
          if (!u || !once(file + ':' + r.requestId + ':' + r.attempt)) return;
          const model = r.model?.modelId, input = num(u.inputTokens ?? u.promptTokens ?? u.prompt_tokens);
          const cached = num(u.cachedInputTokens ?? u.inputTokenDetails?.cacheReadTokens ?? u.prompt_tokens_details?.cached_tokens);
          tally.add(parseTime(r.completedAt), providerOf(model, 'glm'), model, '', { fresh: input - cached, cached, output: num(u.outputTokens ?? u.completionTokens ?? u.completion_tokens) });
        });
      } catch { ctx.errors++; }
    }
  }
}

async function scanKimi(root, tally, ctx) {
  for (const file of walk(root, n => n === 'wire.jsonl', ctx.sinceMs)) {
    ctx.files++;
    try {
      await eachLine(file, 'usage.record', r => {
        if (r?.type !== 'usage.record' || r.usageScope !== 'turn' || !r.usage) return;
        tally.add(parseTime(r.time), 'kimi', r.model, '', { fresh: r.usage.inputOther, cached: r.usage.inputCacheRead, write: r.usage.inputCacheCreation, output: r.usage.output });
      });
    } catch { ctx.errors++; }
  }
}

async function scanAll({ homeDir, dataDir, sinceMs, onStage = () => {} }) {
  const tally = new Tally(sinceMs), r = roots({ homeDir, dataDir }), ctx = { sinceMs, files: 0, errors: 0 };
  onStage('Claude'); await scanClaude(r.claude, tally, ctx);
  onStage('Codex'); await scanCodex(r.codex, tally, ctx);
  onStage('Antigravity'); scanAntigravity(r.agy, tally, ctx);
  onStage('DeepSeek、千问、智谱'); await scanAcp(r.acp, tally, ctx);
  onStage('Kimi'); await scanKimi(r.kimi, tally, ctx);
  return { days: tally.byDay(), files: ctx.files, errors: ctx.errors };
}

module.exports = { PROVIDERS, providerOf, dayKey, Tally, antigravityStep, protoFields, scanAll };
