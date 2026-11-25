'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_PROJECT_ROOT_DIRS = [
  '.claude',
  '.claude-deepseek',
];

function defaultHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

// 配置无效时返回 null（只是少一个根，不影响 Claude 记录）。
function codeAgentProjectsRoot(homeDir = defaultHomeDir()) {
  try {
    const { configDir } = require('./codeagent-config').resolveCodeAgentConfig({ ...process.env, USERPROFILE: homeDir, HOME: homeDir });
    return path.join(configDir, 'projects');
  } catch { return null; }
}

function claudeProjectRoots(homeDir = defaultHomeDir()) {
  const roots = CLAUDE_PROJECT_ROOT_DIRS.map(dir => path.join(homeDir, dir, 'projects'));
  const cp = require('./claude-subscription-profiles');
  const ownHome = path.resolve(homeDir) === path.resolve(defaultHomeDir());
  const config = ownHome ? require('./hub-config').getConfig() : {};
  const env = ownHome ? process.env : {USERPROFILE:homeDir,HOME:homeDir};
  for (const p of cp.normalizeProfiles(config.claudeSubscriptionProfiles, homeDir)) {
    try {const dir=path.join(cp.resolveProfile(config,p.id,env,homeDir).home,'projects');if(!roots.includes(dir) && fs.existsSync(dir))roots.push(dir);}catch {}
  }
  const root = codeAgentProjectsRoot(homeDir);
  if (root && !roots.some(item => path.resolve(item).toLowerCase() === path.resolve(root).toLowerCase())) roots.push(root);
  return roots;
}

// 一次走完所有项目目录，得到「原生会话 id → 记录文件」。批量查找时用它，避免每条会话都把全部目录翻一遍
// （2026-11-08：326 条找不到路径的旧会话，逐条查要 11.7 秒，且全在启动窗口出现之前）。
// 同一 id 有多份副本时取第一份，与逐条查找的先后顺序一致。
function buildTranscriptIndex(roots) {
  const index = new Map();
  for (const projectsDir of roots) {
    let buckets;
    try { buckets = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { continue; }
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      let names;
      try { names = fs.readdirSync(path.join(projectsDir, bucket.name)); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const id = name.slice(0, -'.jsonl'.length);
        if (!index.has(id)) index.set(id, path.join(projectsDir, bucket.name, name));
      }
    }
  }
  return index;
}

// 一次查找要把所有账号的 projects 目录（实测 7 个根、575 个子目录）逐个 existsSync，主线程同步 60–90 ms；
// 还没写出记录的新会话每次卡片刷新都会再扫一遍（2026-11-18 主进程采样）。
// 找到的路径记住（用前确认文件还在）；没找到只记 3 秒，新记录最多晚 3 秒被发现。
const transcriptLookupCache = new Map();
const TRANSCRIPT_MISS_TTL_MS = 3000;
function findTranscriptByCCSessionId(ccSessionId, homeDir = defaultHomeDir()) {
  if (!ccSessionId) return null;
  const key = `${homeDir}|${ccSessionId}`;
  const cached = transcriptLookupCache.get(key);
  if (cached) {
    if (cached.path && fs.existsSync(cached.path)) return cached.path;
    if (!cached.path && Date.now() - cached.at < TRANSCRIPT_MISS_TTL_MS) return null;
    transcriptLookupCache.delete(key);
  }
  let found = null;
  for (const projectsDir of claudeProjectRoots(homeDir)) {
    try {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        const candidate = path.join(projectsDir, d.name, ccSessionId + '.jsonl');
        if (fs.existsSync(candidate)) { found = candidate; break; }
      }
    } catch {}
    if (found) break;
  }
  if (transcriptLookupCache.size > 2000) transcriptLookupCache.clear();
  transcriptLookupCache.set(key, { path: found, at: Date.now() });
  return found;
}

// Claude CLI buckets transcripts by cwd: every non-alphanumeric char becomes '-'.
// `claude --resume <id>` only looks inside the bucket for the *current* cwd, so a
// workspace that moves on disk (scratch → 正式分类归档) leaves its transcript behind
// and the resume fails with "No conversation found with session ID".
function projectSlug(cwd) {
  return path.resolve(String(cwd || '')).replace(/[^A-Za-z0-9]/g, '-');
}

