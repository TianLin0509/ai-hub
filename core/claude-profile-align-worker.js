'use strict';

// 把我的账号的技能等文件镜像到 Claude 账号目录。文件逐个比对在 21 个账号、约 6500 个文件时
// 要 13–38 秒（2026-11-08 实测），放在主线程会让窗口迟迟出不来，所以单独开线程跑。
const { parentPort, workerData } = require('node:worker_threads');
const { mirrorProfileFiles } = require('./claude-profile-align');

const { primaryDir, jobs } = workerData;
const sourceCache = new Map();
for (const job of jobs) {
  let report;
  try { report = mirrorProfileFiles({ primaryDir, profileDir: job.profileDir, sourceCache }); }
  catch (error) { report = { profileDir: job.profileDir, errors: [error.message] }; }
  parentPort.postMessage(report);
}
