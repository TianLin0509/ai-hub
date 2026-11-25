'use strict';
// hub 命令（2026-11-22）：任意 Hub 会话都能开会话、点名模型账号、跨会话发话、读进展、等回复。
// 身份、端口、令牌从会话环境变量读（同 hub-team）。组队子命令原样转给 hub-team：hub team status 等同 hub-team status。
// 服务端在 core/hub-cli/service.js，走本机 /api/hub。
const fs = require('node:fs');
const crypto = require('node:crypto');
const teamCli = require('./hub-team');

const HELP = `hub —— Hub 会话命令（任何 Hub 会话可用；PowerShell 里前面加 &）
  hub sessions [--query 关键词] [--status running|idle|waiting|closed] [--all]
      列会话：编号、标题、后端、模型、状态、目录、负责人/成员。
  hub session new --kind <后端> --task "…"|--task-file 路径
      后端：claude / codex / gemini（Antigravity，也可写 antigravity 或 agy）/ qwen 千问 / glm 智谱 / kimi / deepseek-acp（DSH）/ deepseek-claude / deepseek；codeagent 仅公司版。--account 只对 claude / codex / gemini 有效。
      [--model id] [--effort 档] [--account 账号2] [--cwd 绝对目录] [--scene 场景] [--title 标题] [--watch] [--key 操作键]
      新建会话并下任务，自动挂到你的负责人项目下（你是成员时挂到你的负责人名下；不发组队说明、不占同时干活名额）；回执给会话编号和实际生效的后端、模型、账号。
  hub session send --to <编号|编号前8位|唯一标题|front> --message "…"|--message-file 路径 [--watch] [--key 操作键]
      给别的会话发话：对方正忙就排队，空闲后送达，不打断；休眠的会话会被恢复。消息开头自动带你的会话标记。
  hub session read --id <编号|标题> [--tail N]
      读它的进展卡（给用户看 / 当前状态）和最近 N 条回复。
  --watch  对方下一次回复后，Hub 把摘要作为一条消息送回你这个会话（24 小时内有效）。
  hub models [--kind claude]   各后端可选模型与思考深度（别凭记忆猜）。
  hub accounts                 各后端账号与额度。
  hub team <子命令…>            组队命令，等同 hub-team（status / propose / send / read / allow / pass / restart / dismiss）。
      成员权限：计划里成员写 "access":"read" 即只读档。5 类危险动作（推送/改写主干、成批杀进程或动生产 Hub、删任务目录外文件、改 Hub 生产配置、读用计费 API Key）
      只对 Claude 成员硬拦（拦下叫醒负责人）；Codex、Antigravity 等其余后端 Hub 拦不了，只靠任务书约束。负责人放行：hub team pass --to m1（最近被拦的一条，30 分钟内原样重试一次）。
护栏：
  - 防繁殖：经 hub 建出的会话最多到第 2 层（层数到 2 的不能再建）；每个会话每小时最多建 8 个（config hubCli 可调，按调用方各自计数）；组队招人同样受层数限制，层数到顶的会话不能当负责人招人，离队后层数照旧。
  - 发送方标记自动加；不能发给自己；Hub 内部会话（拍图助理、造梦等）不收。
  - 建会话、发消息都记进前台派工账本。
  - 不开放：关闭会话、切换账号、改 Hub 设置——这些找用户。
缺能力时：先看 hub help；确实没有，就向用户说明「Hub 缺 X 能力」，不要用后台命令行绕路起会话。
多行任务或消息写成文件用 --task-file / --message-file（hub.cmd 是批处理，换行后的内容会被截掉）。
结果不明（超时）时用同一个 --key 重试，不会重复建会话或重复发消息。`;

const readUtf8 = file => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
const text = (opt, inline, fileKey) => opt[fileKey] ? readUtf8(String(opt[fileKey])) : typeof opt[inline] === 'string' ? opt[inline] : undefined;

function buildRequest(argv) {
  const opt = teamCli.parse(argv), [a, b] = opt._;
  const key = typeof opt.key === 'string' ? opt.key : crypto.randomUUID();
  if (!a || a === 'help' || opt.help) return { help: true };
  if (a === 'team') return { team: teamCli.buildRequest(argv.slice(1)) };
  if (a === 'sessions') return { action: 'sessions', args: { query: typeof opt.query === 'string' ? opt.query : '', status: typeof opt.status === 'string' ? opt.status : '', all: !!opt.all } };
  if (a === 'models') return { action: 'models', args: { kind: typeof opt.kind === 'string' ? opt.kind : '' } };
  if (a === 'accounts') return { action: 'accounts', args: {} };
  if (a === 'session' && b === 'new') {
    const task = text(opt, 'task', 'task-file');
    if (typeof opt.kind !== 'string' || typeof task !== 'string' || !task.trim()) throw Error('用法：hub session new --kind claude|codex|gemini(antigravity/agy)|qwen|glm|kimi|deepseek-acp|… --task "…"（或 --task-file 文件）[--model] [--effort] [--account] [--cwd] [--scene] [--title] [--watch]');
    const args = { kind: opt.kind, task, operationKey: key, watch: !!opt.watch };
    for (const k of ['model', 'effort', 'account', 'cwd', 'scene', 'title']) if (typeof opt[k] === 'string') args[k] = opt[k];
    return { action: 'session-new', args, timeoutMs: 180000 };
  }
  if (a === 'session' && b === 'send') {
    const message = text(opt, 'message', 'message-file');
    if (typeof opt.to !== 'string' || typeof message !== 'string' || !message.trim()) throw Error('用法：hub session send --to <编号|唯一标题|front> --message "…"（或 --message-file 文件）[--watch]');
    return { action: 'session-send', args: { to: opt.to, message, operationKey: key, watch: !!opt.watch }, timeoutMs: 180000 };
  }
  if (a === 'session' && b === 'read') {
    if (typeof opt.id !== 'string' || !opt.id.trim()) throw Error('用法：hub session read --id <编号|标题> [--tail N]');
    return { action: 'session-read', args: { id: opt.id, tail: Number(opt.tail) || 1 } };
  }
  throw Error('未知子命令。hub help 看全部用法');
}

async function main(argv, { env = process.env, out = s => process.stdout.write(s), post = teamCli.post } = {}) {
  const req = buildRequest(argv);
  if (req.help) { out(HELP + '\n'); return; }
  const result = req.team ? await post(req.team, env) : await post({ action: req.action, args: req.args }, env, { path: '/api/hub', timeoutMs: req.timeoutMs,
    timeoutHint: req.args?.operationKey ? `结果未知：用同一个 --key ${req.args.operationKey} 重试，不会重复执行` : undefined });
  out(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { buildRequest, main, HELP };
