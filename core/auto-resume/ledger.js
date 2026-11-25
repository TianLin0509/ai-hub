'use strict';
// 自动续跑账本：<数据目录>/auto-resume-ledger.jsonl，每次「已续 / 需核对 / 未续 / 重试」追加一行。
// P1 的助理页「自动续跑」面板和回放核实读它。保留规则：只留近 30 天、最多 2000 行，启动和每 200 次追加整理一次。
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../atomic-write');

const KEEP_MS = 30 * 24 * 3600_000;
const MAX_ROWS = 2000;

class AutoResumeLedger {
  constructor({ dataDir, now = Date.now, keepMs = KEEP_MS, maxRows = MAX_ROWS } = {}) {
    if (!dataDir) throw new Error('账本缺少数据目录');
    this.file = path.join(dataDir, 'auto-resume-ledger.jsonl');
    Object.assign(this, { now, keepMs, maxRows });
    this.appends = 0;
  }
  append(event) {
    const row = { at: this.now(), ...event };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf8');
    if (++this.appends % 200 === 0) this.prune();
    return row;
  }
  read({ limit = 500 } = {}) {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const rows = [];
    for (const line of text.split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch {} }
    return rows.slice(-Math.max(1, limit));
  }
  prune() {
    const rows = this.read({ limit: Number.MAX_SAFE_INTEGER });
    const cutoff = this.now() - this.keepMs;
    const kept = rows.filter(r => (r.at || 0) >= cutoff).slice(-this.maxRows);
    if (kept.length === rows.length) return 0;
    writeFileAtomic(fs, this.file, kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
    return rows.length - kept.length;
  }
}

module.exports = { AutoResumeLedger };
