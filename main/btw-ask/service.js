'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { askBtw } = require('../../core/btw-driver');
const { askCodexSide, applyCodexSideNetwork } = require('../../core/btw-codex-driver');
const { btwQuestionVisible } = require('../../core/btw-screen');
const { openSessionScreen } = require('../../core/codeagent-model-picker');

const isCodexKind = kind => /^codex(?:-resume)?$/.test(kind || '');
const isDshKind = kind => /^deepseek-acp(?:-resume)?$/.test(kind || '');

function btwSupport(session, entry) {
  if (!session) return { supported: false, reason: '请先打开一个 Claude、Codex 或 DSH 会话' };
  // DSH：Hub 的观察插件在 DSH 进程里调它自带的 /btw 旁问（core/dsh-cli-observer.mjs），不碰输入框。
  if (isDshKind(session.kind)) {
    if (session.agentRuntime !== 'pty' || (entry && typeof entry.pty?.askSide !== 'function')) return { supported: false, reason: '问一下只支持 DSH 终端会话', engine: 'dsh' };
    if (entry && (!entry.pty || entry.confirmedExit)) return { supported: false, reason: 'DSH 终端已退出，请先恢复会话', engine: 'dsh' };
    return { supported: true, reason: '', engine: 'dsh' };
  }
  if (isCodexKind(session.kind)) {
    if (session.runtimeBackend || session.agentRuntime !== 'pty') return { supported: false, reason: '此 Codex 会话使用原生后端，问一下目前只支持 Codex 终端会话', engine: 'codex' };
    if (!session.codexSid) return { supported: false, reason: 'Codex 还没有原生会话记录，请等首轮回答开始后再问', engine: 'codex' };
    return { supported: true, reason: '', engine: 'codex' };
  }
  if (!/^claude(?:-resume)?$/.test(session.kind || '')) return { supported: false, reason: '问一下支持 Claude、Codex 和 DSH 终端会话' };
  if (session.runtimeBackend || session.agentRuntime !== 'pty') return { supported: false, reason: '此会话使用原生 stream-json，问一下需要 Claude PTY 终端' };
  if (entry && (!entry.pty || entry.confirmedExit)) return { supported: false, reason: 'Claude 终端已退出，请先恢复会话' };
  return { supported: true, reason: '', engine: 'claude' };
}

