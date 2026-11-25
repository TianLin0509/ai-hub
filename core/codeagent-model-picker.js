'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
const FIRST_MENU_MODEL = '@first';
const isFirstMenuModel = value => value === '@first';
const parsePicker = () => null;
const modelDialogVisible = () => false;
const promptInputReady = () => false;
const promptInputAvailable = () => false;
const inputUsableAfterPick = () => false;
const findTarget = () => null;
const confirmationSeen = () => false;
const pickerLabelFor = () => '';
const snapshotDefaults = () => null;
const restoreDefaults = () => null;
const guardDefaults = () => null;
const normalizeConfigDir = () => null;
const modelAllowed = () => null;
// 读屏是通用工具（「问一下」对普通 Claude 会话也用），复用真实现，不能写成空函数（2026-11-26）。
const { openSessionScreen } = require('./session-screen');
const pickModel = async () => null;
const schedulePick = async () => null;
const waitForPick = async () => null;
const isPicking = () => false;
const beforePrompt = async () => null;
const resetFailure = () => {};
module.exports = { FIRST_MENU_MODEL, isFirstMenuModel, parsePicker, modelDialogVisible, promptInputReady, promptInputAvailable, inputUsableAfterPick, findTarget, confirmationSeen, pickerLabelFor, snapshotDefaults, restoreDefaults, guardDefaults, normalizeConfigDir, modelAllowed, openSessionScreen, pickModel, schedulePick, waitForPick, isPicking, beforePrompt, resetFailure };
