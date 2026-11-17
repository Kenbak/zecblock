'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// The sticky notice sits at nav + --app-stats-height. If this value and the
// stats bar's real box differ, a strip of scrolling page shows between them.
test('--app-stats-height matches the stats bar box at every breakpoint', () => {
  const bar = fs.readFileSync('components/StatsBar.tsx', 'utf8');
  const css = fs.readFileSync('app/globals.css', 'utf8');
  assert.match(bar, /className="flex h-9 sm:h-10 items-center/);
  assert.match(css, /--app-stats-height: calc\(2\.25rem \+ 1px\);/);
  assert.match(css, /@media \(min-width: 640px\) \{\s*:root \{ --app-stats-height: calc\(2\.5rem \+ 1px\); \}/);
  // The 1px is the bar's bottom border from the shared chrome rule.
  assert.match(css, /\.stats-bar,\s*\n?\s*[^{]*\{[^}]*border-bottom: 1px solid/);
  // Nothing may overwrite it at runtime with a measured (possibly stale) value.
  assert.doesNotMatch(bar, /setProperty\('--app-stats-height'/);
});
