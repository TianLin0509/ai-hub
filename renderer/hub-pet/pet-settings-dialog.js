'use strict';
// 所以单开一个小窗放同一页内容（renderer/hub-pet/pet-settings-tab.js）：选形象、下载更多形象、大小、说话频率、几个开关。
function createPetSettingsDialog({ document, window, ipcRenderer }) {
  let dialog = null, tab = null;
  function open() {
    if (!dialog) {
      const style = document.createElement('style');
      // 宽 880：六个内置形象排成一行，整页在 1440×900 下一屏放完，不出滚动条。
      style.textContent = [
        '.pet-settings-dialog{position:fixed;inset:0;margin:auto;height:fit-content;max-height:calc(100vh - 48px);overflow:auto;width:min(880px,calc(100vw - 48px));padding:0;',
        'border:1px solid #e3e6ec;border-radius:14px;background:#fff;color:#1f2733;box-shadow:0 24px 60px rgba(20,30,50,.22);font:inherit}',
        '.pet-settings-dialog::backdrop{background:rgba(20,30,50,.32)}',
        '.psd-head{display:flex;align-items:baseline;gap:10px;padding:16px 22px 4px}.psd-head strong{font-size:15px}.psd-head span{font-size:12px;color:#8a94a6}',
        '.psd-close{margin-left:auto;border:0;background:none;color:#8a94a6;font-size:16px;cursor:pointer;padding:4px 8px;border-radius:6px}.psd-close:hover{background:#f1f3f7;color:#1f2733}',
        '.psd-body{padding:0 22px 14px}',
      ].join('');
      document.head.appendChild(style);
      dialog = document.createElement('dialog');
      dialog.className = 'pet-settings-dialog';
      dialog.innerHTML = '<div class="psd-head"><strong>桌宠</strong><span>改了立即生效</span>'
        + '<button type="button" class="psd-close" data-pd="close" title="关闭" aria-label="关闭">✕</button></div><div class="psd-body"><div data-pd="tab"></div></div>';
      document.body.appendChild(dialog);
      dialog.addEventListener('click', event => { if (event.target.closest('[data-pd="close"]')) dialog.close(); });
      tab = require('./pet-settings-tab.js').mountPetSettingsTab(dialog.querySelector('[data-pd="tab"]'), { ipcRenderer, window, document });
    } else tab.refresh();
    if (!dialog.open) dialog.showModal();
  }
  return { open, isOpen: () => !!(dialog && dialog.open) };
}

module.exports = { createPetSettingsDialog };
