'use strict';
// 纯净版不带 CodeAgent 适配：这是同名空实现，只为让共用代码里的引用照常加载；纯净版没有 CodeAgent 会话，这些函数不会真正被用到。
const projectSlugOf = () => '';
const transcriptDirs = () => [];
const candidateTranscripts = () => [];
const MAX_SCAN_FILES = 12;
const MAX_SCAN_BYTES = 67108864;
module.exports = { projectSlugOf, transcriptDirs, candidateTranscripts, MAX_SCAN_FILES, MAX_SCAN_BYTES };
