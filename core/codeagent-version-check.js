'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
const MIN_VERSION = '';
const DOWNLOAD_PAGE = null;
const YELLOW_ZONE_DOWNLOAD = null;
const compare = () => null;
const isOutdated = () => false;
const check = async () => ({ ok: false, outdated: false });
module.exports = { MIN_VERSION, DOWNLOAD_PAGE, YELLOW_ZONE_DOWNLOAD, compare, isOutdated, check };
