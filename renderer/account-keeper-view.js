'use strict';
function remoteStatus(account) {
  const state = account?.remote?.state;
  if (state === 'inactive') return '远程浏览器已关闭';
  if (state === 'active') {
    const auto = account.remote.autoClose;
    return auto?.enabled && auto.observation === 'idle' ? '远程浏览器运行中 · 无人查看将自动关闭' : '远程浏览器运行中';
  }
  if (state === 'activating' || state === 'reloading') return '远程浏览器正在启动';
  if (state === 'deactivating') return '远程浏览器正在关闭';
  return '';
}
function keeperControlsHtml(kind, profileId, esc, { account, label = '在管家中管理', busy = false } = {}) {
  const status = remoteStatus(account);
  return `<div class="ac-keeper-controls"><button class="ac-open" data-ac="keeper-manage" data-kind="${kind}" data-profile="${esc(profileId)}" ${busy ? 'disabled' : ''}>${label}</button>${status ? `<p class="ac-tool-help" role="status" data-keeper-remote>${esc(status)}</p>` : ''}</div>`;
}
module.exports = { keeperControlsHtml, remoteStatus };
