'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
const setPersonalModel = async () => null;
const allowedModels = () => [];
const answeredProves = () => false;
const listBackups = () => [];
const latestBackup = () => null;
const BACKUP_PREFIX = "settings.json.hub-backup-";
const KEEP_BACKUPS = 10;
module.exports = { setPersonalModel, allowedModels, answeredProves, listBackups, latestBackup, BACKUP_PREFIX, KEEP_BACKUPS };
