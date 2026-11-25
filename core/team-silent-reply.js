'use strict';
// 模型无法稳定地产出空回复，所以约定只输出这一行。只有整条回复就是暗号才算，带任何其他文字都照常显示，宁可多显示也不藏掉真实汇报。
const NO_UPDATE_MARK = '[[hub:no-update]]';

function isNoUpdateReply(text) {
  return /^\s*`?\[\[hub:no-update\]\]`?\s*$/.test(String(text || ''));
}

module.exports = { NO_UPDATE_MARK, isNoUpdateReply };
