'use strict';
// 长批次标题是「【团队消息 · N 条 · 原文已存文件】」，正文每行「- 消息编号 · 发送方 · 类型 · N 字」。
const HEADER = /^【团队消息 · \d+ 条(?: · [^】\n]*)?】\s*\n/;
const SENDER = /^- \[([^\]\n]+)\]/gm;
// 2026-11-22 起长编号换成短号：「- #12 m1 前端 · 留言 · 340 字」；旧格式「- msg-xxx · m1 前端 · …」照认。
const FILE_SENDER = /^- (?:msg-[\w-]+ · |#\d+ )([^·\n]+?) · /gm;
const SKILL_NOTE = /^组队 skill 已更新到 v[\d.]+：[^\n]*\n/;
function normalize(text) { return String(text || '').trimStart().replace(SKILL_NOTE, ''); }
const GLASSES = /(?!)/;
const SYSTEM = /^【([^】\n，]+)，不是用户原话】/;
// 摘要跳过写给模型看的固定说明句，只留事情本身。
const SYSTEM_PREAMBLE = /^(以下事项|下面的异常|下面是你负责的|你知道即可|请你|用一两句话)/;
function systemSummary(value) {
  const m = value.match(SYSTEM);
  if (!m) return null;
  const label = m[1].trim();
  const lines = value.split('\n');
  const head = lines[0].slice(m[0].length).trim();
  const lead = head.match(/^负责人「([^」]+)」/);
  const rest = lines.slice(1).map(l => l.replace(/^[·\-\s]+/, '').trim()).filter(l => l && !/^-{3,}$/.test(l));
  const first = (lead ? rest[0] : [head, ...rest].find(l => l && !SYSTEM_PREAMBLE.test(l))) || '';
  return { kind: 'system', label, summary: clip([label, lead ? '「' + lead[1] + '」' : '', first].filter(Boolean).join(' · ')) };
}

// - 会话互发：core/hub-cli/service.js tagMessage「【来自会话 标题（短编号）】这条消息由另一个 Hub 会话经 hub 命令发来…」
// - 回复提醒（--watch）「【Hub 回复提醒】你关注的会话「标题」（短编号）回复了：」；送达失败与编排派活「【Hub 通知】」
// - 前台派工「【任务 T-…｜来自前台】标题」「【前台相关并行派工】」（core/hub-assistant）
// - 组队里 Hub 单发的「【组队说明 · 来自 Hub】」「【负责人登记 · 来自 Hub】」「【回到队里 · 新任务】」「【赛马结果 · 计划 …】」
const PEER = /^【来自会话 ([^\n]*?)（([0-9a-zA-Z-]{1,12})）】/;
const PEER_PREAMBLE = /^这条消息由另一个 Hub 会话经 hub 命令发来，不是用户本人。[^\n]*/;
// 会话标题里可能自带「」（如「修复「复制」按钮」），按最后的「」（短编号）回复了」定界。
const WATCH = /^【Hub 回复提醒】你关注的会话「([^\n]*?)」（([0-9a-zA-Z-]{1,12})）回复了[：:]?/;
const HUB_NOTICE = /^【Hub 通知】/;
// 前台新建任务（core/hub-assistant/dispatch.js leadPrompt）：开头就是任务正文，末尾另起一段追加「【负责人守则】你是这件活的负责人…」。
const LEAD_RULES = /\n【负责人守则】你是这件活的负责人/;
const FRONT = /^【(?:任务 ([^】｜|\n]+)[｜|]来自前台|前台相关并行派工)】/;
const HUB_TEAM = /^【(组队说明 · 来自 Hub|负责人登记 · 来自 Hub|回到队里 · 新任务|赛马结果 · 计划 [^】\n]+)】/;
const CHANNEL = /(?!)/;
// 一句话结论：有「📌」结论行就用它；否则取第一句正文（小标题只在没有正文时兜底）。去掉 📌、加粗、标题与列表符号，跳过分隔线。
function firstLine(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(l => l && !/^[-=]{3,}$/.test(l));
  const pick = lines.find(l => l.includes('📌')) || lines.find(l => !/^#+\s/.test(l)) || lines[0] || '';
  return pick.replace(/^(?:#+\s*|[-·*]\s+|>\s*)/, '').replace(/📌\s*/g, '').replace(/\*\*/g, '').trim();
}
// 返回 { kind, summary, from }，认不出返回 null。from 是发送方短名字，卡片署名和摘要行都用它。
function relaySummary(value) {
  let m;
  if ((m = value.match(PEER))) {
    const title = m[1].trim() || '未命名会话';
    const rest = value.slice(m[0].length).replace(PEER_PREAMBLE, '');
    return { kind: 'peer', from: `「${title}」`, summary: clip(firstLine(rest) || '（空消息）') };
  }
  if ((m = value.match(WATCH))) {
    const who = m[1].trim() ? `「${m[1].trim()}」` : `会话 ${m[2]}`;
    return { kind: 'watch', from: who, summary: clip('回复提醒 · ' + (firstLine(value.slice(m[0].length)) || '有新回复')) };
  }
  if (HUB_NOTICE.test(value)) return { kind: 'hub', from: 'Hub', summary: clip('Hub 通知 · ' + (firstLine(value.replace(HUB_NOTICE, '')) || '通知')) };
  if ((m = value.match(FRONT))) {
    const rest = firstLine(value.slice(m[0].length));
    return { kind: 'front', from: '前台', summary: clip('前台派工 · ' + (m[1] ? m[1].trim() + ' · ' : '') + (rest || '新任务')) };
  }
  if ((m = value.match(LEAD_RULES))) return { kind: 'front', from: '前台', summary: clip('前台派工 · ' + (firstLine(value.slice(0, m.index)) || '新任务')) };
  if ((m = value.match(HUB_TEAM)) || (m = value.match(CHANNEL))) {
    const rest = firstLine(value.slice(m[0].length));
    return { kind: 'hub', from: 'Hub', summary: clip(m[1] + (rest ? ' · ' + rest : '')) };
  }
  return null;
}

function teamNoticeSender(text) {
  const value = normalize(text);
  if (GLASSES.test(value) || SYSTEM.test(value)) return { label: 'Hub', names: ['Hub'], onlyHub: true };
  const relay = relaySummary(value);
  if (relay) return relay.from === 'Hub' ? { label: 'Hub', names: ['Hub'], onlyHub: true } : { label: relay.from, names: [relay.from], onlyHub: false, relay: true };
  if (!HEADER.test(value)) return null;
  const names = [];
  for (const match of [...value.matchAll(SENDER), ...value.matchAll(FILE_SENDER)]) {
    const name = match[1].replace(/\s*·\s*留言$/, '').trim();
    // 2026-11-22 起同一批里成员标题只写第一次（后面只写 m2）：按编号去重，保留带标题的全名。
    const key = name.split(/\s+/)[0], at = names.findIndex(n => n.split(/\s+/)[0] === key);
    if (!name) continue;
    if (at < 0) names.push(name); else if (name.length > names[at].length) names[at] = name;
  }
  if (!names.length) return null;
  // 一批来自同一人显示全名（如「m1 burst-A-AV机理」）；多人时只列编号，避免名字过长。
  const label = names.length === 1 ? names[0] : names.map(name => name.split(/\s+/)[0]).join('、');
  const onlyHub = names.every(name => name === 'Hub');
  return { label, names, onlyHub };
}

const KICKOFF = /^【组队开工 · 来自负责人】/;
function isTeamMessage(text) {
  const value = normalize(text);
  return HEADER.test(value) || KICKOFF.test(value) || GLASSES.test(value) || SYSTEM.test(value) || !!relaySummary(value);
}
const STAMP = /^- \[[^\]\n]+\]/;

function teamNoticeSummary(text) {
  const value = normalize(text);
  const glasses = value.match(GLASSES);
  if (glasses) {
    const first = (value.split('\n').find(line => /^- /.test(line)) || '').replace(/^- /, '').trim();
    return { kind: 'notice', summary: clip(first || '新进展') };
  }
  const system = systemSummary(value);
  if (system) return system;
  const relay = relaySummary(value);
  if (relay) return { kind: relay.kind, summary: relay.summary };
  if (KICKOFF.test(value)) return { kind: 'kickoff', summary: clip('组队开工：' + value.split('\n')[0].replace(KICKOFF, '')) };
  const head = value.match(/^【团队消息 · (\d+) 条(?: · [^】\n]*)?】/);
  if (!head) return null;
  const lines = value.split('\n').slice(1);
  const count = Number(head[1]);
  if (/原文已存文件】$/.test(head[0])) {
    const item = (lines.find(line => /^- (?:msg-|#\d|\[)/.test(line)) || '').replace(/^- (?:msg-[\w-]+ · |#\d+ )/, '').trim();
    return { kind: 'notice', summary: clip(`${count} 条 · 原文已存文件` + (item ? ' · ' + item : '')) };
  }
  const at = lines.findIndex(line => STAMP.test(line));
  const first = at < 0 ? '' : (lines.slice(at + 1).find(line => line.trim()) || '').trim();
  return { kind: 'notice', summary: clip((count > 1 ? `${count} 条 · ` : '') + (first || '团队消息')) };
}
function clip(s) { const v = s.replace(/\s+/g, ' ').trim(); return v.length > 160 ? v.slice(0, 160) + '…' : v; }

module.exports = { teamNoticeSender, isTeamMessage, teamNoticeSummary };
