'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { JsonlTail } = require('../../core/jsonl-tail.js');
const { isClaudeFamily, isCodexCliKind } = require('../../core/ai-kinds.js');
const { codexUsage, ClaudeUsageLedger, AntigravityUsageLedger } = require('../../core/session-token-usage.js');
const { isAntigravity } = require('../../core/antigravity-config.js');
const { isSessionViewer } = require('../../core/session-observer-policy');

class SessionTokenUsageService {
  constructor({ publish, logger = console, now = Date.now }) {
    this.publish = publish;
    this.logger = logger;
    this.now = now;
    this.entries = new Map();
  }

  bind(session) {
    const id = session?.id || session?.hubId;
    if (id && (isSessionViewer(session) || (session.runtimeBackend==='claude-stream-json' && session.codexSharedControl?.shared))) { this.remove(id); return; }
    const kind = session?.transcriptKind || session?.kind;
    const agy = /^gemini(?:-resume)?$/.test(String(kind || '')) && isAntigravity(session);
    if (!id || !session.transcriptPath || (!isClaudeFamily(kind) && !isCodexCliKind(kind) && !agy)) return;
    const sourcePath = path.resolve(session.transcriptPath);
    const previous = this.entries.get(id);
    if (previous?.sourcePath === sourcePath) return;
    this.remove(id);
    const entry = { sourcePath, ledger: agy ? new AntigravityUsageLedger() : new ClaudeUsageLedger(), usage: null, ready: false, timer: null };
    // A saved snapshot survives a missing/truncated history file. Different
    // native transcripts must never inherit each other's accumulated usage.
    if (session.sessionUsage?.sourcePath === sourcePath) entry.usage = session.sessionUsage;
    else if (session.sessionUsage) this.publish(id, { sourcePath, total: null, output: null });
    this.entries.set(id, entry);
    const publish = () => {
      entry.timer = null;
      if (this.entries.get(id) !== entry) return;
      const partial = entry.ledger.partial || entry.tail?.getStats().invalidRecords > 0;
      if (entry.usage) this.publish(id, { ...entry.usage, ...(partial ? { partial: true } : {}) });
    };
    const accept = record => {
      const usage = agy || isClaudeFamily(kind)
        ? entry.ledger.accept(record)
        : (record?.type === 'event_msg' && record.payload?.type === 'token_count'
          ? codexUsage(record.payload.info?.total_token_usage, 'codex-transcript') : null);
      if (!usage) {
        if (entry.ready && entry.ledger.partial && entry.usage && !entry.timer) entry.timer = setTimeout(publish, 100);
        return;
      }
      // Late/replayed Codex snapshots and initial Claude history replay cannot
      // make the visible cumulative amount go backwards.
      if (entry.usage && usage.total < entry.usage.total) return;
      entry.usage = { ...usage, sourcePath };
      if (entry.ready && !entry.timer) entry.timer = setTimeout(publish, 100);
    };
    if (agy) {
      // agy rewrites transcript.jsonl in place; reconcile from full snapshot by step_index instead of append-only tailing.
      // 2026-11-25 后台开销：先比 stat（大小、修改时间、inode）和末尾 4 KB，没变就不整份读（真实文件可达 10 MB）。
      // 末尾比对能发现「同大小、同修改时间、末尾有变」的覆盖（新步骤和用量写在文件尾部）。
      // 快检只看大小/时间/inode/末尾，中部改写且这些都不变时发现不了：距上次整份读超过 5 分钟就兜底整份重读一次。
      let lastSig = '', lastFullAt = 0;
      const TAIL_BYTES = 4096, FULL_REREAD_MS = 5 * 60 * 1000;
      const statSig = () => {
        const st = fs.statSync(sourcePath);
        const len = Math.min(TAIL_BYTES, st.size);
        const buf = Buffer.alloc(len);
        if (len) {
          const fd = fs.openSync(sourcePath, 'r');
          try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
        }
        return `${st.size}:${st.mtimeMs}:${st.ino}:${buf.toString('base64')}`;
      };
      const scanSnapshot = () => {
        if (this.entries.get(id) !== entry) return;
        let raw;
        try {
          const sig = statSig();
          if (sig === lastSig && this.now() - lastFullAt < FULL_REREAD_MS) return;
          raw = fs.readFileSync(sourcePath, 'utf8');
          lastFullAt = this.now();
          // 读完再取一次签名：读的过程中又被重写，就记成空签名，下一轮再读，不漏更新。
          lastSig = statSig() === sig ? sig : '';
        } catch (error) {
          if (error.code === 'ENOENT') return;
          if (!entry.errorLogged) this.logger.warn('[session-usage] transcript read failed:', id, error.message);
          entry.errorLogged = true;
          if (entry.usage) { entry.usage = { ...entry.usage, stale: true }; publish(); }
          return;
        }
        const ledger = new AntigravityUsageLedger();
        let latest = null;
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let rec;
          try { rec = JSON.parse(line); } catch { ledger.partial = true; continue; }
          const next = ledger.accept(rec);
          if (next) latest = next;
        }
        entry.ledger = ledger;
        if (latest && (!entry.usage || latest.total >= entry.usage.total)) {
          entry.usage = { ...latest, sourcePath };
          publish();
        }
      };
      entry.ready = true;
      scanSnapshot();
      entry.pollTimer = setInterval(scanSnapshot, 5000);
      entry.pollTimer.unref?.();
      return;
    }
    entry.tail = new JsonlTail(sourcePath, accept, {
      maxReadBytes: 256 * 1024,
      watchPollIntervalMs: 5000,
      onError: error => {
        if (!entry.errorLogged) this.logger.warn('[session-usage] transcript read failed:', id, error.message);
        entry.errorLogged = true;
        if (entry.usage) { entry.usage = { ...entry.usage, stale: true }; publish(); }
      },
    });
    entry.tail.start().then(() => {
      if (this.entries.get(id) !== entry) { entry.tail.close(); return; }
      entry.ready = true;
      publish();
    }).catch(error => this.logger.warn('[session-usage] watcher failed:', id, error.message));
  }

  native(session, total, source = 'codex-app-server') {
    const usage = codexUsage(total, source);
    if (!usage || !session?.id) return;
    const sourcePath = session.transcriptPath ? path.resolve(session.transcriptPath) : null;
    const old = session.sessionUsage;
    if (old?.sourcePath === sourcePath && old.total > usage.total) return;
    this.publish(session.id, { ...usage, sourcePath });
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    entry.tail?.close();
  }

  dispose() { for (const id of this.entries.keys()) this.remove(id); }
}

module.exports = { SessionTokenUsageService };
