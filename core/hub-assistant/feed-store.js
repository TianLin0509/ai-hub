'use strict';
// 前台各条排队消息落盘（2026-11-19，补 11-18 赶工留下的缺口：Hub 重启丢正在排队的几条）。
// 一个文件 assistant/feed-queues.json，按队列名分段：
//   direct  订阅直通（direct-feed）还没送出的消息
//   handoff 负责人交卷 / 请拍板：等前台空闲的批次 + 刚答完、还在等 5–20 秒复核的那一轮
//   alerts  等前台空闲的告警与知会（alerts.frontQueue）
// 只存「还没送出」的；已经送进会话的不存，重启后不会重发。
// 写盘：默认每次变动立即原子替换（队列只有几条到几十条，事件稀疏，开销可忽略）；可选合并窗口，close() 时把没写的立即写掉。
// 送出前后立即写（save(..., {now:true})）：直通消息送前先记「在途」，重启后在途的不重发、只提示核对；
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../atomic-write');

const MAX_PER_QUEUE = 200;

class FeedStore {
  // debounceMs 默认 0：每次变动立即同步写（事件每小时最多几十条，每次几毫秒）；只有测试或高频场景才设合并窗口。
  constructor({ dir, debounceMs = 0, now = Date.now } = {}) {
    if (!dir) throw new Error('排队落盘缺少数据目录');
    this.file = path.join(dir, 'feed-queues.json');
    this.debounceMs = debounceMs; this.now = now;
    this.data = null; this.timer = null; this.dirty = false;
  }
  read() {
    if (this.data) return this.data;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        // 坏文件备份后从空开始：排队消息丢了只少几条提醒，不能让前台因此起不来。
        try { fs.copyFileSync(this.file, `${this.file}.bad-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`); } catch {}
        console.warn('[feed-store] 读取排队落盘失败，从空队列开始：', error.message);
      }
    }
    this.data = raw && typeof raw.queues === 'object' && raw.queues ? raw.queues : {};
    return this.data;
  }
  // 取出某个队列上次落盘的内容（数组）。
  load(name) { const v = this.read()[name]; return Array.isArray(v) ? v.map(x => ({ ...x })) : []; }
  // now=true：立即同步写（送出成功、发送前标在途时用），把「已送出却没来得及写盘」的窗口压到几毫秒。
  save(name, items, { now = false } = {}) {
    const list = (Array.isArray(items) ? items : []).slice(-MAX_PER_QUEUE).map(x => JSON.parse(JSON.stringify(x)));
    const data = this.read();
    if (!list.length && !data[name]) return;
    if (list.length) data[name] = list; else delete data[name];
    this.dirty = true;
    if (now || !this.debounceMs) { clearTimeout(this.timer); this.timer = null; this.flush(); return; }
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.debounceMs);
    this.timer.unref?.();
  }
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(fs, this.file, JSON.stringify({ version: 1, savedAt: this.now(), queues: this.data || {} }));
    } catch (error) { this.dirty = true; console.warn('[feed-store] 排队落盘失败：', error.message); }
  }
  close() { clearTimeout(this.timer); this.timer = null; this.flush(); }
}

module.exports = { FeedStore };
