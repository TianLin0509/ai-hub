'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const RULES_CAP = 8 * 1024;
const MUST_READ_LIMIT = 25 * 1024;
const TIDY_RATIO = 0.65;
const TIDY_THRESHOLD = Math.floor(MUST_READ_LIMIT * TIDY_RATIO);
const TIDY_REPEAT_MS = 6 * 3600 * 1000;
// 已删除或改名的旧工具：守则和前台提示里不得再出现（单测断言）。
// 2026-11-18 前台纯派活：看画面、按键、停止、重启、换号、告警回报、读答复原文、健康明细从前台去掉。
const RETIRED_TOOLS = ['dispatch_to_assistant', 'message_assistant', 'list_tasks', 'read_screen', 'press_keys', 'stop_session', 'restart_session',
  'relay_session', 'remote_watch_status', 'ack_alert', 'session_evidence', 'session_health'];
const SECRET_RE = require('./memory').SECRET_RE;
const TEMPLATE_VERSION = 4;
// 也能升级到新模板，并把追加的约定原样接到新模板末尾；正文改过的保留原样。
const OLD_TEMPLATE_BODIES = new Set(['6346a0b23ca7fb7ea0bd5c7b05c2d3271ca8c1042cd9945a77135a265054e590']); // v3
const ADDED_HEADING = '## 用户追加的前台约定';

function sharedMemoryDir(env = process.env) {
  if (env.CLAUDE_HUB_SHARED_MEMORY_DIR) return path.resolve(env.CLAUDE_HUB_SHARED_MEMORY_DIR);
  try {
    const shared = require('../agent-user-context').claudeSharedConfig(env, env.CLAUDE_HUB_DATA_DIR);
    if (shared?.autoMemoryDirectory) return path.resolve(shared.autoMemoryDirectory);
  } catch {}
  return path.join(os.homedir(), '.claude', 'projects', os.homedir().replace(/[^A-Za-z0-9]/g, '-'), 'memory');
}

function defaultRulesText() {
  return `<!-- front-rules-template: ${TEMPLATE_VERSION} -->
# 前台守则

你是 AI Hub 的前台，是**纯派活人**。只做三件事：**听懂**用户要什么，**派给负责人**，**转述汇报**。
要读文件、查资料、写代码、跑命令的事，一律派出去，哪怕看起来简单。你直接回答的只有 Hub 状态、谁在忙、账号额度这类一句话能答清的问题。
派出去的会话就是这件活的负责人：它全权负责、干完交卷；它的卡住、失败等动静由 Hub 直接送给它自己处理。

## 说话
- 用用户使用的语言，先一句结论，不寒暄、不复述规则。时间按用户本机时区说。
- 负责人的数字、结论、路径照原文转述，不加工；你自己的判断单独标「我的判断」。

## 问进展
- 调一次 list_sessions（不带参数）拿看板，按「负责人 / 你自己开的 / 其余」三组，一人一行转述。
- 看板里的 ⚠ 是程序发现的矛盾，原样带上。
- 用户追问某个会话的细节：先 read_progress；没有就 send_session 转问负责人，回「已问某负责人，回了告诉你」。

## 交任务
<!-- section: dispatch -->
- 先判断三类，回执写一句“判为【追加任务/相关并行/无关新建】，派给【会话】”。拿不准关联时用 dispatch_candidates 查候选。
  1. 追加任务：send_session 交给原会话。
  2. 高度相关的并行任务：原会话空闲时 send_session 填 dispatchType=相关并行，由原会话当负责人组队（前台已代批）；原会话正忙时 create_session 填 dispatchType=相关并行、relatedSessionId=原会话 id。
  3. 无关任务：create_session 新开；scene 按话题，model/effort 按点名或档位，账号不点名时由 Hub 按规则挑（Pro 优先）。
- 派完只回一句「交给谁了」，必要时加一句做了什么假设，然后安静。
- 拿不准时按推荐假设先派；只有猜错会白做的才问，最多一问。
- 前台本轮明确委托的任务默认批准；删数据、对外发布、明显花钱仍遵守全局规则。

## 转述负责人
- 收到「【负责人交卷，不是用户原话】」：用「✅ 某负责人交卷：一句结论；产物路径；要你定什么」转告，末尾写「原文在侧栏会话『会话名』」，会话名只用交卷消息里给出的；不写链接，不编网址。
- 收到「【负责人请用户拍板，不是用户原话】」：同样一两句转告要定的事，并给出负责人的推荐。
- Hub 发来的「【知会】」类短消息，用户问起时再提。

## 收编
- 用户说「这个交给你管」：用 claim_session 把那个会话登记成负责人，回一句「已收编：某会话」。

## 记忆
- 共享记忆目录（Claude auto memory）是所有会话共用的正本：用户说「记住……」，或明确表态、反复体现的偏好和长期约定，按目录里的格式记（一事一文件，带 frontmatter；在对应分类索引登记一行）。一次性任务、实时进展、任何密钥不记。
- 只有你能写这个目录，其他位置你都只读。写入会自动备份、拦截密钥并通知用户。
- 用户说「以后前台要……」这类只管前台的规则，用 update_front_rules 改本守则；对所有会话都有效的规则写进共享记忆。
- 收到「【记忆整理】」指令时，在这一轮先合并重复、删过时条目、把细节挪进主题文件，再回答用户。

## 其他
- 每日计划写 2–4 个宏观方向，重启、合入、按钮不单列；日稿和交接遵守本轮不派工边界。

${ADDED_HEADING}
`;
}

