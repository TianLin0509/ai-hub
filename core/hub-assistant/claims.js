'use strict';
// 认领表（2026-11-18 前台纯派活）：每个会话的事件该送给谁。
//   - 组队成员 → owner 是它的组队负责人会话，从 Hub 组队数据现查（getTeams），不另存副本；
// 成员优先于登记：一个会话被前台派过活、后来又被拉进别人的团队，它的动静该给那位组队负责人。
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../atomic-write');

class Claims {
  constructor({ dir, getTeams = () => [], getSession = () => null, now = Date.now } = {}) {
    if (!dir) throw new Error('认领表缺少数据目录');
    this.file = path.join(dir, 'claims.json');
    this.getTeams = getTeams; this.getSession = getSession; this.now = now;
    this.rows = null;
  }
  load() {
    if (this.rows) return this.rows;
    // 只有文件不存在才当空表。其他读错误（EBUSY、权限）不缓存，直接抛给调用方，免得下一次 save 用空表覆盖整份文件；
    // 坏 JSON 先备份成 claims.json.bad-<时间> 再从空表开始（2026-11-18 独立审查）。
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') { this.rows = {}; return this.rows; } throw error; }
    let raw;
    try { raw = JSON.parse(text); }
    catch {
      const bad = `${this.file}.bad-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`;
      try { fs.copyFileSync(this.file, bad); } catch (error) { throw new Error(`认领表损坏且备份失败，未重置：${error.message}`); }
      console.warn('[claims] 认领表 JSON 损坏，已备份到', bad);
      raw = null;
    }
    this.rows = raw && raw.leads && typeof raw.leads === 'object' ? raw.leads : {};
    return this.rows;
  }
  // 只读查询用：读失败（文件被占用等）这一次按查不到算，不缓存、不抛，下次再读；写入路径（claim/release）仍用 load，读不到就抛错不写。
  peek() {
    try { return this.load(); } catch (error) { console.warn('[claims] 读取失败，本次按查不到算：', error.message); return {}; }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(fs, this.file, JSON.stringify({ version: 1, leads: this.rows }, null, 2));
  }
  teams() { try { return this.getTeams() || []; } catch { return []; } }
  memberOf(sessionId) {
    for (const team of this.teams()) {
      const m = (team.members || []).find(x => x.sid === sessionId);
      if (m && team.leadSid && team.leadSid !== sessionId) return { team, member: m };
    }
    return null;
  }
  get(sessionId) {
    if (!sessionId) return null;
    const hit = this.memberOf(sessionId);
    if (hit) return { sessionId, role: 'member', owner: hit.team.leadSid, title: hit.member.title || hit.member.memberId || '', by: 'team', at: hit.team.createdAt || 0 };
    const row = this.peek()[sessionId];
    return row ? { sessionId, role: 'lead', owner: 'front', title: row.title || '', by: row.by || 'dispatch', at: row.at || 0 } : null;
  }
  ownerOf(sessionId) { return this.get(sessionId)?.owner ?? null; }
  isFrontLead(sessionId) { return this.ownerOf(sessionId) === 'front'; }
  leads() { return Object.keys(this.peek()).map(id => this.get(id)).filter(x => x && x.role === 'lead'); }
  // 登记成负责人。重复登记只更新标题，保留第一次的来源和时间（派出后再追加不改「谁派的」）。
  claim(sessionId, { title, by = 'dispatch' } = {}) {
    if (!sessionId || typeof sessionId !== 'string') throw new Error('缺少会话编号');
    if (!['dispatch', 'adopt'].includes(by)) throw new Error("by 只能是 dispatch 或 adopt");
    const rows = this.load(), old = rows[sessionId];
    const name = String(title || this.getSession(sessionId)?.title || old?.title || '').slice(0, 80);
    if (old && (old.title === name || !title)) return this.get(sessionId);
    rows[sessionId] = old ? { ...old, title: name } : { title: name, by, at: this.now() };
    this.save();
    return this.get(sessionId);
  }
  release(sessionId) {
    const rows = this.load();
    if (!rows[sessionId]) return { ok: true, released: false };
    delete rows[sessionId]; this.save();
    return { ok: true, released: true };
  }
}

module.exports = { Claims };
