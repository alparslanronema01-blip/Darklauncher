'use strict';
// Standalone verification for the .lnk parser + repair decision.
// Runs against the REAL Darklauncher shortcut on this machine's desktop.

const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require(path.join(__dirname, '..', 'src', 'shortcut.js'));

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.error(`  FAIL  ${name}`); failures++; }
}

// ---- parse the real shortcut (if present)
const lnk = path.join(os.homedir(), 'Desktop', 'Darklauncher.lnk');
if (fs.existsSync(lnk)) {
  const buf = fs.readFileSync(lnk);
  const parsed = s.parseLinkStrings(buf);
  check('real .lnk parsed', !!parsed);
  check('iconLocation read', !!(parsed && parsed.iconLocation));
  check('target (localBasePath) read', !!(parsed && parsed.localBasePath));
  console.log('    icon :', parsed.iconLocation);
  console.log('    target:', parsed.localBasePath);

  // Repair decision when paths match the shortcut's own install dir:
  const target = parsed.localBasePath || '';
  const icoOfTarget = path.join(path.dirname(target), 'build', 'darklauncher-icon.ico');
  const selfDirOk = s.shortcutNeedsRepair(buf, target, icoOfTarget) === null;
  check('healthy shortcut needs no repair', selfDirOk);
} else {
  console.log('  (no real Darklauncher.lnk on this desktop - skipping live checks)');
}

// ---- repair decision on synthetic buffers is exercised in smoke.test.js
console.log(failures ? `\n${failures} failure(s)` : '\nAll live checks passed');
process.exit(failures ? 1 : 0);
