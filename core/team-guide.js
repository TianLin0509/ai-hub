'use strict';
// 组队指路（2026-11-26）：所有后端的会话默认带一小段，用户在任何会话里说「组个队做 X」，
// 它都知道先读 hub-driver skill、用 Hub 自带的 hub / hub-team 命令招侧栏成员。完整说明不进上下文，按需读。
// 这段不受「规则」页开关影响；内部人设会话、场景会话照旧不带（由注入方按 purpose 判断）。
// 只有本机写了 hub 命令（<数据目录>/team/hub.cmd，前台功能开着才写）时才带：公司版没有 hub 命令，也就不带。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const SKILL = 'hub-driver';
const MARK = '.hub-managed';

const hubCliPath = dataDir => path.join(dataDir, 'team', process.platform === 'win32' ? 'hub.cmd' : 'hub.sh');

// 随包附带的那份（纯净版、队员版：resources/skills/hub-driver；导出目录直接跑时在仓库根 skills/）。主干不带，用本机手放的那份。
function bundledSkillDir() {
  const roots = [process.resourcesPath && path.join(process.resourcesPath, 'skills'), path.join(__dirname, '..', 'skills')];
  for (const root of roots) {
    if (root && fs.existsSync(path.join(root, SKILL, 'SKILL.md'))) return path.join(root, SKILL);
  }
  return null;
}

// 各 CLI 会自己发现的用户级 skill 目录：Claude Code 读 ~/.claude/skills；Codex、Gemini 等读 ~/.agents/skills。
// 与 Hub 其他处同一口径的用户目录：隔离测试实例的 CLAUDE_HUB_HOME_DIR 优先，不碰真实用户目录。
const defaultHome = (env = process.env) => env.CLAUDE_HUB_HOME_DIR || env.USERPROFILE || env.HOME || os.homedir();
const skillRoots = home => [path.join(home, '.agents', 'skills'), path.join(home, '.claude', 'skills')];

function listFiles(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const name = path.posix.join(rel, entry.name);
    if (entry.name === MARK) continue;
    if (entry.isDirectory()) out.push(...listFiles(dir, name));
    else if (entry.isFile()) out.push(name);
  }
  return out.sort();
}
function hashDir(dir) {
  const h = createHash('sha256');
  for (const file of listFiles(dir)) h.update(file + '\0').update(fs.readFileSync(path.join(dir, file))).update('\0');
  return h.digest('hex');
}
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const file of listFiles(from)) {
    fs.mkdirSync(path.dirname(path.join(to, file)), { recursive: true });
    fs.copyFileSync(path.join(from, file), path.join(to, file));
  }
}
function readMark(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARK), 'utf8')); } catch { return null; }
}

// 启动时把随包的 hub-driver 装进各 skill 目录。规矩同公司版的内置 skill：
// 目标不存在才装，带 .hub-managed 标记；之后只更新带标记且没被改过的那份。
// 用户手放的目录、链接（如 ~/.claude/skills/hub-driver 指向 ~/.agents 的链接）和改过的副本一律不动。
function installBundled({ home = defaultHome(), source = bundledSkillDir(), logger = console } = {}) {
  if (!source) return [];
  const sourceSha = hashDir(source);
  return skillRoots(home).map(root => {
    const dest = path.join(root, SKILL);
    let stat = null;
    try { stat = fs.lstatSync(dest); } catch (error) { if (error.code !== 'ENOENT') return { dest, result: 'error', error: error.message }; }
    try {
      if (!stat) {
        copyDir(source, dest);
        fs.writeFileSync(path.join(dest, MARK), JSON.stringify({ sha: sourceSha, at: new Date().toISOString() }) + '\n');
        return { dest, result: 'installed' };
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { dest, result: 'kept-user' };
      const mark = readMark(dest);
      if (!mark) return { dest, result: 'kept-user' };
      const current = hashDir(dest);
      if (current !== mark.sha) return { dest, result: 'kept-modified' };
      if (current === sourceSha) return { dest, result: 'current' };
      for (const file of listFiles(dest)) fs.unlinkSync(path.join(dest, file));
      copyDir(source, dest);
      fs.writeFileSync(path.join(dest, MARK), JSON.stringify({ sha: sourceSha, at: new Date().toISOString() }) + '\n');
      return { dest, result: 'updated' };
    } catch (error) {
      logger.warn?.(`[team-guide] hub-driver 没装进 ${dest}：${error.message}`);
      return { dest, result: 'error', error: error.message };
    }
  });
}

// 指路里写的绝对路径：先用各 skill 目录里已有的（用户手放的、启动时装好的），再用随包那份。
function skillFile({ home = defaultHome(), source = bundledSkillDir() } = {}) {
  const candidates = [...skillRoots(home).map(root => path.join(root, SKILL, 'SKILL.md')), source && path.join(source, 'SKILL.md')];
  return candidates.find(file => file && fs.existsSync(file)) || null;
}

function guideText({ dataDir, home, source } = {}) {
  if (!dataDir || !fs.existsSync(hubCliPath(dataDir))) return null;
  const file = skillFile({ home, source });
  const read = file ? `先读 hub-driver skill（${file.replace(/\\/g, '/')}，用到时再读，平时不必读）` : '先运行 `hub help` 看组队与派活命令';
  return `用户要组队、派活、并行开多个会话或叫别的模型（Claude、Codex、Gemini 等）帮忙时，${read}，`
    + '再按它用 Hub 自带的 hub / hub-team 命令（路径在环境变量 CLAUDE_HUB_CLI）招侧栏成员、派活和验收；'
    + '不要改用后台命令行另起 Agent。Hub 没有所需能力时，直接告诉用户缺什么。';
}

module.exports = { SKILL, MARK, hubCliPath, bundledSkillDir, skillRoots, installBundled, skillFile, guideText, hashDir };
