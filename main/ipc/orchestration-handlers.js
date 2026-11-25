'use strict';
function registerOrchestrationIpc(ipcMain, getService) {
  const call = fn => async (_event, args = {}) => {
    const service = getService();
    if (!service) return { ok: false, error: 'AI 编排服务尚未就绪' };
    try { return { ok: true, view: await fn(service, args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  };
  ipcMain.handle('orchestration:view', call((s, a) => s.view(String(a.meetingId || ''))));
  ipcMain.handle('orchestration:action', call((s, a) => s.userAction(String(a.meetingId || ''), String(a.action || ''), a)));
  ipcMain.handle('orchestration:user-message', call((s, a) => s.userMessage(String(a.meetingId || ''), {
    text: String(a.text || '').slice(0, 4000), direct: Array.isArray(a.direct) ? a.direct.map(String).slice(0, 3) : [],
  })));
}
module.exports = { registerOrchestrationIpc };