class FrontRules {
  constructor({ directory, env = process.env, notify = null } = {}) {
    if (!directory) throw new Error('前台守则需要数据目录');
    this.directory = directory;
    this.file = path.join(directory, 'front-rules.md');
    this.historyDir = path.join(directory, 'front-rules-history');
    this.hashFile = path.join(directory, 'front-rules.template-hash');
    this.env = env;
    this.notify = notify;
    fs.mkdirSync(this.historyDir, { recursive: true });
    this.ensure();
  }
  static hash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
  ensure() {
    const template = defaultRulesText();
    if (!fs.existsSync(this.file)) return this.writeRaw(template, { template: true });
    const current = fs.readFileSync(this.file, 'utf8');
    let recorded = ''; try { recorded = fs.readFileSync(this.hashFile, 'utf8').trim(); } catch {}
    const version = Number((/front-rules-template:\s*(\d+)/.exec(current) || [])[1] || 0);
    if (version >= TEMPLATE_VERSION) return this.file;
    if (recorded && recorded === FrontRules.hash(current)) return this.writeRaw(template, { template: true, backup: current });
    const normalized = current.replace(/\r\n/g, '\n'), at = normalized.indexOf(ADDED_HEADING);
    if (at >= 0 && OLD_TEMPLATE_BODIES.has(FrontRules.hash(normalized.slice(0, at)))) {
      const added = normalized.slice(at + ADDED_HEADING.length).replace(/^\n+/, '');
      if (!added.trim()) return this.writeRaw(template, { template: true, backup: current });
      return this.writeRaw(template.replace(/\n*$/, '\n') + added.replace(/\n*$/, '\n'), { backup: current });
    }
    return this.file;
  }
  writeRaw(text, { template = false, backup = null } = {}) {
    if (backup !== null) this.backup(backup);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    require('./atomic-rename').renameRetry(tmp, this.file);
    if (template) fs.writeFileSync(this.hashFile, FrontRules.hash(text), 'utf8');
    else { try { fs.unlinkSync(this.hashFile); } catch {} }
    return this.file;
  }
  backup(text, now = Date.now()) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(this.historyDir, `${stamp}-${Math.random().toString(36).slice(2, 7)}-front-rules.md`), text, 'utf8');
    const all = fs.readdirSync(this.historyDir).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 60))) { try { fs.unlinkSync(path.join(this.historyDir, old)); } catch {} }
  }
  read() { return fs.readFileSync(this.file, 'utf8'); }
  bytes() { return Buffer.byteLength(this.read(), 'utf8'); }
  update({ action, text = '', reason = '', now = Date.now() } = {}) {
    const clean = String(text).replace(/\r/g, '').trim();
    if (!['add', 'remove', 'rewrite'].includes(action)) throw new Error('action 只能是 add、remove 或 rewrite');
    if (!clean) throw new Error('内容不能为空');
    if (SECRET_RE.test(clean)) throw new Error('内容疑似包含密钥或密码，未写入守则');
    if (RETIRED_TOOLS.some(name => clean.includes(name))) throw new Error('守则里不能再写已删除的工具名：' + RETIRED_TOOLS.join('、'));
    const before = this.read();
    let after;
    if (action === 'add') {
      if (clean.includes('\n') || clean.length > 300) throw new Error('add 只写一句话（不超过 300 字）；整理多条请用 rewrite');
      if (before.includes(clean)) return { ok: true, unchanged: true, file: this.file };
      const d = new Date(now + 8 * 3600000), day = d.toISOString().slice(0, 10);
      const line = `- ${clean.replace(/[。.]\s*$/, '')}（${day}${reason ? '，' + String(reason).replace(/[\r\n]+/g, ' ').slice(0, 40) : ''}）`;
      after = before.includes(ADDED_HEADING) ? before.replace(/\n*$/, '\n') + line + '\n' : before.replace(/\n*$/, '\n\n') + ADDED_HEADING + '\n' + line + '\n';
    } else if (action === 'remove') {
      const hits = before.split('\n').filter(line => line.startsWith('- ') && line.includes(clean));
      if (hits.length !== 1) throw new Error(hits.length ? `匹配到 ${hits.length} 条，请给出更具体的原文片段` : '没有找到包含这段文字的条目');
      after = before.split('\n').filter(line => line !== hits[0]).join('\n');
    } else after = clean + '\n';
    const size = Buffer.byteLength(after, 'utf8');
    if (size > RULES_CAP) throw new Error(`前台守则将达 ${size} 字节，超过 ${RULES_CAP} 字节上限；先用 rewrite 合并精简，或把对所有会话都有效的条目移到共享记忆`);
    this.backup(before, now);
    this.writeRaw(after);
    const summary = action === 'add' ? clean : action === 'remove' ? '删除：' + clean : '整理了整份守则';
    try { this.notify?.({ action, text: summary.slice(0, 200) }); } catch {}
    return { ok: true, file: this.file, bytes: size, cap: RULES_CAP, appliesTo: '下次前台启动（重开或换号）时生效；本轮你已知道' };
  }
}

