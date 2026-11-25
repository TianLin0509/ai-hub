'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
const accountOf = () => '';
const sessionConfigDir = () => null;
const permittedModels = () => [];
const noteHubWrite = () => null;
const hubWriteFor = () => null;
const launchesNear = () => [];
const recordChange = () => null;
const lastChange = () => null;
const readState = () => null;
const watchPersonal = () => null;
const sameDir = () => false;
const STATE_FILE = "codeagent-settings-state.json";
module.exports = { accountOf, sessionConfigDir, permittedModels, noteHubWrite, hubWriteFor, launchesNear, recordChange, lastChange, readState, watchPersonal, sameDir, STATE_FILE };
