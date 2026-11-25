'use strict';
// 前台写共享记忆的保护钩子（2026-11-15 前台一期）。前台以 bypassPermissions 运行，写范围只能靠钩子收口：
//   pre  （PreToolUse，Write|Edit|MultiEdit|NotebookEdit）：目标不在共享记忆目录 → 拒绝；新内容疑似密钥 → 拒绝；
//         否则把原文件备份进 Hub 记忆的 history 目录（与原 update_memory 共用，保留 60 份），记下待核对的备份。
//   post （PostToolUse，同上）：再扫一遍写完的文件，疑似密钥就用备份回滚（新文件直接删除）并告诉前台；
// 只用 Node 自带模块；读 stdin 的 hook JSON，不执行任何外部命令。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SECRET_RE } = require('../core/hub-assistant/memory');

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const KEEP = 60;

function arg(name, argv = process.argv) { const i = argv.indexOf('--' + name); return i > 0 ? argv[i + 1] : ''; }
function norm(p) { return path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase(); }
// 真实路径：沿父目录往上找到第一个已存在的祖先，用 realpath 解开其中的符号链接 / junction，再接回尚不存在的尾段。
// 目标文件本身是链接时也会被解开。这样「共享目录里放一个指向别处的链接」无法把写入带出共享目录。
function realPath(p) {
  let cur = path.resolve(String(p || '')); const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...tail); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...tail);
      tail.unshift(path.basename(cur)); cur = parent;
    }
  }
}
// 共享目录以下（不含共享目录本身）每一段路径用 lstat 查：只要有一段是符号链接或 junction（含目标不存在的悬空链接），就算越界。
// 悬空链接 realpath 解不开、会被当成「尚不存在的路径」放过，所以必须单独用 lstat 拦。
function linkBelow(file, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  if (!rel) return false;
  let cur = path.resolve(dir);
  for (const part of rel.split(/[\\/]+/)) {
    cur = path.join(cur, part);
    let st; try { st = fs.lstatSync(cur); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
    if (st.isSymbolicLink()) return true;
  }
  return false;
}
// 大小写不敏感比较（Windows 盘符与目录名不区分大小写）；字面路径与真实路径都要落在共享目录真实路径之内，且共享目录以下不经过任何链接。
function inside(file, dir) {
  if (!file || !dir) return false;
  const within = (f, d) => !!d && (f === d || f.startsWith(d + path.sep.toLowerCase()) || f.startsWith(d + '/'));
  let realFile, realDir;
  try { realFile = norm(realPath(file)); realDir = norm(realPath(dir)); } catch { return false; }
  if (!within(norm(file), norm(dir)) || !within(realFile, realDir)) return false;
  try { return !linkBelow(file, dir); } catch { return false; }
}
// 按本次调用的入参推算「这次写完后文件应有的全文」：Write 取 content；Edit / MultiEdit 在写前备份上依次替换。
// 推算不出（NotebookEdit、找不到 old_string、写前备份缺失）返回 null。换行统一成 \n、去掉 BOM 后再比。
const BOM = String.fromCharCode(0xfeff);
const canon = t => { const s = String(t).split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)); return s.startsWith(BOM) ? s.slice(1) : s; };
function expectedText(event, pending) {
  const input = event.tool_input || {};
  if (event.tool_name === 'Write') return typeof input.content === 'string' ? canon(input.content) : null;
  if (event.tool_name !== 'Edit' && event.tool_name !== 'MultiEdit') return null;
  let text;
  if (pending.backup) { try { text = canon(fs.readFileSync(pending.backup, 'utf8')); } catch { return null; } }
  else if (pending.existed === false) text = '';
  else return null;
  const edits = event.tool_name === 'Edit' ? [input] : (Array.isArray(input.edits) ? input.edits : []);
  if (!edits.length) return null;
  for (const e of edits) {
    if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') return null;
    const from = canon(e.old_string), to = canon(e.new_string);
    if (from === '') { if (text !== '') return null; text = to; continue; }
    if (!text.includes(from)) return null;
    text = e.replace_all ? text.split(from).join(to) : text.replace(from, () => to);
  }
  return text;
}
function targetOf(input) { return input?.file_path || input?.notebook_path || input?.path || ''; }
function newText(input) {
  if (!input) return '';
  return [input.content, input.new_string, input.new_source, ...(Array.isArray(input.edits) ? input.edits.map(e => e?.new_string) : [])]
    .filter(v => typeof v === 'string').join('\n');
}
// 回滚记录按工具调用单独存（tool_use_id），并发写同一文件时互不覆盖；没有调用 id 就不留记录（post 只告警、不删不回滚）。
function pendingFile(pendingDir, toolUseId) {
  if (!toolUseId) return '';
  return path.join(pendingDir, crypto.createHash('sha1').update(String(toolUseId)).digest('hex').slice(0, 20) + '.json');
}
const PENDING_TTL = 24 * 3600000;
function prunePending(dir, now) {
  for (const f of fs.readdirSync(dir)) { try { const p = path.join(dir, f); if (now - fs.statSync(p).mtimeMs > PENDING_TTL) fs.unlinkSync(p); } catch {} }
}
function prune(dir) {
  const all = fs.readdirSync(dir).filter(f => !f.startsWith('.')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) { try { fs.unlinkSync(path.join(dir, old)); } catch {} }
}
function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// 纯函数式的处理，便于单测：返回要写到 stdout 的对象（null 表示放行、不输出）。
function handlePre(event, { memoryDir, historyDir, now = Date.now() }) {
  if (!WRITE_TOOLS.has(event?.tool_name)) return null;
  const file = targetOf(event.tool_input);
  if (!memoryDir || !inside(file, memoryDir)) return deny('前台只能写共享记忆目录（' + memoryDir + '）；其他文件只读，要改文件请派给下级会话。');
  if (SECRET_RE.test(newText(event.tool_input))) return deny('内容疑似包含密钥或密码，未写入；记忆里不保存任何凭据。');
  const pendingDir = path.join(historyDir, '..', 'pending');
  fs.mkdirSync(historyDir, { recursive: true }); fs.mkdirSync(pendingDir, { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    backup = path.join(historyDir, `${stamp}-${Math.random().toString(36).slice(2, 7)}-shared-${path.basename(file)}`);
    fs.copyFileSync(file, backup);
    prune(historyDir);
  }
  const marker = pendingFile(pendingDir, event.tool_use_id);
  if (marker) fs.writeFileSync(marker, JSON.stringify({ file: realPath(file), existed: !!backup, backup, at: now }), 'utf8');
  prunePending(pendingDir, now);
  return null;
}

function handlePost(event, { memoryDir, historyDir }) {
  if (!WRITE_TOOLS.has(event?.tool_name)) return { output: null, notice: null };
  const file = targetOf(event.tool_input);
  if (!inside(file, memoryDir)) return { output: null, notice: null };
  const pendingDir = path.join(historyDir, '..', 'pending'), marker = pendingFile(pendingDir, event.tool_use_id);
  let pending = null; if (marker) { try { pending = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch {} try { fs.unlinkSync(marker); } catch {} }
  if (pending && norm(pending.file) !== norm(realPath(file))) pending = null; // 记录与本次目标不符，当作没有记录
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch {}
  if (SECRET_RE.test(text)) {
    // 只有本次调用自己的记录能证明「写前有备份」或「写前文件不存在」，且文件现在的全文正好等于本次写入的结果，才回滚或删除。
    // 全文对不上，说明写完之后别的写入又改过这个文件（并发），回滚会误伤别人的内容 → 只告警，不删不改。
    let how = 'none', why = 'no-record';
    if (pending) {
      const expected = expectedText(event, pending);
      if (expected === null) why = 'unverifiable';
      else if (expected !== canon(text)) why = 'changed';
      else if (pending.backup && fs.existsSync(pending.backup)) { fs.copyFileSync(pending.backup, file); how = 'restored'; }
      else if (pending.existed === false) { try { fs.unlinkSync(file); how = 'deleted'; } catch {} }
    }
    if (how === 'none') process.stderr.write('[front-memory-hook] 未做回滚（' + why + '）：' + file + '\n');
    const reason = how !== 'none'
      ? '写入的记忆疑似包含密钥或密码，已' + (how === 'restored' ? '回滚到写入前的版本' : '删除这个新文件') + '；记忆里不保存任何凭据，请去掉后重写。'
      : why === 'changed'
        ? '写入的记忆疑似包含密钥或密码；这个文件在本次写入后又被别的写入改过，为免误删别人的内容没有自动回滚，请立刻把其中的凭据删掉。记忆里不保存任何凭据。'
        : '写入的记忆疑似包含密钥或密码；找不到可核对的写前记录，没有自动回滚，请立刻把其中的凭据删掉。记忆里不保存任何凭据。';
    return { output: { decision: 'block', reason }, notice: { event: 'blocked', file, rollback: how, ...(how === 'none' ? { reason: why } : {}) } };
  }
  const meta = require('../core/hub-assistant/memory').frontmatter(text);
  return { output: null, notice: { event: 'written', file, tool: event.tool_name, created: pending ? !pending.existed : null,
    description: meta.description || meta.name || '', backup: pending?.backup || null } };
}

async function notify(notice, { endpointFile, sessionId }) {
  if (!notice || !endpointFile) return;
  try {
    const endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
    await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json', 'X-Hub-Assistant-Session': sessionId || '' },
      body: JSON.stringify({ name: 'memory_hook_event', arguments: notice }), signal: AbortSignal.timeout(4000) });
  } catch (error) { process.stderr.write('[front-memory-hook] 通知 Hub 失败：' + error.message + '\n'); }
}

async function main() {
  const mode = process.argv[2];
  const opts = { memoryDir: arg('memory-dir'), historyDir: arg('history'), endpointFile: arg('endpoint'), sessionId: arg('session') };
  let raw = ''; for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw || '{}');
  if (mode === 'pre') { const out = handlePre(event, opts); if (out) process.stdout.write(JSON.stringify(out)); return; }
  if (mode === 'post') {
    const { output, notice } = handlePost(event, opts);
    if (output) process.stdout.write(JSON.stringify(output));
    await notify(notice, opts);
  }
}
// pre 出错时按拒绝处理（退出码 2 = 阻止本次工具调用），宁可少写一次也不放过范围检查；post 出错不影响已写入。
if (require.main === module) main().catch(error => { process.stderr.write('[front-memory-hook] ' + error.message + '\n'); process.exit(process.argv[2] === 'pre' ? 2 : 0); });
module.exports = { handlePre, handlePost, inside, realPath, expectedText, WRITE_TOOLS };
