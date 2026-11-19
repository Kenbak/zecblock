const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

function load(file) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} };
  new Function('module', 'exports', code)(m, m.exports);
  return m.exports;
}
const { shieldedShare, recentShieldedShare, SHIELDED_SHARE_DAYS } = load('lib/shielded-share.ts');
const read = file => fs.readFileSync(file, 'utf8');

test('the share is one ratio over the whole range, not the mean of daily percentages', () => {
  // 10/20 on a quiet day and 900/1000 on a busy one: the mean of 50% and 90% would be 70%.
  const days = [{ shielded: 10, transparent: 10 }, { shielded: 900, transparent: 100 }];
  assert.equal(shieldedShare(days).toFixed(2), '89.22');
  assert.equal(shieldedShare([]), null);
  assert.equal(shieldedShare(null), null);
  assert.equal(shieldedShare([{ shielded: 0, transparent: 0 }]), null);
  // An unreadable day is skipped instead of poisoning the total.
  assert.equal(shieldedShare([{ shielded: Number.NaN, transparent: 5 }, { shielded: 1, transparent: 3 }]), 25);
});

test('the headline covers exactly the newest 30 days and never labels a shorter run as 30d', () => {
  assert.equal(SHIELDED_SHARE_DAYS, 30);
  const day = (shielded, transparent) => ({ shielded, transparent });
  assert.equal(recentShieldedShare(Array.from({ length: 29 }, () => day(1, 1))), null);
  // Newest first: 30 days at 75%, then older days that must not count.
  const rows = [...Array.from({ length: 30 }, () => day(3, 1)), ...Array.from({ length: 300 }, () => day(0, 100))];
  assert.equal(recentShieldedShare(rows), 75);
});

test('the stats bar, the Transactions card and the chart all use that one calculation', () => {
  const bar = read('components/StatsBar.tsx');
  assert.match(bar, /recentShieldedShare\(privacy\?\.trends\?\.daily\)/);
  assert.match(bar, /label="Shielded TXs · 30d"/);
  // All time is the chart's "All" range, so the fallback link opens the chart there.
  assert.match(bar, /href="\/txs\?type=shielded&view=activity&trend=all" label="Shielded TXs · all time"/);
  const txs = read('app/txs/TxsClient.tsx');
  assert.match(txs, /shieldedPct30d: recentShieldedShare\(data\.trends\?\.daily\)/);
  assert.match(txs, /share: shieldedShare\(data\)/);
  assert.match(txs, /label=\{`Shielded share \(\$\{periodLabel\}\)`\}/);
  assert.match(txs, /PERIOD_OPTIONS[\s\S]{0,200}id: 'all'/);
});

test('Privacy Score keeps its own history and links each input to the chart that owns it', () => {
  const section = read('components/privacy/PrivacyTrendsSection.tsx');
  assert.doesNotMatch(section, /adoption|BarChart|SHIELDED SHARE|DAILY ACTIVITY/);
  assert.match(section, /dataKey="privacyScore"/);
  assert.match(section, /href="\/txs\?view=activity"/);
  assert.match(section, /href="\/pools"/);
  const page = read('app/privacy/PrivacyClient.tsx');
  assert.match(page, /key: 'usage'[^\n]*href: '\/txs\?view=activity'/);
  assert.match(page, /key: 'depth'[^\n]*href: '\/pools'/);
  assert.match(page, /key: 'hygiene'[^\n]*href: '\/turnstile'/);
});
