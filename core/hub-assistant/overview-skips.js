'use strict';
// 只影响弹窗显示，不动待定编号本身（编号照旧 7 天自然过期），所以随时可撤销。保留 90 天、最多 500 条。
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../atomic-write');

const KEEP_MS = 90 * 24 * 3600000; // 只清很久以前的；同一问 7 天没更新本来就会自动过期
const MAX_ROWS = 500;

class OverviewSkips {
  // inUse：弹窗最近一次汇总时还对得上现存问题的记录键；这些记录不受 90 天 / 500 条清理（复验建议 8）。
  constructor(dir, { now = Date.now } = {}) { this.file = path.join(dir, 'overview-skips.json'); this.now = now; this.inUse = new Set(); }
  // 只有文件不存在才当空表；读错误抛给调用方，免得用空表把整份覆盖掉。坏 JSON 先备份再从空表开始。
  load() {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    try { const raw = JSON.parse(text); if (Array.isArray(raw?.rows)) return raw.rows.filter(r => r && r.key && r.sessionId); throw new Error('rows 不是列表'); }
    catch {
      const bad = `${this.file}.bad-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`;
      try { fs.copyFileSync(this.file, bad); } catch (error) { throw new Error(`跳过记录损坏且备份失败，未重置：${error.message}`); }
      console.warn('[overview-skips] 跳过记录 JSON 损坏，已备份到', bad);
      this.recovered = bad;
      return [];
    }
  }
  // 只读：读失败这一次按没有跳过算。
  list() { try { return this.load(); } catch (error) { console.warn('[overview-skips] 读取失败，本次按没有跳过算：', error.message); return []; } }
  save(rows, fresh = new Set()) {
    const now = this.now();
    const keep = k => this.inUse.has(k) || fresh.has(k), live = rows.filter(r => keep(r.key));
    const rest = rows.filter(r => !keep(r.key) && now - (r.at || 0) < KEEP_MS).sort((a, b) => b.at - a.at).slice(0, Math.max(0, MAX_ROWS - live.length));
    const kept = [...live, ...rest].sort((a, b) => b.at - a.at);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(fs, this.file, JSON.stringify({ version: 1, rows: kept }, null, 2));
    this.recovered = null;
    return kept;
  }
  // rows：[{ key, kind, sessionId, title, question, recommendation }]；同 key 的旧记录被替换。
  add(rows) {
    const at = this.now(), keys = new Set(rows.map(r => r.key));
    return this.save([...this.load().filter(r => !keys.has(r.key)), ...rows.map(r => ({ ...r, at }))], keys);
  }
  // 还在用的记录续期（改 at），内容不变。
  touch(keys) { const k = new Set(keys), at = this.now(); return this.save(this.load().map(r => k.has(r.key) ? { ...r, at } : r)); }
  remove(keys) { const k = new Set(keys); return this.save(this.load().filter(r => !k.has(r.key))); }
}

module.exports = { OverviewSkips };