// Copy each session's transcript into the bucket for `toCwd` so the post-archive
// `--resume` finds it. Best-effort: the archive itself already succeeded, so a
// failure here must degrade to "resumes without history", never abort the move.
function migrateTranscriptsForCwdChange(opts = {}) {
  const { toCwd, ccSessionIds = [] } = opts;
  const homeDir = opts.homeDir || defaultHomeDir();
  const logger = opts.logger || console;
  const result = { copied: [], missing: [], errors: [] };
  if (!toCwd) return result;
  const slug = projectSlug(toCwd);

  for (const ccSessionId of ccSessionIds) {
    if (!ccSessionId) continue;
    try {
      const source = findTranscriptByCCSessionId(ccSessionId, homeDir);
      if (!source) {
        result.missing.push(ccSessionId);
        continue;
      }
      // <homeDir>/<.claude|.claude-deepseek>/projects/<slug>/<sid>.jsonl —
      // keep the copy under the same root the CLI variant reads from.
      const projectsDir = path.dirname(path.dirname(source));
      const targetDir = path.join(projectsDir, slug);
      const target = path.join(targetDir, `${ccSessionId}.jsonl`);
      if (path.resolve(source) === path.resolve(target)) {
        result.copied.push(target);
        continue;
      }
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(source, target);
      // 归档后 CLI 在新目录续写；旧副本还在，查找缓存要改指新副本，否则会一直返回旧的（2026-11-18 Codex 审查）。
      transcriptLookupCache.set(`${homeDir}|${ccSessionId}`, { path: target, at: Date.now() });
      result.copied.push(target);
    } catch (error) {
      result.errors.push(`${ccSessionId}: ${error && error.message ? error.message : String(error)}`);
      logger.warn?.('[transcript] migrate failed:', error && error.message);
    }
  }
  return result;
}

function extractCwdFromTranscript(transcriptPath) {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.slice(0, n).toString('utf-8');
      const m = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse('"' + m[1] + '"');
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return null;
}

function healPersistedCwds(sessions, opts = {}) {
  const logger = opts.logger || console;
  const homeDir = opts.homeDir || defaultHomeDir();
  let fixed = 0;
  let index = null;
  const lookup = id => {
    if (!index) index = buildTranscriptIndex(claudeProjectRoots(homeDir));
    return index.get(id) || null;
  };
  for (const s of sessions) {
    if (!s.ccSessionId) continue;
    // 已持久化的 transcriptPath 比按 sid 找到的“第一份副本”更具体；归档会把同一
    // jsonl 复制到新旧两个 bucket，目录枚举顺序不能当权威。
    const tp = (s.transcriptPath && fs.existsSync(s.transcriptPath))
      ? s.transcriptPath
      : lookup(s.ccSessionId);
    if (!tp) continue;
    const realCwd = extractCwdFromTranscript(tp);
    if (!realCwd) continue;

    // transcript 迁移只复制 jsonl，不改写历史消息里的 cwd，所以候选值可能仍是已经
    // 删除的旧 scratch。把 Home “自愈”回另一个失效路径只是制造一次假修复。
    let targetIsDirectory = false;
    try { targetIsDirectory = fs.statSync(realCwd).isDirectory(); } catch {}
    if (!targetIsDirectory) {
      logger.warn?.(`[群聊] skip invalid transcript cwd for "${s.title}": ${realCwd}`);
      continue;
    }

    const key = value => {
      const resolved = path.resolve(String(value || ''));
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    if (key(realCwd) === key(s.cwd)) continue;
    logger.log?.(`[群聊] heal cwd: "${s.title}" ${s.cwd} -> ${realCwd}`);
    s.cwd = realCwd;
    delete s.cwdFellBackFrom;
    fixed++;
  }
  return fixed;
}

module.exports = {
  CLAUDE_PROJECT_ROOT_DIRS,
  buildTranscriptIndex,
  claudeProjectRoots,
  codeAgentProjectsRoot,
  extractCwdFromTranscript,
  findTranscriptByCCSessionId,
  healPersistedCwds,
  migrateTranscriptsForCwdChange,
  projectSlug,
};
