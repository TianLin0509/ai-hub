'use strict';
const { parseBtwOverlay, PREFIX } = require('./btw-screen');
const CLOSE_ERROR = '浮层未能自动关闭，请在后台终端按 Esc';
const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));

async function closeBtwOverlay({ write, readScreen, sleep = sleepDefault, now = Date.now }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    // Read again immediately before EVERY Esc, including retries and cleanup.
    if (!parseBtwOverlay(await readScreen()).open) return;
    await write('\x1b');
    const deadline = now() + 2000;
    do {
      if (!parseBtwOverlay(await readScreen()).open) {
        // A VT redraw can briefly clear the footer. Confirm the disappearance
        // on a second read before releasing the prompt queue.
        await sleep(100);
        if (!parseBtwOverlay(await readScreen()).open) return;
      }
      await sleep(100);
    } while (now() < deadline);
  }
  if (!parseBtwOverlay(await readScreen()).open) return;
  throw Object.assign(new Error(CLOSE_ERROR), { code: 'BTW_CLOSE_FAILED' });
}

async function askBtw({ submit, write, readScreen, sleep = sleepDefault, now = Date.now, question, timeoutMs = 90000 }) {
  const q = String(question || '').trim();
  if (!q) throw new Error('请先填写问题');
  // A slash command is a single editor line; do not let pasted control bytes
  // become terminal keys or a second command.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(q)) throw new Error('问题含有终端控制字符');
  const command = '/btw ' + PREFIX + q.replace(/[\r\n]+/g, ' ');
  const io = { write, readScreen, sleep, now };
  await closeBtwOverlay(io); // A failure here must not submit a new question.
  const started = now(), deadline = started + timeoutMs;
  let result, failure;
  try {
    const receipt = await submit(command);
    if (receipt?.ok === false || receipt?.sendStatus === 'stuck') throw new Error(receipt.message || '未确认 /btw 已送达，请查看后台终端；未自动重发');
    let previous = null;
    while (now() < deadline) {
      const parsed = parseBtwOverlay(await readScreen(), command.slice(5));
      if (parsed.complete && previous === parsed.answer) { result = parsed; break; }
      previous = parsed.complete ? parsed.answer : null;
      await sleep(250);
    }
    if (!result) throw Object.assign(new Error('问一下等待超时，请查看后台终端'), { code: 'BTW_TIMEOUT' });
  } catch (error) { failure = error; }
  // Also close a timed-out/loading overlay, but never Esc a running main turn.
  try { await closeBtwOverlay(io); }
  catch (error) { error.answer = result?.answer || ''; error.truncated = !!result?.truncated; error.cause = failure; throw error; }
  if (failure) throw failure;
  return { ...result, wall_s: Math.round((now() - started) / 100) / 10 };
}

module.exports = { askBtw, closeBtwOverlay, CLOSE_ERROR };