function createBtwAskService({ sessionManager, getHubDataDir, sendToRenderer = () => {},
  watcher = require('../../core/group-chat-watcher'), openScreen = openSessionScreen,
  driver = askBtw, codexDriver = askCodexSide, now = Date.now, logger = console }) {
  const cache = new Map(), jobs = new Set(), codexLanes = new Map();
  const root = path.join(getHubDataDir(), 'btw-ask');
  const filename = sid => {
    if (typeof sid !== 'string' || !/^[\w-]{1,160}$/.test(sid)) throw new Error('会话编号无效');
    return path.join(root, sid + '.json');
  };
  function data(sid) {
    const file = filename(sid);
    if (!cache.has(sid)) {
      let saved = { items: [] };
      try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!Array.isArray(saved.items)) throw new Error('问一下历史格式无效');
      saved.items = saved.items.slice(-200).map(item => ['queued', 'running'].includes(item.status)
        ? { ...item, status: 'error', error: '上次问答随 Hub 关闭而中断，请查看后台终端' } : item);
      cache.set(sid, saved);
    }
    return cache.get(sid);
  }
  function support(sid) {
    const session = sessionManager.getSession(sid), entry = sessionManager.sessions?.get(sid);
    const result = btwSupport(session, entry);
    if (result.supported && result.engine === 'claude' && !entry?.pty) return { supported: false, reason: 'Claude 终端尚未就绪，请先恢复会话' };
    return result;
  }
  const list = sid => ({ sessionId: sid, ...data(sid), ...support(sid) });
  function publish(sid) {
    const saved = data(sid);
    // Retain pending jobs even under an unusual burst, reject new asks at 200.
    saved.items = saved.items.slice(-200);
    fs.mkdirSync(root, { recursive: true });
    const file = filename(sid), temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(saved, null, 2), 'utf8');
    fs.renameSync(temp, file);
    sendToRenderer('btw-ask:changed', list(sid));
  }
  function ask({ sessionId: sid, question }) {
    const capability = support(sid);
    if (!capability.supported) throw new Error(capability.reason);
    const q = String(question || '').trim();
    if (!q || q.length > 32000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(q)) throw new Error('请输入有效问题（最多 32000 字，不含终端控制字符）');
    const saved = data(sid);
    if (saved.items.filter(item => ['queued', 'running'].includes(item.status)).length >= 200) throw new Error('排队问题已达 200 条，请等待回答后再提问');
    const item = { id: randomUUID(), q, a: '', at: new Date(now()).toISOString(), wall_s: 0, status: 'queued', error: '', truncated: false,
      engine: capability.engine };
    saved.items.push(item);
    publish(sid);
    if (capability.engine === 'codex') return askInLane(sid, item, () => codexDriver({ session: sessionManager.getSession(sid), question: item.q, now, applyNetwork: applyCodexSideNetwork,
      historyTmpRoots: [path.join(getHubDataDir(), 'tmp')] }));
    if (capability.engine === 'dsh') return askInLane(sid, item, async () => ({ ...await sessionManager.sessions.get(sid).pty.askSide(item.q), truncated: false }));
    const job = watcher.runExclusive(sid, async submit => {
      let screen, entry, originalPty, started = now();
      item.status = 'running';
      try {
        publish(sid);
        const current = support(sid);
        if (!current.supported) throw new Error(current.reason);
        entry = sessionManager.sessions.get(sid);
        originalPty = entry.pty;
        const requireSamePty = () => {
          if (sessionManager.sessions.get(sid) !== entry || entry.pty !== originalPty || entry.confirmedExit || entry.closeRequestedAt) {
            throw new Error('Claude 会话已关闭或重启，问一下已停止');
          }
        };
        screen = await openScreen(sessionManager, sid);
        const readScreen = async () => {
          requireSamePty();
          const lines = await screen.lines();
          requireSamePty();
          return lines.join('\n');
        };
        const result = await driver({ question: q, now,
          readScreen, write: bytes => { requireSamePty(); sessionManager.writeToSession(sid, bytes); },
          submit: async command => {
            requireSamePty();
            // askBtw has already checked/closed any old overlay in this slot.
            entry.btwAskNeedsClose = false;
            const localCommandObserver = { async wait() {
              const deadline = now() + 12000;
              do {
                if (btwQuestionVisible(await readScreen(), command.slice(5))) return { ok: true };
                await new Promise(resolve => setTimeout(resolve, 60));
              } while (now() < deadline);
              return { ok: false, message: '未看到本次 /btw 浮层，请查看后台终端；未自动补发回车' };
            } };
            return submit(command, sessionManager.getSession(sid).kind, {
              requireReady: false, workspaceRulesPrepared: true, hubRulesPrepared: true, localCommandObserver,
              shouldSubmit: () => { requireSamePty(); return true; },
            });
          },
        });
        Object.assign(item, { a: result.answer, truncated: result.truncated, status: 'done' });
      } catch (error) {
        Object.assign(item, { status: 'error', error: error.message, a: error.answer || '', truncated: !!error.truncated });
        // If cleanup could not establish safety, queued ordinary prompts must
        // refuse to type into the overlay's c/f/x shortcuts.
        if (entry && screen && sessionManager.sessions?.get(sid) === entry && entry.pty === originalPty) entry.btwAskNeedsClose = true;
        sendToRenderer('session-notice', { sessionId: sid, message: item.error, level: 'warning' });
      } finally {
        screen?.dispose();
        item.wall_s = Math.round((now() - started) / 100) / 10;
        publish(sid);
      }
    }, { localCommandObserver: true });
    jobs.add(job);
    job.catch(error => {
      item.status = 'error'; item.error = error.message;
      try { publish(sid); } catch (writeError) { logger.error('[btw-ask]', writeError); }
      sendToRenderer('session-notice', { sessionId: sid, message: item.error, level: 'warning' });
    }).finally(() => jobs.delete(job));
    return { id: item.id, status: 'queued' };
  }
  // Codex / DSH 不碰 PTY 输入：同一会话的问题按顺序一条条问，和主线程的回合互不阻塞。
  function askInLane(sid, item, answer) {
    const previous = codexLanes.get(sid) || Promise.resolve();
    const job = previous.then(async () => {
      const started = now();
      item.status = 'running';
      try {
        publish(sid);
        const current = support(sid);
        if (!current.supported) throw new Error(current.reason);
        const result = await answer();
        Object.assign(item, { a: result.answer, truncated: result.truncated, status: 'done' });
      } catch (error) {
        Object.assign(item, { status: 'error', error: error.message });
        sendToRenderer('session-notice', { sessionId: sid, message: item.error, level: 'warning' });
      } finally {
        item.wall_s = Math.round((now() - started) / 100) / 10;
        publish(sid);
      }
    });
    const lane = job.catch(error => { logger.error('[btw-ask]', error); });
    codexLanes.set(sid, lane);
    jobs.add(lane);
    lane.finally(() => { jobs.delete(lane); if (codexLanes.get(sid) === lane) codexLanes.delete(sid); });
    return { id: item.id, status: 'queued' };
  }
  return { ask, list, support, async drain() { await Promise.allSettled([...jobs]); } };
}

function registerBtwAskIpc(ipcMain, service) {
  for (const method of ['list', 'ask', 'support']) ipcMain.handle('btw-ask:' + method, async (_event, request = {}) => {
    try { return { ok: true, result: await service[method](method === 'ask' ? request : request.sessionId) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}
module.exports = { createBtwAskService, registerBtwAskIpc, btwSupport };
