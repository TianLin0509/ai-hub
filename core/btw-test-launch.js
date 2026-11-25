'use strict';
const path = require('node:path');
// A test-only executable override. Production launch ignores both variables,
// even if a parent shell accidentally leaves one behind.
function btwTestLaunch(env = process.env) {
  if (env.CLAUDE_HUB_E2E !== '1' || !String(env.CLAUDE_HUB_DATA_DIR || '').trim()
      || !env.CLAUDE_HUB_BTW_TEST_NODE) return null;
  const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
  return ' & ' + quote(env.CLAUDE_HUB_BTW_TEST_NODE) + ' '
    + quote(path.join(__dirname, '../tests/fixtures/btw-tui.js'));
}
module.exports = { btwTestLaunch };
