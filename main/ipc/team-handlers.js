'use strict';
// 批准只从这里进来——会话里的模型只能提交计划，不能自己批准。
function registerTeamIpc(ipcMain, getService) {
  const call = fn => async (_event, args = {}) => {
    const service = getService();
    if (!service) return { ok: false, error: '组队服务尚未就绪' };
    try { return { ok: true, result: await fn(service, args || {}) }; }
    catch (error) { return { ok: false, error: error.message }; }
  };
  ipcMain.handle('team:list', call(s => s.listTeams()));
  ipcMain.handle('team:accounts', call(s => s.accounts()));
  ipcMain.handle('team:decide', call((s, a) => s.decide({
    leadSid: String(a.leadSid || ''), planId: String(a.planId || ''), approve: a.approve === true,
    note: String(a.note || '').slice(0, 2000), edits: Array.isArray(a.edits) ? a.edits.slice(0, 16) : null,
  })));
  ipcMain.handle('team:lead-options', call(s => s.leadOptions()));
  ipcMain.handle('team:attach-member', call((s, a) => s.attachMember({
    leadSid: String(a.leadSid || ''), sessionId: String(a.sessionId || ''), task: String(a.task || '').slice(0, 4000), title: String(a.title || '').slice(0, 80),
  })));
  // 2026-11-15：启动中心「创建为负责人」、右键「登记为负责人…」。
  ipcMain.handle('team:register-lead', call((s, a) => s.registerLead({
    sessionId: String(a.sessionId || ''), project: String(a.project || '').slice(0, 80), goal: String(a.goal || '').slice(0, 2000),
  })));
}
module.exports = { registerTeamIpc };
