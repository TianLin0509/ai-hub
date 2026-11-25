'use strict';
// 负责人组队的命令行入口（2026-11-01）。在 Hub 会话里运行：身份、端口、令牌都从会话环境变量读，
// 不需要额外配置。用法：
//   hub-team status
//   hub-team accounts
//   accounts 返回 claude.rows / codex.rows / gemini.rows，以及 otherKinds（其余后端的默认模型，不点名账号）。
//   kind 可写 Hub 全部后端：claude / codex / gemini（Antigravity，也可写 antigravity 或 agy）/ qwen / glm / kimi / deepseek-acp / deepseek-claude / deepseek；codeagent 仅公司版。
//   account 只对 claude / codex / gemini 有效：留空跟随 Hub 默认账号，也可写「账号2」；其余后端写 account 会报错，沿用 Hub 新建会话的默认配置。
//   自动批准没成时计划当场作废（侧栏不留待批单），命令非零退出并给原因与下一步；10 分钟内重交成员完全相同的计划只回原结果、不重复招人。
//   hub-team propose --plan-file 计划.json        计划：{"goal":"…","members":[{"role":"…","task":"…","kind":"claude","account":"…","cwd":"…","title":"…"}]}
//   赛马：{"goal":"…","race":true,"task":"所有参赛者做的同一道题","members":[{"kind":"claude","account":"账号2","model":"claude-opus-5-5","effort":"high"},{"kind":"gemini","account":"账号2","model":"gemini-4-neon-high"},{"kind":"codex"}]}（每位都是侧栏成员会话；交齐后 Hub 出成绩单，只叫醒负责人一次）
//   hub-team send --to lead|m1 --message "…" [--wake] [--interrupt]
//   hub-team send --to lead --deliver --message "…"   成员交付：负责人收到并处理完后 Hub 让成员离队休眠
//   hub-team send --to m1 --message-file 消息.md
//   hub-team read --id 12（短号只写数字；或 msg-xxx 长编号） 读取完整原文；仅本队负责人和消息参与者可读
//   hub-team allow --a m1 --b m2 [--off] [--reason "…"]
//   hub-team pass --to m1     负责人放行该成员最近被权限守卫拦下的那一条命令（30 分钟内原样重试一次有效）
//   hub-team restart --member m1
//   hub-team dismiss --member m1
const fs = require('node:fs');
const http = require('node:http');

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2), next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
const readUtf8 = file => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');

function buildRequest(argv) {
  const opt = parse(argv), action = opt._[0];
  switch (action) {
    case 'status': case 'accounts': return { action, args: {} };
    case 'propose': {
      if (!opt['plan-file']) throw Error('用法：propose --plan-file 计划.json');
      return { action, args: JSON.parse(readUtf8(opt['plan-file'])) };
    }
    case 'send': {
      const message = opt['message-file'] ? readUtf8(opt['message-file']) : opt.message;
      if (!opt.to || typeof message !== 'string') throw Error('用法：send --to lead|m1 --message "…"（或 --message-file 文件）[--wake] [--interrupt] [--deliver]');
      return { action, args: { to: String(opt.to), message, ...(opt.wake ? { wake: true } : opt['no-wake'] ? { wake: false } : {}), interrupt: !!opt.interrupt, ...(opt.deliver ? { deliver: true } : {}) } };
    }
    case 'read': {
      if (typeof opt.id !== 'string' || !opt.id.trim()) throw Error('用法：read --id <#短号或 msg- 长编号>');
      return { action, args: { messageId: opt.id } };
    }
    case 'allow': return { action, args: { memberA: String(opt.a || ''), memberB: String(opt.b || ''), allow: !opt.off, reason: opt.reason ? String(opt.reason) : '' } };
    case 'pass': {
      if (typeof opt.to !== 'string' || !opt.to.trim()) throw Error('用法：pass --to <成员编号>（放行该成员最近被拦的那一条命令，30 分钟内原样重试一次有效）');
      return { action, args: { to: opt.to.trim() } };
    }
    case 'restart': case 'dismiss': return { action, args: { memberId: String(opt.member || '') } };
    default: throw Error('动作：status / accounts / propose / send / read / allow / pass / restart / dismiss');
  }
}

// options 供 hub 命令（scripts/hub.js）复用：换路径 /api/hub、放宽超时、超时提示带重试键。
function post(body, env = process.env, { path = '/api/team', timeoutMs = 30000, timeoutHint = '' } = {}) {
  const port = Number(env.CLAUDE_HUB_PORT), token = env.CLAUDE_HUB_TOKEN, sessionId = env.CLAUDE_HUB_SESSION_ID;
  if (!port || !token || !sessionId) return Promise.reject(Error('没找到 Hub 会话环境变量（CLAUDE_HUB_PORT / CLAUDE_HUB_TOKEN / CLAUDE_HUB_SESSION_ID）；这个命令只能在 Hub 里的会话中运行'));
  const teamToken = env.CLAUDE_HUB_TEAM_TOKEN;
  if (!teamToken) return Promise.reject(Error('当前会话启动于旧版 Hub，重启该会话后可用'));
  const data = Buffer.from(JSON.stringify({ ...body, token, sessionId, teamToken }), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(deadline);
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
        if (res.statusCode === 200) resolve(parsed.result);
        else reject(Error(parsed.error || `Hub 返回 ${res.statusCode}`));
      });
    });
    const deadline = setTimeout(() => {
      const error = Error(`Hub 没在 ${Math.round(timeoutMs / 1000)} 秒内回应，` + (timeoutHint || '结果未知：先用 status 核对，别直接重发'));
      reject(error);
      req.destroy(error);
    }, timeoutMs);
    req.on('error', error => { clearTimeout(deadline); reject(Error('连不上 Hub：' + error.message)); });
    req.end(data);
  });
}

async function main(argv) {
  const result = await post(buildRequest(argv));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { buildRequest, post, parse };
