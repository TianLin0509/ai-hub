'use strict';

// 后台账号对齐的排队器：同一时间只跑一个线程，运行中新来的账号合并到下一轮。
const path = require('node:path');
const { Worker } = require('node:worker_threads');

function createProfileAlignRunner({ primaryDir, onReport = () => {}, logger = console, WorkerImpl = Worker }) {
  const queued = new Map();
  let worker = null;
  let closed = false;

  function runNext() {
    if (closed || worker || !queued.size) return;
    const jobs = [...queued.values()];
    queued.clear();
    worker = new WorkerImpl(path.join(__dirname, 'claude-profile-align-worker.js'), { workerData: { primaryDir, jobs } });
    worker.on('message', report => {
      try { onReport(report); } catch (error) { logger.warn?.('[claude-profile-align] 处理对齐结果失败：' + error.message); }
    });
    worker.on('error', error => logger.warn?.('[claude-profile-align] 后台对齐失败，下次启动或开会话时重试：' + error.message));
    worker.on('exit', () => { worker = null; runNext(); });
  }

  return {
    enqueue(jobs) {
      if (closed) return;
      for (const job of jobs) queued.set(path.resolve(job.profileDir).toLowerCase(), job);
      runNext();
    },
    close() {
      closed = true;
      queued.clear();
      const running = worker;
      worker = null;
      return running ? running.terminate() : Promise.resolve();
    },
  };
}

module.exports = { createProfileAlignRunner };
