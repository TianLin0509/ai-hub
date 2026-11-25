'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
const LAST_KIND_KEY = 'hub:lastSessionKind';
const refresh = () => Promise.resolve(false);
const isInstalled = () => false;
function rememberKind(kind) { try { if (kind) localStorage.setItem(LAST_KIND_KEY, String(kind)); } catch {} }
function preferredKind(validKinds = []) {
  let last = null;
  try { last = localStorage.getItem(LAST_KIND_KEY); } catch {}
  if (last && validKinds.includes(last)) return last;
  return 'claude';
}
function defaultGroupMembers(fallback) { return (fallback || []).map(x => ({ ...x })); }
module.exports = { LAST_KIND_KEY, refresh, isInstalled, rememberKind, preferredKind, defaultGroupMembers };
