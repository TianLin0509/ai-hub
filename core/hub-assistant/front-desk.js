'use strict';
// 前台会话收不下消息时才由 DeepSeek Flash（官方 API）兜底，见 fallback-answer.js。
// 旧设置里的 mode=api / 千问模型一律按 cli 处理；手机旧版发来的 set_front_desk 也接受，不报错。
const MODES = ['cli'];
const MODELS = [];
const DEFAULT_MODEL = null;

function defaultModel() { return DEFAULT_MODEL; }
function describe() {
  return { mode: 'cli', model: null, label: '助理会话直答', modelLabel: '前台会话' };
}
function validate({ mode } = {}) {
  if (!['api', 'cli'].includes(mode)) throw new Error('回答方式只能是 cli');
  return { mode: 'cli' };
}
// 手机与电脑面板的选项表：只剩一种。
function catalog(current) {
  return { current, modes: [
    { id: 'cli', label: '助理会话', hint: '每条都交给前台会话（Claude Sonnet 5.5）；前台不可用时由 DeepSeek Flash 兜底' },
  ], models: [] };
}
module.exports = { MODES, MODELS, DEFAULT_MODEL, describe, validate, catalog, defaultModel };
