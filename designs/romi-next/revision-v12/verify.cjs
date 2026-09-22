const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const json = name => JSON.parse(read(name));
const babel = require('../vendor/babel.js');
for (const name of ['app.jsx','screens.jsx','components.jsx']) babel.transform(read(name), {presets:['react']});
const checks = json('responsive-checks.json');
assert.equal(checks.length, 12);
for (const r of checks) {
  assert(!r.overflow && !r.reconnect && !r.copyText);
  for (const row of r.rows) {
    assert(!row.overflow);
    if (r.width > 1100) assert.equal(new Set(row.primary.map(p=>p.top)).size, 1);
    else assert.equal(row.primary[3].top, row.primary[4].top);
  }
  assert(r.gaps.every(g=>g===6));
}
const i = json('interaction-checks.json');
assert.equal(i.copyBefore.opacity, '0');
assert.equal(i.copyHovered.opacity, '1');
assert.equal(i.copyBefore.gap, 6);
assert.deepEqual(i.copyBefore.rect, i.copyHovered.rect);
assert(i.keyboardIcon.focused && i.keyboardIcon.opacity === '1');
for (const copy of i.copies) assert.equal(copy.actual, copy.expected);
assert(i.touch.coarse && i.touch.hoverNone && i.touch.opacity === '0.65' && i.touch.height >= 44);
assert(!i.longIP.overflow && !i.longIP.pageOverflow && i.longIP.gap === 6);
assert.equal(i.menuInstallCount, 1);
assert.match(i.installationTarget, /node-1/);
assert.deepEqual(i.consoleErrors, []);
console.log('JSX syntax, 12 layouts, copy hover/focus/touch and install-menu checks passed.');
