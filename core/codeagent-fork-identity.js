'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载。
// 注意：恢复会话（main/ipc/resume-session-handlers.js）对每个会话都调 recoverCodeAgentFork 并读 .meta，
// 所以它必须和真实现一样是同步函数，非 CodeAgent 会话原样返回（2026-11-26：写成 async () => null 时纯净版所有会话都恢复失败）。
const forkSourceIdentity = () => null;
const identityRejection = () => null;
const recoverCodeAgentFork = meta => ({ meta, forkCCSessionId: null, repaired: false, sourceId: null });
module.exports = { forkSourceIdentity, identityRejection, recoverCodeAgentFork };
