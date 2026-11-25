'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
const parseCodeAgentUsageMenu = () => null;
const recordUsage = () => null;
const readUsage = () => ({});
const usageFile = () => null;
const modelUsage = () => null;
const usageHint = () => '';
const durationMinutes = () => null;
const formatMinutes = () => '';
const formatAge = () => '';
const displayCol = () => '';
module.exports = { parseCodeAgentUsageMenu, recordUsage, readUsage, usageFile, modelUsage, usageHint, durationMinutes, formatMinutes, formatAge, displayCol };
