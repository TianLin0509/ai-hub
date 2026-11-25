'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
const ARITY = {};
const ALIASES = {};
const FILTER_BELOW = "1.2615";
const readHelp = async () => null;
const cachedVersion = () => null;
const flagListed = () => false;
const filterArgs = () => [];
const _helpCache = new Map();
module.exports = { ARITY, ALIASES, FILTER_BELOW, readHelp, cachedVersion, flagListed, filterArgs, _helpCache };
