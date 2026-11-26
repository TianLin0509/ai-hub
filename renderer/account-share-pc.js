'use strict';
// 纯净版不带「共享账号到笔记本」（依赖个人 VPS 工具）：同名空实现，账号页的调用都在 accountInfra 开关之后，这里只保证能加载。
function createAccountSharePc() {
  const state = () => undefined;
  return { state, load: async () => null, open: async () => null, close: () => {}, isOpen: () => false };
}
const shareStatusHtml = () => '';
const readyDevices = () => [];
const disruption = () => '';
const COLLEAGUE_TEXT = '';
module.exports = { createAccountSharePc, shareStatusHtml, readyDevices, disruption, COLLEAGUE_TEXT };
