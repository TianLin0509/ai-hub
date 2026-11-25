'use strict';
// 后台任务快照（自动续跑 P0）：每个 Claude 会话最近一次回合结束（Stop hook）时还挂着的后台任务。
// Hub 重启或 CLI 被重开时，这些任务随旧进程一起没了；快照是「它在等东西」的唯一证据。
//
// 存储：每个会话一个文件 <数据目录>/auto-resume/sessions/<会话id>.json，原子写；每次都从磁盘读，不缓存整表。
// 同一个原生会话同时只有一个 Hub 写（会话独占），多开 Hub（生产 + 隔离/开发实例共用数据目录）各写各的会话，
// 不会互相抹掉（返工单 1 第 6 条：旧版整表缓存再覆盖写，会丢掉另一个 Hub 的快照）。
//
// 文件里两块：
//   snapshot：回合结束时在跑的后台任务；没有就为 null（后台任务全部结束后的下一次 Stop 自然清空）。
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../atomic-write');

const DONE = new Set(['completed', 'complete', 'done', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error', 'exited', 'finished']);
const KEEP_MS = 7 * 24 * 3600_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;

function liveTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter(t => t && typeof t === 'object' && !DONE.has(String(t.status || '').toLowerCase()))
    .slice(0, 8)
    .map(t => ({ id: String(t.id || '').slice(0, 120), type: String(t.type || '').slice(0, 80),
      status: String(t.status || '').slice(0, 40), description: String(t.description || '').slice(0, 160) }));
}

class SnapshotStore {
  constructor({ dataDir, now = Date.now, fsModule = fs } = {}) {
    if (!dataDir) throw new Error('快照缺少数据目录');
    this.dir = path.join(dataDir, 'auto-resume', 'sessions');
    this.now = now; this.fs = fsModule;
  }
  file(sessionId) {
    if (!SAFE_ID.test(String(sessionId || ''))) throw new Error('会话编号不合法');
    return path.join(this.dir, sessionId + '.json');
  }
  read(sessionId) {
    let raw = null;
    try { raw = JSON.parse(this.fs.readFileSync(this.file(sessionId), 'utf8')); } catch {}
    const rec = { snapshot: raw?.snapshot && Array.isArray(raw.snapshot.tasks) ? raw.snapshot : null, intent: raw?.intent || null };
    if (rec.snapshot && this.now() - (rec.snapshot.at || 0) > KEEP_MS) rec.snapshot = null;
    return rec;
  }
  write(sessionId, rec) {
    const file = this.file(sessionId);
    if (!rec.snapshot && !rec.intent) { try { this.fs.rmSync(file, { force: true }); } catch {} return; }
    this.fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.fs, file, JSON.stringify({ version: 2, snapshot: rec.snapshot, intent: rec.intent }));
  }
  update(sessionId, fn) { const rec = this.read(sessionId); const changed = fn(rec); if (changed !== false) this.write(sessionId, rec); return rec; }

  get(sessionId) { try { const s = this.read(sessionId).snapshot; return s ? { ...s, tasks: [...s.tasks] } : null; } catch { return null; } }
  intent(sessionId) { try { return this.read(sessionId).intent; } catch { return null; } }
  all() {
    let names = [];
    try { names = this.fs.readdirSync(this.dir); } catch { return []; }
    return names.filter(n => n.endsWith('.json')).map(n => this.get(n.slice(0, -5))).filter(Boolean);
  }

  // 回合结束：有在跑的后台任务就覆盖快照，没有就清掉。停止意图不动。返回新的快照或 null。
  recordStop({ sessionId, ccSessionId = null, tasks, turnId = null, hubPid = process.pid, cliGen = null, at = this.now() }) {
    if (!sessionId) return null;
    const live = liveTasks(tasks);
    const rec = this.update(sessionId, r => {
      if (!live.length && !r.snapshot) return false;
      r.snapshot = live.length ? { sessionId, ccSessionId, tasks: live, turnId, hubPid, cliGen, at } : null;
    });
    return rec.snapshot ? { ...rec.snapshot } : null;
  }
  // 在快照上补记一件事（只记第一次，避免每个按键都写盘）。
  mark(sessionId, field, value = this.now()) {
    let done = false;
    this.update(sessionId, r => { if (!r.snapshot || r.snapshot[field]) return false; r.snapshot[field] = value; done = true; });
    return done;
  }
  setIntent(sessionId, reason, at = this.now()) {
    this.update(sessionId, r => { if (r.intent && r.intent.reason === reason) return false; r.intent = { reason, at }; });
  }
  clearIntent(sessionId) { this.update(sessionId, r => { if (!r.intent) return false; r.intent = null; }); }
  drop(sessionId, expectedAt = null) {
    let done = false;
    this.update(sessionId, r => {
      if (!r.snapshot || (expectedAt != null && r.snapshot.at !== expectedAt)) return false;
      r.snapshot = null; done = true;
    });
    return done;
  }
  // Hub 启动时清掉超过 7 天的快照文件（读的时候只是看不见，文件还留着——返工单 2 第 6 条）；停止意图还在的只清快照、留意图。
  pruneExpired() {
    let names = [], removed = 0;
    try { names = this.fs.readdirSync(this.dir); } catch { return 0; }
    for (const name of names.filter(n => n.endsWith('.json'))) {
      const id = name.slice(0, -5);
      let raw = null;
      try { raw = JSON.parse(this.fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch {}
      if (!SAFE_ID.test(id)) continue;
      const expired = !raw || !raw.snapshot || this.now() - (raw.snapshot.at || 0) > KEEP_MS;
      if (!expired) continue;
      if (!raw?.snapshot && raw?.intent) continue;
      this.write(id, { snapshot: null, intent: raw?.intent || null }); removed++;
    }
    return removed;
  }
  forget(sessionId) { try { this.fs.rmSync(this.file(sessionId), { force: true }); } catch {} }
}

module.exports = { SnapshotStore, liveTasks };
