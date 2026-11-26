'use strict';
// 一张表，每个做完的会话一行：依据（交卷 / 卡片已完成 / 最终回复）· 会话名 · 一句话结论 + 产物路径 · 完成时间 ·「已读」。
// 点会话名打开原会话阅读（同时记为看过，自动移出）；「已读」只移出不打开；顶部「全部标记已读」点两下确认。
// 默认只列最近 3 天，更早的折叠在底部按钮里；按窗口高度分页，不出滚动条。
// 单独成文件，主弹窗（assistant-overview.js）只挂 Tab、点击分发和绘制入口，避免和「续跑」Tab 的改动撞在一起。

const KIND = { handoff: ['交卷', 'ok'], card: ['卡片已完成', 'ok'], reply: ['最终回复', 'mute'] };
// 每行 62px。弹窗高度 = min(820, 窗口高 − 64)，扣掉弹窗头、白话一句和底栏约 276px；窗口再高弹窗也不变高，行数跟着封顶（审查第 5 项）。
const rowsFor = h => Math.max(3, Math.floor((Math.min(820, (h || 900) - 64) - 276) / 62));

function createReadingTab({ ipcRenderer, window, esc, showMessage = () => {}, openSession = async () => {}, close = () => {}, refresh = async () => {} }) {
  let page = 0, showOlder = false, confirmAll = false, busy = false;
  const time = at => at ? new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';

  async function markRead(ids) {
    if (busy || !ids.length) return;
    busy = true;
    try { const r = await ipcRenderer.invoke('assistant:overview-read', { ids }); if (r?.ok === false) throw new Error(r.error || '没有回应'); }
    catch (error) { showMessage(`没标成已读：${error.message}`); }
    finally { busy = false; }
    await refresh();
  }

  function list(data) { const r = data?.reading || {}; return showOlder ? r.older || [] : r.rows || []; }

  // a：data-ov 的值（rd-*）；b：按钮。返回 true 表示处理了。
  function click(a, b, data) {
    if (a === 'rd-open') { const id = b.dataset.ovSid; void markRead([id]); close(); void Promise.resolve(openSession(id)).catch(err => showMessage(err.message)); return true; }
    if (a === 'rd-read') { void markRead([b.dataset.ovSid]); return true; }
    if (a === 'rd-path') { void ipcRenderer.invoke('open-path', b.dataset.ovPath).then(err => { if (err) showMessage(`打不开：${err}`); }); return true; }
    if (a === 'rd-all') { confirmAll = true; return 'paint'; }
    if (a === 'rd-all-no') { confirmAll = false; return 'paint'; }
    if (a === 'rd-all-yes') { confirmAll = false; void markRead(list(data).map(r => r.sessionId)); return true; }
    if (a === 'rd-older') { showOlder = !showOlder; page = 0; confirmAll = false; return 'paint'; }
    if (a === 'rd-prev') { page = Math.max(0, page - 1); return 'paint'; }
    if (a === 'rd-next') { page++; return 'paint'; }
    return false;
  }

  function paint(data) {
    const r = data?.reading || { rows: [], older: [] }, cur = list(data);
    if (!cur.length && showOlder) showOlder = false;
    const items = list(data);
    const per = rowsFor(window.innerHeight), pages = Math.max(1, Math.ceil(items.length / per)); page = Math.min(page, pages - 1);
    const rows = items.slice(page * per, page * per + per).map(x => {
      const k = KIND[x.kind] || KIND.reply, p = x.paths || [];
      const pathBtn = p.length ? `<button type="button" class="ov-rd-path" data-ov="rd-path" data-ov-path="${esc(p[0])}" title="${esc(p.join('\n'))}\n点击打开">📄 ${esc(p[0])}</button>${p.length > 1 ? `<small>等 ${p.length} 个</small>` : ''}` : '<span class="ov-rd-nop">没写产物路径</span>';
      return `<div class="ov-tr ov-rd"><span class="ov-chip ${k[1]}">${k[0]}</span><button type="button" class="ov-link ov-tn" data-ov="rd-open" data-ov-sid="${esc(x.sessionId)}" title="打开原会话阅读（读过后自动移出）">${esc(x.title)}</button>`
        + `<span class="ov-rd-mid"><span class="ov-tl">${esc(x.line || '没写结论')}</span><span class="ov-rd-p">${pathBtn}</span></span>`
        + `<span class="ov-tw" title="${esc(time(x.completedAt))}">${esc(x.when)}</span><button type="button" class="ov-mode" data-ov="rd-read" data-ov-sid="${esc(x.sessionId)}" title="不打开，直接移出"${busy ? ' disabled' : ''}>已读</button></div>`;
    }).join('') || `<div class="ov-empty big">${showOlder ? '没有更早的待读结果。' : '最近 3 天做完的都看过了。'}<br><small>负责人交卷、进展卡写「已完成」、零碎会话答完而你还没点开看，会出现在这里；要你拍板的在「待我决策」。</small></div>`;
    const n = (r.rows || []).length, old = (r.older || []).length;
    const head = confirmAll
      ? `<p><b>把这 ${items.length} 个都标成已读？</b>（不打开会话，只从这里移出）<span class="ov-rd-btns"><button type="button" class="ov-skipall yes" data-ov="rd-all-yes">确定</button><button type="button" class="ov-skipall" data-ov="rd-all-no">取消</button></span></p>`
      : `<p>${showOlder ? `3 天前做完、你还没看的 ${old} 个。` : n ? `${n} 个做完了你还没看，最新的在最上面；点会话名打开阅读，读过自动移出。` : '最近 3 天没有待读的结果。'}${items.length > 1 ? '<button type="button" class="ov-skipall ov-rd-allbtn" data-ov="rd-all">全部标记已读</button>' : ''}</p>`;
    const foot = `<div class="ov-tfoot">${pages > 1 ? `<span class="ov-lp"><button type="button" data-ov="rd-prev"${page ? '' : ' disabled'}>‹</button>${page + 1}/${pages}<button type="button" data-ov="rd-next"${page < pages - 1 ? '' : ' disabled'}>›</button></span>` : '<span></span>'}${old || showOlder ? `<button type="button" class="ov-mode${showOlder ? ' on' : ''}" data-ov="rd-older">${showOlder ? '回到最近 3 天' : `更早 ${old} 个 ▸`}</button>` : ''}</div>`;
    return `<div class="ov-plain one ov-rd-head${confirmAll ? ' warn' : ''}">${head}</div><div class="ov-table">${rows}</div>${foot}`;
  }

  const foot = '<span>只列负责人和零碎会话，成员不单列；交卷与进展卡「已完成」优先，要你拍板的在「待我决策」。</span><span>角标只数 24 小时内负责人交卷 / 已完成的</span>';
  return { click, paint, foot };
}

module.exports = { createReadingTab };
