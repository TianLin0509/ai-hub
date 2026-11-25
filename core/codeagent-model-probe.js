'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
const MODELS_FILE = "hub-models.json";
const probeModels = async () => null;
const readProbed = () => [];
const writeProbed = () => null;
const modelsFromPicker = () => [];
const cleanModelId = () => '';
module.exports = { MODELS_FILE, probeModels, readProbed, writeProbed, modelsFromPicker, cleanModelId };
