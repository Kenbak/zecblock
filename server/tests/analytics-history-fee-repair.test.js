'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { options, normalize, changed, FEES_SQL } = require('../scripts/repair-analytics-history-fees');

test('fee repair requires explicit bounded dates and a report to apply', () => {
  assert.throws(() => options([]), /Explicit bounded dates/);
  assert.throws(() => options(['--from=2017-01-01', '--to=2017-01-02', '--apply']), /report/);
  const opt = options(['--from=2017-01-01', '--to=2017-01-03']);
  assert.deepEqual(opt.dates, ['2017-01-01', '2017-01-02', '2017-01-03']);
  assert.equal(opt.apply, false);
});

test('only percentile keys decide whether a day changed', () => {
  const stored = { p10: '10000', median: 10000, avgFee: '465000000.5', txCount: 3, blockCount: 576, minerDestinationRows: 4 };
  assert.equal(changed(stored, { ...stored, blockCount: 1 }), false);
  assert.equal(changed(stored, { ...stored, avgFee: 10000 }), true);
  assert.deepEqual(normalize({ p10: '1', txCount: 2 }), {
    p10: 1, p25: null, median: null, p75: null, p90: null, avgFee: null, txCount: 2,
  });
});

test('recompute uses the daily job definition (positive non-coinbase fees)', () => {
  assert.match(FEES_SQL, /NOT is_coinbase AND fee>0/);
  assert.match(FEES_SQL, /block_time >= \$1 AND block_time < \$2/);
});