// 「每轮必读部分」的字节数：共享 MEMORY.md 的前 25 KB（CLI 只加载这么多）+ 前台守则。
function mustReadBytes({ rules, memoryDir }) {
  let memory = 0;
  try { memory = Math.min(fs.statSync(path.join(memoryDir, 'MEMORY.md')).size, MUST_READ_LIMIT); } catch {}
  const front = rules ? rules.bytes() : 0;
  return { memory, rules: front, total: memory + front, threshold: TIDY_THRESHOLD, limit: MUST_READ_LIMIT };
}
const AUTOMATED_ID = /^(daily|handoff|checkpoint|review|alert|health|system|auto|remote|reminder)[-:]/i;
function isPersonalRequest(request) {
  if (!request || request.origin === 'system' || request.automated === true) return false;
  return !AUTOMATED_ID.test(String(request.clientSubmissionId || request.requestId || ''));
}
function tidyInstruction({ sizes, personal, lastPromptAt = 0, now = Date.now() }) {
  if (!personal || !sizes || sizes.total < sizes.threshold) return null;
  if (now - lastPromptAt < TIDY_REPEAT_MS) return null;
  const kb = n => (n / 1024).toFixed(1) + ' KB';
  return `【记忆整理】每轮必读部分已到 ${kb(sizes.total)}（共享 MEMORY.md ${kb(sizes.memory)} + 前台守则 ${kb(sizes.rules)}），超过 ${kb(sizes.threshold)} 的整理线。`
    + '本轮先整理再答：共享 MEMORY.md 只留一行一条的入口，细节挪进主题文件，合并重复、删除过时；守则里对所有会话都有效的条目移到共享记忆。整理完用一句话告诉用户前后大小。';
}

module.exports = { FrontRules, defaultRulesText, sharedMemoryDir, mustReadBytes, tidyInstruction, isPersonalRequest,
  RULES_CAP, MUST_READ_LIMIT, TIDY_THRESHOLD, TIDY_REPEAT_MS, RETIRED_TOOLS, TEMPLATE_VERSION, OLD_TEMPLATE_BODIES };
