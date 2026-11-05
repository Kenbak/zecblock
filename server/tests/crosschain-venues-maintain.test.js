'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseOptions, maintainVenue, main, PAGE_BUDGET_MS } = require('../jobs/maintain-crosschain-venues');

test('defaults cover both venues with bounded pages and reject unknown options', () => {
  const options = parseOptions(['--apply']);
  assert.deepEqual(options.venues, ['maya', 'thorchain']);
  assert.equal(options.apply, true);
  assert.deepEqual(parseOptions(['--venue=maya', '--backfill-pages=300', '--budget-ms=3600000']).venues, ['maya']);
  for (const bad of [['--venue=near'], ['--sync-pages=0'], ['--backfill-pages=1001'], ['--delay-ms=100'], ['--apply', '--apply'], ['--max-pages=2']])
    assert.throws(() => parseOptions(bad));
});

test('dry run writes nothing and apply refuses without the mainnet writer flag', async () => {
  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(line);
  try { await main([], {}); } finally { console.log = original; }
  assert.equal(JSON.parse(logs[0]).writes, false);
  await assert.rejects(main(['--apply'], { NETWORK: 'testnet', CROSSCHAIN_VENUES_WRITER_ENABLED: '1' }), /NETWORK=mainnet/);
  await assert.rejects(main(['--apply'], { NETWORK: 'mainnet' }), /CROSSCHAIN_VENUES_WRITER_ENABLED/);
});

test('each run syncs the head first, backfills within budget and refreshes pending only after a complete sync', async () => {
  const calls = [];
  const deps = {
    traverse: async (_pool, _client, opts) => { calls.push([opts.mode, opts.maxPages]); return { complete: opts.mode === 'sync' }; },
    refresh: async (_pool, _client, opts) => { calls.push(['refresh', opts.limit]); return { checked: 0 }; },
  };
  const options = parseOptions(['--apply']);
  await maintainVenue({}, {}, 'maya', options, () => 150000, () => {}, deps);
  assert.deepEqual(calls, [['sync', 3], ['backfill', 5], ['refresh', 2]]);

  calls.length = 0;
  await maintainVenue({}, {}, 'thorchain', options, () => PAGE_BUDGET_MS * 4, () => {}, deps);
  assert.deepEqual(calls, [['sync', 3], ['backfill', 4], ['refresh', 2]], 'pages are capped by remaining budget');

  calls.length = 0;
  const yielded = await maintainVenue({}, {}, 'maya', options, () => PAGE_BUDGET_MS - 1, () => {}, deps);
  assert.equal(yielded.yielded, 'budget');
  assert.deepEqual(calls, []);

  calls.length = 0;
  await maintainVenue({}, {}, 'maya', options, () => 150000, () => {}, { ...deps, traverse: async (_p, _c, opts) => { calls.push([opts.mode, opts.maxPages]); return { complete: false }; } });
  assert.deepEqual(calls.map(([mode]) => mode), ['sync', 'backfill'], 'no pending refresh after an unfinished sync');
});

test('the systemd unit uses its own lock, the writer flag and a deadline above the job budget', () => {
  const unit = fs.readFileSync(path.join(__dirname, '../deploy/cipherscan-crosschain-venues.service'), 'utf8');
  const timer = fs.readFileSync(path.join(__dirname, '../deploy/cipherscan-crosschain-venues.timer'), 'utf8');
  assert.match(unit, /\/run\/cipherscan-crosschain-venues\.lock/);
  assert.doesNotMatch(unit, /cipherscan-sync-swaps\.lock|NEAR_/);
  assert.match(unit, /NETWORK=mainnet CROSSCHAIN_VENUES_WRITER_ENABLED=1/);
  assert.ok(Number(/TimeoutStartSec=(\d+)/.exec(unit)[1]) * 1000 > parseOptions([]).budgetMs);
  assert.match(timer, /OnCalendar=\*-\*-\* \*:04\/5:00 UTC/);
});
