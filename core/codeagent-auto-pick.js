'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
const openFor = () => null;
const record = () => {};
const snapshot = () => null;
const skipReason = () => '';
const THRESHOLD = 3;
const OPEN_MS = 14400000;
const FILE = "codeagent-pick-breaker.json";
module.exports = { openFor, record, snapshot, skipReason, THRESHOLD, OPEN_MS, FILE };
