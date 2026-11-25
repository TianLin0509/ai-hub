'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
const BUILTIN_RULES = [];
const KINDS = {};
const SOURCES = {};
const DEFAULT_RETRY_MS = 3600000;
const MODEL_PROBE_MS = 21600000;
const RULES_FILE = "quota-rules.json";
const STATE_FILE = "quota-avoid.json";
const rulesFile = () => null;
const stateFile = () => null;
const compileRule = () => null;
const loadRules = () => null;
const matchText = () => false;
const isSuspect = () => false;
const parseReset = () => null;
const redactSnippet = () => '';
const readState = () => null;
const activeAvoid = () => null;
const creditReadings = () => [];
const markAvoid = () => null;
const clearAvoid = () => null;
const recordCredit = () => null;
const isActive = () => false;
const markModelAvoid = () => null;
const modelAvoidAll = () => null;
const modelConfigHint = () => null;
const activeModelAvoid = () => null;
const modelAvoidEntry = () => null;
const noteModelProbe = () => null;
const clearModelAvoid = () => null;
const modelKey = () => null;
const aliasMap = () => null;
// 代称写法（「个人」「号 1」）的核对与主干 core/codeagent-quota.js 同一实现（纯函数），队员版要用。
function normalizeAlias(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^(个人|个人账号|personal)$/i.test(s)) return '个人';
  const m = /^(?:号\s*|pool[-_\s]?|#)?(\d{1,2})$/i.exec(s);
  return m && Number(m[1]) >= 1 ? `号 ${Number(m[1])}` : '';
}
const keyForAlias = () => null;
const describeAvoid = () => null;
const clock = () => null;
const ALIAS_FILE = "quota-aliases.json";
const MATCH_INPUT_CHARS = 2000;
const MAX_RESET_MS = 86400000;
module.exports = { BUILTIN_RULES, KINDS, SOURCES, DEFAULT_RETRY_MS, MODEL_PROBE_MS, RULES_FILE, STATE_FILE, rulesFile, stateFile, compileRule, loadRules, matchText, isSuspect, parseReset, redactSnippet, readState, activeAvoid, creditReadings, markAvoid, clearAvoid, recordCredit, isActive, markModelAvoid, modelAvoidAll, modelConfigHint, activeModelAvoid, modelAvoidEntry, noteModelProbe, clearModelAvoid, modelKey, aliasMap, normalizeAlias, keyForAlias, describeAvoid, clock, ALIAS_FILE, MATCH_INPUT_CHARS, MAX_RESET_MS };
