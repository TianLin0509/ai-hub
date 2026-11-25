'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
// Hub 内部登记簿：工具只能引用 group id，不能提交授权人、凭据或成员记录。
class TaskGroups {
  constructor(dataDir, { ttlMs, now } = {}) {
    this.ttlMs = Number(ttlMs) > 0 ? Number(ttlMs) : require('./dispatch').GRANT_TTL_MS;
    this.now = typeof now === 'function' ? now : Date.now;
    this.file = path.join(dataDir, 'assistant', 'task-groups.json');
    this.state = { version: 1, groups: [] };
    if (fs.existsSync(this.file)) this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8'); require('./atomic-rename').renameRetry(tmp, this.file);
  }
  get(id) { return this.state.groups.find(g => g.id === id) || null; }
  groupsForSession(sid) { return this.state.groups.filter(g => g.members.some(m => m.sessionId === sid)).map(g => g.id); }
  filterSessions(sessions, id) {
    if (!id) return sessions;
    const ids = new Set(this.get(id)?.members.map(m => m.sessionId) || []);
    return sessions.filter(s => ids.has(s.id));
  }
  // 仅由通过 requireManagerCaller 的前台派工入口调用；参数均来自 Hub 当前绑定。
  registerDispatch({ group, goal, sessionId, originSessionId, issuerSessionId, requestId, role = '成员', expiresAt }) {
    if (!issuerSessionId || !requestId || !sessionId) throw Error('任务组缺少可信派工身份');
    let record = group ? this.get(group) : null;
    if (group && !record) throw Error('任务组不存在');
    if (!record && originSessionId) record = this.get(this.groupsForSession(originSessionId)[0]);
    if (!record) record = this.get(this.groupsForSession(sessionId)[0]);
    if (!record) {
      record = { id: randomUUID(), goal: String(goal || '').slice(0, 500), createdAt: Date.now(), members: [] };
      this.state.groups.push(record);
    }
    const add = (sid, memberRole, authorized) => {
      let m = record.members.find(m => m.sessionId === sid);
      if (!m) { m = { sessionId: sid, role: memberRole }; record.members.push(m); }
      // 每次前台派活都续期；继承来的授权沿用负责人当时的到期时间，不自行延长。
      const grantedAt = this.now();
      if (authorized) Object.assign(m, { role: m.role==='负责人'?'负责人':memberRole, authority: { issuerSessionId, requestId, grantedAt,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : grantedAt + this.ttlMs } });
    };
    if (originSessionId && originSessionId !== sessionId) add(originSessionId, '原会话', false);
    add(sessionId, role, true); this.save(); return record;
  }
  authorityFor(sid) {
    for (const group of this.state.groups) {
      const member = group.members.find(m => m.sessionId === sid && m.authority);
      if (!member) continue;
      // 旧记录没有 expiresAt，按 grantedAt + 有效期计算；过期即视为无授权（回到待批准）。
      const expiresAt = Number.isFinite(member.authority.expiresAt) ? member.authority.expiresAt : (member.authority.grantedAt || 0) + this.ttlMs;
      if (expiresAt > this.now()) return { groupId: group.id, ...member.authority, expiresAt };
    }
    return null;
  }
  inheritMember(leadSid, sessionId) {
    const grant = this.authorityFor(leadSid); if (!grant) return null;
    return this.registerDispatch({ group: grant.groupId, sessionId, goal: '', issuerSessionId: grant.issuerSessionId,
      requestId: grant.requestId, role: '成员', expiresAt: grant.expiresAt });
  }
}
module.exports = { TaskGroups };
