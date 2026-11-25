'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
const clean = value => typeof value === 'string' ? value.trim() : '';
const KNOWN = [];
const DEFAULT_MODEL = '';
const OBSERVED_FILE = 'codeagent-models.json';
const PLACEHOLDER_LABEL = '当前模型';
const DEFAULT_CONTEXT_WINDOW = 200000;
function isSafeModelId(value) { const id = clean(value); return /^[A-Za-z0-9][A-Za-z0-9._:\/\[\]-]{0,95}$/.test(id) && !id.startsWith('<'); }
function normalizeModel(value) { const id = clean(value); return isSafeModelId(id) ? id : DEFAULT_MODEL; }
function modelFamily(value) {
  const id = clean(value).toLowerCase();
  if (!id) return '';
  if (id.includes('deepseek')) return 'deepseek';
  if (id.includes('minimax')) return 'minimax';
  if (id.includes('glm') || id.includes('zhipu') || id.includes('chatglm')) return 'glm';
  if (id.includes('qwen')) return 'qwen';
  return '';
}
function modelLabel(value) { return clean(value); }
function isCodeAgentSession(session) { return /^codeagent(?:-resume)?$/.test(String(session && session.kind || '')); }
function iconModelId(session) { return clean(session && session.currentModel && session.currentModel.id); }
function isPlaceholderModel(model) {
  if (!model || typeof model !== 'object') return true;
  if (clean(model.id)) return false;
  const label = clean(model.displayName);
  return !label || label === PLACEHOLDER_LABEL;
}
function dormantDisplayModel(meta) {
  const saved = meta && meta.currentModel && typeof meta.currentModel === 'object' ? meta.currentModel : null;
  return saved ? { ...saved } : null;
}
const observeModel = () => ({});
const mismatchNotice = () => '';
const configuredModels = () => [];
const scanModelNamesInText = () => [];
const readObserved = () => [];
const recordObserved = () => false;
const readMenu = () => null;
const recordMenu = () => false;
const appendModelLog = () => {};
const modelOptions = () => [];
const contextWindowFor = () => DEFAULT_CONTEXT_WINDOW;
const contextFromUsage = () => null;
module.exports = { KNOWN, DEFAULT_MODEL, OBSERVED_FILE, isSafeModelId, normalizeModel, modelFamily, modelLabel, PLACEHOLDER_LABEL, isPlaceholderModel,
  iconModelId, isCodeAgentSession, dormantDisplayModel, observeModel, mismatchNotice, configuredModels, scanModelNamesInText, readObserved, recordObserved,
  readMenu, recordMenu, appendModelLog, modelOptions, contextWindowFor, contextFromUsage, DEFAULT_CONTEXT_WINDOW };
