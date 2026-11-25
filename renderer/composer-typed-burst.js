'use strict';

/**
 * 机器速度的逐字输入收成粘贴块（2026-11-24）。
 *
 * 自研远程桌面在「本地输入法」模式、或剪贴板同步不可用时，会把公司剪贴板拆成一个个
 *
 * 每个字都要写一次 DOM、读一遍全文存草稿：实测已有 300 行时每字主线程 16 ms，2000 行要几十分钟；
 * 而且 Tab 键会把焦点移出输入框，后面的字全落到别处。
 *
 * 这里在输入框上识别「连续多个字、间隔都小于人手极限」的输入段：
 *   - 接管后每个字只追加到内存里的一个粘贴块（composer-paste-chips），不改 DOM；
 *   - 段内的 Tab 当作制表符收进来，不再移走焦点；
 *   - 停顿一会儿算一段结束：够长（同粘贴门槛）就保留为「粘贴文本 #k · N 行」块，
 *     不够长就原样还原成普通文字——人手偶尔连击被误判也不会丢字；
 *   - 远程桌面 400 字一包、包间有网络间隔：块刚收尾、光标仍紧跟块后时，下一包续进同一个块。
 *     续接时先暂扣开头几个字：来得快才续进块；来得慢（人手）就用正常编辑补回输入框。
 * 撤销：块的插入是一步原生编辑，Ctrl+Z 一次撤掉整块；光标在块后按一次退格也整块删掉。
 * 发送、复制、草稿都经过 expandPasteMarkers，发出去的内容与逐字打入的逐字相同。
 */

const chips = require('./composer-paste-chips.js');

// 两个字间隔小于它算「机器速度」：人手最快连击也在 50 ms 以上，远程注入通常 <15 ms。
const FAST_GAP_MS = 35;
// 紧跟在字后面多久以内的 Tab 当作制表符收进来（见 keydown 里的说明）。
const TAB_GAP_MS = 120;
// 连续这么多个快速字符之后才接管（前面几个字照常进输入框，接管时一起收进块）。
const ARM_AFTER = 6;
// 停顿这么久算一段结束。远程桌面 400 字一包，包与包之间隔着网络往返，留足余量。
const IDLE_END_MS = 1200;
// 块收尾后这么久之内、光标仍紧跟块后，再来的快速段续进同一个块。
const RESUME_MS = 5000;
// 续接判定时暂扣的字，这么久没有下一个字就按人手补回输入框。
const HOLD_FLUSH_MS = 80;
// 接收中标签刷新节流；草稿同步节流（输入框被重建时按草稿恢复，不能丢块）。
const LABEL_MS = 80;
const SAVE_MS = 500;

function newlineCount(text) {
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n += 1;
  return n;
}

