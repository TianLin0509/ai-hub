'use strict';
// 会话屏幕镜像（2026-11-26 从 core/codeagent-model-picker.js 拆出）：任意会话通用的读屏工具，
// 「问一下」（main/btw-ask）、群聊等都在用；纯净版的 CodeAgent 空实现也直接复用这里，不再写成空函数。
// 与 codex-fast-command 同一做法：用会话缓冲快照重建一个终端模拟器，再接上之后的输出。
async function openSessionScreen(manager, sid) {
  const { Terminal } = require('@xterm/headless');
  const queued = [];
  let terminal = null, replayed = false, disposed = false, chain = Promise.resolve();
  const write = text => new Promise(resolve => terminal.write(text, resolve));
  const apply = event => event.type === 'resize' ? terminal.resize(event.cols, event.rows) : write(event.data);
  const enqueue = event => {
    if (event.sessionId !== sid || disposed) return;
    if (!replayed) queued.push(event);
    else {
      chain = chain.then(() => apply(event));
      // 监听回调不能 await；由 lines() 将错误传给调用方，这里只避免读取前的未处理拒绝。
      chain.catch(() => {});
    }
  };
  const listener = event => enqueue({ ...event, type: 'write' });
  const resizeListener = event => enqueue({ ...event, type: 'resize' });
  const unsubscribe = () => {
    manager.removeListener('output', listener);
    manager.removeListener('terminal-resized', resizeListener);
  };
  manager.on('output', listener);
  manager.on('terminal-resized', resizeListener);
  try {
    const snapshot = await manager.getSessionBufferSnapshot(sid);
    // windowsPty 与会话自己的快照终端一致（core/terminal-snapshot.js）：不按 ConPTY 解释换行和光标移动，
    // 重绘会错一行，光标看起来就「没动」（2026-10-14 替身实测）。
    terminal = new Terminal({ cols: snapshot.baseCols || snapshot.cols || 120, rows: snapshot.baseRows || snapshot.rows || 30, scrollback: 200, allowProposedApi: true,
      ...(process.platform === 'win32' ? { windowsPty: { backend: 'conpty', buildNumber: parseInt(require('node:os').release().split('.').pop(), 10) || 0 } } : {}) });
    await write(snapshot.text || '');
    for (const operation of snapshot.operations || []) {
      if (operation.type === 'resize') terminal.resize(operation.cols, operation.rows);
      else if (operation.type === 'write') await write(operation.data);
    }
    for (const event of queued) if (!event.seq || event.seq > snapshot.seq) await apply(event);
    replayed = true;
  } catch (error) {
    disposed = true; unsubscribe(); try { terminal && terminal.dispose(); } catch {}
    throw error;
  }
  return {
    async lines() {
      // await 期间 output/resize 仍能延长队列；等旧尾部会把已收到的新菜单
      // 藏到下一次读取。排到当前尾部稳定才返回，拒绝的链仍向调用方传播。
      let observed;
      do { observed = chain; await observed; } while (observed !== chain);
      const buffer = terminal.buffer.active, out = [];
      for (let i = buffer.baseY; i < buffer.baseY + terminal.rows; i += 1) out.push(buffer.getLine(i)?.translateToString(true) || '');
      return out;
    },
    dispose() {
      disposed = true; unsubscribe();
      const cleanup = () => { try { terminal.dispose(); } catch {} };
      chain.then(cleanup, cleanup);
    },
  };
}

module.exports = { openSessionScreen };
