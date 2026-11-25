'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
const serveEnabled = () => false;
const withTempServe = async () => null;
const request = async () => null;
const getJson = async () => null;
const freePort = async () => null;
const portOwner = async () => null;
const HEALTH_PATH = "/api/v1/global/health";
const parseProviders = () => [];
const parseQuota = () => null;
const readAccount = async () => null;
const toUsageSnapshot = () => null;
module.exports = { serveEnabled, withTempServe, request, getJson, freePort, portOwner, HEALTH_PATH, parseProviders, parseQuota, readAccount, toUsageSnapshot };
