'use strict';
// Fake Claude TUI for isolated Hub tests. No AI or account access.
const fs = require('node:fs');
const path = require('node:path');
if (process.env.CLAUDE_HUB_E2E !== '1' || !process.env.CLAUDE_HUB_DATA_DIR) process.exit(2);
const log = path.join(process.env.CLAUDE_HUB_DATA_DIR, 'btw-fixture.jsonl');
const record = event => fs.appendFileSync(log, JSON.stringify({ ...event, sessionId: process.env.CLAUDE_HUB_SESSION_ID, at: Date.now() }) + '\n', 'utf8');
let input = '', overlay = false, paste = false, pending = '';
const draw = body => process.stdout.write('\x1b[2J\x1b[H' + body.replace(/\n/g, '\r\n'));
const idle = () => draw('Claude Code fixture\n\n❯ \n\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n');
function submit() {
  const command = input.trim(); input = '';
  record({ type: 'submit', command, overlay });
  if (!command.startsWith('/btw ')) { idle(); return; }
  overlay = true;
  draw(`Claude Code fixture\n\n  ${command}\n\n    Thinking…\n\n  ↑/↓ to scroll · c to copy · f to fork · Esc to close\n`);
  setTimeout(() => {
    if (!overlay) return;
    draw(`Claude Code fixture\n\n  ${command}\n\n    红杉-9：正在验证问一下。主控会话继续工作。\n\n  ↑/↓ to scroll · c to copy · f to fork · Esc to close\n`);
    record({ type: 'answered' });
  }, Number(process.env.CLAUDE_HUB_BTW_TEST_DELAY_MS) || 700);
}
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8'); process.stdin.resume();
process.stdin.on('data', chunk => {
  pending += chunk;
  while (pending) {
    if (pending.startsWith('\x1b[200~')) { paste = true; pending = pending.slice(6); continue; }
    if (pending.startsWith('\x1b[201~')) { paste = false; pending = pending.slice(6); continue; }
    if (pending.startsWith('\x1b[') && pending.length < 6) return;
    const char = pending[0]; pending = pending.slice(1);
    if (char === '\x03') { record({ type: 'exit' }); process.exit(0); }
    if (char === '\x1b') { record({ type: 'esc', overlay }); overlay = false; idle(); continue; }
    if (!paste && (char === '\r' || char === '\n')) { if (input) submit(); continue; }
    if (overlay) { record({ type: 'overlay-key', char }); continue; }
    input += char;
  }
});
record({ type: 'ready' }); idle();
