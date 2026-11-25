'use strict';
// 共享记忆目录（Claude auto memory，所有会话共用）的写入工具：一事一文件（frontmatter + 正文），在对应分类索引登记一行。
// 用于：Hub 旧 USER.md / MEMORY.md 的一次性迁移（scripts/migrate-hub-memory.js），以及 Codex 等非 Claude 前台的
// update_memory（Claude 前台直接用 Write 写，经钩子保护）。格式与目录里已有条目一致。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SECRET_RE, frontmatter } = require('./memory');

const HUB_SECTION = '## Hub 前台迁入与记下的条目';
// 分类按关键词粗分；拿不准的进「协作与工程」。顺序即优先级。
const CATEGORIES = [];
function categoryFor(text) { return (CATEGORIES.find(c => c.re.test(text)) || { index: 'index-collaboration-engineering.md' }).index; }
// 偏好/习惯归 user，做法与约定归 feedback，入口与资料归 reference。
function typeFor(text, origin) {
  if (/入口|路径|C:\/|D:\/|\.md|\.py|https?:/i.test(text) && !/不|须|先/.test(text.slice(0, 6))) return 'reference';
  return origin === 'user' ? 'user' : 'feedback';
}
function slugFor(text, day) {
  const ascii = (String(text).match(/[A-Za-z][A-Za-z0-9-]{1,20}/g) || []).slice(0, 3).join('-').toLowerCase();
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 6);
  return `hub-front-${ascii ? ascii + '-' : ''}${day.replace(/-/g, '')}-${hash}`;
}
function today(now = Date.now()) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
function describe(text, max = 70) { return String(text).replace(/\s+/g, ' ').replace(/（[^）]*\d{1,2}-\d{2}[^）]*）\s*$/, '').trim().slice(0, max); }
function assertNoSecret(text) { if (SECRET_RE.test(text)) throw new Error('内容疑似包含密钥或密码，未写入；记忆里不保存任何凭据'); }
function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  require('./atomic-rename').renameRetry(tmp, file);
}
function registerIndex(dir, index, line) {
  const file = path.join(dir, index);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = `# ${index.replace(/^index-|\.md$/g, '')}\n`; }
  if (text.includes(line)) return file;
  text = text.includes(HUB_SECTION) ? text.replace(/\n*$/, '\n') + line + '\n' : text.replace(/\n*$/, '\n\n') + HUB_SECTION + '\n\n' + line + '\n';
  atomicWrite(file, text);
  return file;
}

// 新建一条共享记忆。返回 {file, index}；dryRun 时只算出要写的内容。
function addEntry({ dir, text, origin = 'memory', source = 'Hub 前台', title = '', now = Date.now(), dryRun = false, history = null }) {
  const clean = String(text || '').replace(/\r/g, '').trim();
  if (!clean) throw new Error('内容不能为空');
  if (SECRET_RE.test(clean)) throw new Error('内容疑似包含密钥或密码，未写入；记忆里不保存任何凭据');
  const day = today(now), name = slugFor(clean, day), file = path.join(dir, name + '.md');
  const type = typeFor(clean, origin), index = categoryFor(clean);
  const desc = describe(title || clean);
  const body = `---\nname: ${name}\ndescription: ${desc.replace(/\n/g, ' ')}\nmetadata:\n  type: ${type}\n---\n\n${clean}\n\n来源：${source}（${day} 记入共享记忆）。\n`;
  const line = `- [${describe(title || clean, 24)}](${name}.md) — ${desc}`;
  // 对最终落盘的全文（frontmatter + 正文 + 来源）和索引行做检查：source、title 等调用方拼进来的字段也可能夹带密钥。
  assertNoSecret(body + '\n' + line);
  if (dryRun) return { file, index, type, name, body, line };
  if (fs.existsSync(file)) return { file, index, type, name, unchanged: true };
  if (history) backupIndex(dir, index, history, now);
  atomicWrite(file, body);
  registerIndex(dir, index, line);
  return { file, index, type, name };
}
// 合并：把一句补充追加到已有条目末尾（不改原文），用于与共享库已有条目重复的 Hub 条目。
function mergeInto({ dir, target, text, source = 'Hub 前台', now = Date.now(), dryRun = false, history = null }) {
  const file = path.join(dir, target);
  const clean = String(text || '').trim();
  if (SECRET_RE.test(clean)) throw new Error('内容疑似包含密钥或密码，未写入');
  const add = `\n- 补充（${source}，${today(now)}）：${clean}\n`;
  assertNoSecret(add); // source 也会落盘，对整行检查
  if (dryRun) return { file, add };
  const before = fs.readFileSync(file, 'utf8');
  if (before.includes(clean)) return { file, unchanged: true };
  if (history) { fs.mkdirSync(history, { recursive: true }); fs.writeFileSync(path.join(history, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-shared-${target}`), before, 'utf8'); }
  atomicWrite(file, before.replace(/\n*$/, '\n') + add);
  return { file };
}
function backupIndex(dir, index, history, now) {
  try {
    fs.mkdirSync(history, { recursive: true });
    const src = path.join(dir, index);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(history, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-shared-${index}`));
  } catch {}
}
// 读共享库里已有条目（供去重）：文件名、描述和正文前 600 字。
function loadEntries(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md' && !f.startsWith('index-') && f !== 'archive_index.md').map(f => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const meta = frontmatter(text);
    return { file: f, description: meta.description || '', type: meta.type || '', body: text.replace(/^---[\s\S]*?---/, '').slice(0, 600) };
  });
}

module.exports = { addEntry, mergeInto, loadEntries, categoryFor, typeFor, registerIndex, HUB_SECTION, today };
