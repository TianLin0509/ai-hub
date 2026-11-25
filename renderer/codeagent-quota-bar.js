'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
// 返回一个什么都不显示的额度条。
function createCodeAgentQuotaBar() {
  return new Proxy({}, { get: (_t, key) => key === 'then' ? undefined : () => null });
}
module.exports = { createCodeAgentQuotaBar };