function attachTypedBurstCapture(inputEl, { document, window, now } = {}) {
  if (!inputEl || inputEl.dataset.typedBurstBound === '1') return null;
  inputEl.dataset.typedBurstBound = '1';
  const clock = typeof now === 'function' ? now : () => window.performance.now();
  const EventCtor = window.Event;

  let lastAt = -Infinity;
  let run = 0;           // 当前快速段已有的字数（未接管时）
  let lead = '';         // 接管前已经照常进了输入框的那几个字
  let keyRepeat = false; // 最近一次 keydown 是否为按住不放的自动重复
  let cap = null;        // 正在接收：{ id, chip, text, lines, idleTimer, labelTimer, savedAt }
  let tail = null;       // 刚收尾、可续接的块：{ id, chip, at }
  let hold = null;       // 续接判定中暂扣的字：{ text, count, timer }

  const trace = [];
  const note = (ev) => { trace.push(ev); if (trace.length > 40) trace.shift(); };
  const focused = () => document.activeElement === inputEl;
  const fireInput = () => inputEl.dispatchEvent(new EventCtor('input', { bubbles: true }));

  function resetRun() { run = 0; lead = ''; }

  // 光标是否紧跟在块后面（块与光标之间没有别的字；块后原有的文字在光标右边，不影响）。
  function caretRightAfter(chip) {
    if (!chip || !chip.isConnected) return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount < 1 || !selection.isCollapsed) return false;
    const node = selection.anchorNode;
    const offset = selection.anchorOffset;
    if (node && node.nodeType === 3 && offset === 0) {
      let prev = node.previousSibling;
      while (prev && prev.nodeType === 3 && prev.data === '') prev = prev.previousSibling;
      return prev === chip;
    }
    if (node === chip.parentNode) {
      let prev = node.childNodes[offset - 1];
      while (prev && prev.nodeType === 3 && prev.data === '') prev = prev.previousSibling;
      return prev === chip;
    }
    return false;
  }

  // 一次原生编辑插入多行文字（换行用 <br>，与 Shift+Enter 同一种结构；可一步撤销）。
  // 逐段 insertText + insertLineBreak 在行尾会把后面的字插到换行前面，实测丢过换行。
  function editInsert(text) {
    const html = String(text).split('\n')
      .map(part => part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
      .join('<br>');
    let ok = false;
    try { ok = document.execCommand('insertHTML', false, html + (text.endsWith('\n') ? '<br>' : '')); } catch { ok = false; }
    return ok;
  }

  // 用正常编辑把文字放到光标处（可撤销）；输入框不在焦点时直接接在块后，不抢焦点。
  function insertPlain(text, anchorChip) {
    if (!text) return;
    if (focused() && editInsert(text)) return;
    const frag = document.createDocumentFragment();
    text.split('\n').forEach((part, i) => {
      if (i > 0) frag.appendChild(document.createElement('br'));
      if (part) frag.appendChild(document.createTextNode(part));
    });
    if (anchorChip && anchorChip.isConnected) anchorChip.after(frag); else inputEl.appendChild(frag);
    fireInput();
  }

  function paintLabel() {
    if (!cap) return;
    cap.labelTimer = null;
    const entry = chips.pasteEntry(cap.id);
    if (entry) { entry.text = cap.text; entry.chars = cap.text.length; entry.lines = cap.lines + 1; }
    cap.chip.dataset.label = `[正在接收逐字输入… ${cap.lines + 1} 行 · ${cap.text.length.toLocaleString()} 字]`;
    if (clock() - cap.savedAt > SAVE_MS) { cap.savedAt = clock(); fireInput(); }
  }

  function append(text) {
    cap.text += text;
    cap.lines += newlineCount(text);
    if (!cap.labelTimer) cap.labelTimer = setTimeout(paintLabel, LABEL_MS);
    clearTimeout(cap.idleTimer);
    cap.idleTimer = setTimeout(finish, IDLE_END_MS);
  }

  // 接管前照常打进去的 lead 紧挨在光标前：把它和块一起选中再插块（一次原生编辑，撤销会原样还回 lead）。
  // lead 跨了换行等拿不准的情况就不并，留作普通文字。
  function selectLeadBeforeCaret() {
    if (!lead) return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount < 1 || !selection.isCollapsed) return false;
    const node = selection.anchorNode;
    const offset = selection.anchorOffset;
    if (!node || node.nodeType !== 3 || !inputEl.contains(node)) return false;
    if (offset < lead.length || node.data.slice(offset - lead.length, offset) !== lead) return false;
    const range = document.createRange();
    range.setStart(node, offset - lead.length);
    range.setEnd(node, offset);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function begin(id, chip, text) {
    cap = { id, chip, text, lines: newlineCount(text), idleTimer: null, labelTimer: null, savedAt: clock() };
  }

  function start(firstText) {
    note('start');
    tail = null;
    const head = selectLeadBeforeCaret() ? lead : '';
    const id = chips.insertPasteChip(inputEl, head, { document, window });
    const chip = inputEl.querySelector(`.fi-paste-chip[data-paste-id="${id}"]`);
    if (!chip) { resetRun(); return false; }
    begin(id, chip, head);
    append(firstText);
    paintLabel();
    return true;
  }

  function finish() {
    if (!cap) return;
    const done = cap;
    cap = null;
    clearTimeout(done.idleTimer);
    clearTimeout(done.labelTimer);
    resetRun();
    lastAt = -Infinity;
    const entry = chips.pasteEntry(done.id);
    if (!done.chip.isConnected || !entry) return;
    if (chips.shouldCollapsePaste(done.text)) {
      entry.text = done.text;
      entry.chars = done.text.length;
      entry.lines = chips.countLines(done.text);
      const index = Number(done.chip.dataset.pasteIndex) || 1;
      done.chip.dataset.label = `[粘贴文本 #${index} · ${entry.lines} 行]`;
      tail = { id: done.id, chip: done.chip, at: clock() };
      note('finish-keep');
    } else {
      // 不够长（多半是手快连击被误判）：把块换回普通文字，和没被接管时一样。
      note('finish-unwrap');
      unwrap(done.chip, done.text);
    }
    fireInput();
  }

  function unwrap(chip, text) {
    if (!focused()) {
      // 不在焦点（例如失焦收尾）：直接换节点，不动选区，不把焦点抢回来。
      const frag = document.createDocumentFragment();
      text.split('\n').forEach((part, i) => {
        if (i > 0) frag.appendChild(document.createElement('br'));
        if (part) frag.appendChild(document.createTextNode(part));
      });
      chip.replaceWith(frag);
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNode(chip);
    selection.removeAllRanges();
    selection.addRange(range);
    const ok = text ? editInsert(text) : document.execCommand('delete');
    if (!ok && chip.isConnected) chip.replaceWith(document.createTextNode(text));
  }

  function flushHold() {
    if (!hold) return;
    const held = hold;
    hold = null;
    clearTimeout(held.timer);
    note('hold-flush');
    // 来得慢，是人手接着块后面打字：照常放进输入框，不再续接这个块。
    const anchor = tail && tail.chip;
    tail = null;
    insertPlain(held.text, anchor);
  }

  // 用户自己动了光标、删改、失焦：正在接收的一段收尾，暂扣的字补回，不再续接。
  function settle() {
    if (cap) finish();
    flushHold();
    tail = null;
    resetRun();
  }

  // 一个字（或换行、制表符）到达。返回 true 表示已被接管（调用方要 preventDefault）。
  function onChar(text) {
    const t = clock();
    const fast = t - lastAt < FAST_GAP_MS && !keyRepeat;
    lastAt = t;
    if (cap) {
      // 输入框被重建（按草稿恢复）后块是新元素：按编号找回；找不到这一段到此为止。
      if (!cap.chip.isConnected) {
        const again = inputEl.querySelector(`.fi-paste-chip[data-paste-id="${cap.id}"]`);
        if (again) cap.chip = again; else { clearTimeout(cap.idleTimer); clearTimeout(cap.labelTimer); cap = null; resetRun(); }
      }
      if (cap && caretRightAfter(cap.chip)) { append(text); return true; }
      if (cap) { note('caret-moved'); finish(); tail = null; }
    }
    if (hold) {
      if (!fast) { flushHold(); run = 1; lead = text; return false; }
      hold.text += text;
      hold.count += 1;
      clearTimeout(hold.timer);
      if (hold.count >= ARM_AFTER) {
        const resumeTail = tail;
        const held = hold.text;
        hold = null;
        tail = null;
        const entry = resumeTail && chips.pasteEntry(resumeTail.id);
        if (!entry || !resumeTail.chip.isConnected) { insertPlain(held, resumeTail && resumeTail.chip); return true; }
        note('resumed');
        begin(resumeTail.id, resumeTail.chip, entry.text);
        append(held);
        paintLabel();
        return true;
      }
      hold.timer = setTimeout(flushHold, HOLD_FLUSH_MS);
      return true;
    }
    if (tail && t - tail.at < RESUME_MS && caretRightAfter(tail.chip)) {
      hold = { text, count: 1, timer: setTimeout(flushHold, HOLD_FLUSH_MS) };
      return true;
    }
    if (!fast) { run = 1; lead = text; return false; }
    run += 1;
    if (run < ARM_AFTER) { lead += text; return false; }
    return start(text);
  }

  inputEl.addEventListener('beforeinput', (e) => {
    if (e.isComposing) { settle(); lastAt = -Infinity; return; }
    const type = e.inputType;
    let text = null;
    if (type === 'insertText' && typeof e.data === 'string' && e.data) text = e.data;
    else if (type === 'insertLineBreak' || type === 'insertParagraph') text = '\n';
    if (text == null) {
      // 删除、撤销、粘贴等：先把正在接收的一段收尾、暂扣的字补回，再按原样处理。
      settle();
      return;
    }
    if (onChar(text)) e.preventDefault();
  }, true);

  inputEl.addEventListener('keydown', (e) => {
    keyRepeat = !!e.repeat;
    if (e.isComposing) return;
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      // 机器忙时注入的按键间隔会被拉长，Tab 的判定放宽到 120 ms：人手打完字 0.12 秒内按 Tab 跳出输入框极少见，
      // 万一误判也只是多一个制表符，看得见、删得掉；而远程粘贴里漏判一次，后面整段字都会落到别处。
      const inBurst = cap || hold || clock() - lastAt < TAB_GAP_MS;
      if (!inBurst) return;
      e.preventDefault();
      e.stopPropagation();
      if (!onChar('\t')) {
        try { document.execCommand('insertText', false, '\t'); } catch {}
      }
      return;
    }
    if (!cap && !hold) return;
    // 修饰键、Shift+Enter（换行由 beforeinput 收）、可打印字符在段内是正常的；其他键（回车发送、方向键、
    // 删除、快捷键）先把这一段收尾，再交给原来的处理——不吞用户的操作。
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta' || e.key === 'Process') return;
    if (e.key === 'Enter' && e.shiftKey) return;
    if ((e.key === 'Unidentified' || Array.from(e.key).length === 1) && !e.ctrlKey && !e.altKey && !e.metaKey) return;
    settle();
  }, true);

  // 鼠标点进输入框要改光标位置：先收尾，后面的字按新位置照常输入。
  inputEl.addEventListener('mousedown', () => { if (cap || hold || tail) settle(); }, true);
  inputEl.addEventListener('blur', () => { if (cap || hold || tail) settle(); });

  const api = {
    finish,
    get capturing() { return !!cap; },
    get trace() { return trace.slice(); },
  };
  inputEl.__typedBurst = api;
  return api;
}

module.exports = { attachTypedBurstCapture, FAST_GAP_MS, ARM_AFTER, IDLE_END_MS };
