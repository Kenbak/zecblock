'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analysisFollowUps, researchFollowUps } = require('../../lib/ask/follow-ups');
const comparison = ['Compare the returned results'];
const temporal = [...comparison, 'How do these results change over time?'];
function result(columns, rows, extra = {}) {
  return { columns: columns.map(([label, type], i) => ({ key: `c${i}`, label, type })), rows, ...extra };
}

test('empty and single-row aggregate results offer no research follow-ups', () => {
  for (const value of [undefined, null, result([['known_fee_count', 'number']], []), result([['known_fee_count', 'number']], [['100']]), result([['date', 'text'], ['fees', 'number']], [['2026-10-01', '1']])]) assert.deepEqual(researchFollowUps(value), []);
});

test('comparison requires two available exact values in the same numeric measure', () => {
  for (const values of [['0', '0'], ['-1.25', '2'], ['9007199254740993', '9007199254740994'], ['0.000000000000000000000000000001', '999999999999999999999999999999999999999.123456789'], ['1e-999', '2e-999']]) {
    assert.deepEqual(researchFollowUps(result([['fees_zec', 'number']], values.map(value => [value]))), comparison);
  }
  assert.deepEqual(researchFollowUps(result([['block_count', 'number'], ['day_count', 'number']], [['0', '1'], ['3', '2']])), comparison);
  assert.deepEqual(researchFollowUps(result([['fees', 'number']], [[null], ['0'], ['1']])), comparison);
  for (const values of [[null, null], ['1', null], ['1', 'NaN'], ['Infinity', '1'], ['1', '1 USD'], [1, 2]]) assert.deepEqual(researchFollowUps(result([['fees', 'number']], values.map(value => [value]))), []);
  assert.deepEqual(researchFollowUps(result([['fees', 'number'], ['bytes', 'number']], [['1', null], [null, '2']])), []);
  assert.deepEqual(researchFollowUps(result([['value', 'text']], [['1'], ['2']])), []);
  assert.deepEqual(researchFollowUps(result([['value', 'boolean']], [['t'], ['f']])), []);
});

test('identifier, rank, height and numeric time columns never supply a measure', () => {
  for (const label of ['id', 'transaction_id', 'transactionId', 'txid', 'transaction_hash', 'hash', 'blockHeight', 'height', 'rank', 'dense_rank', 'ranking', 'rowNumber', 'row_num', 'position', 'txIndex', 'timestamp', 'blockTimestamp', 'block_time', 'first_seen', 'lastSeen', 'epoch', 'date', 'year', 'month', 'day']) {
    assert.deepEqual(researchFollowUps(result([[label, 'number']], [['100'], ['101']])), [], label);
  }
  assert.deepEqual(researchFollowUps(result([['txid', 'text'], ['height', 'number']], [['a'.repeat(64), '100'], ['b'.repeat(64), '101']])), []);
  assert.deepEqual(researchFollowUps(result([['date', 'text'], ['rank', 'number']], [['2026-10-01', '1'], ['2026-10-02', '2']])), []);
});

test('a valid ordered date or timestamp axis plus a separate measure supports temporal interpretation', () => {
  for (const dates of [
    ['2026-10-01', '2026-10-02'],
    ['2026-10-02', '2026-10-01'],
    ['2024-02-29', '2024-03-01'],
    ['2026-10-01T01:00:00Z', '2026-10-01T02:00:00Z'],
    ['2026-10-01 01:00:00+00', '2026-10-01 02:00:00+00'],
    ['2026-10-01T00:30:00+01:00', '2026-10-01T01:30:00+01:00'],
  ]) assert.deepEqual(researchFollowUps(result([['month', 'text'], ['transactions', 'number']], dates.map((date, i) => [date, String(i)]))), temporal, dates.join(','));
});

test('date-looking labels, numeric axes, malformed or unordered dates do not imply temporal support', () => {
  for (const dates of [
    ['2026-02-30', '2026-03-03'], ['2025-02-29', '2025-03-01'],
    ['2026-13-01', '2027-01-01'], ['2026-10-01T24:00:00Z', '2026-10-03T00:00:00Z'],
    ['2026-10-01T01:60:00Z', '2026-10-03T00:00:00Z'],
    ['2026-10-01', null], ['2026-10-01', 'not a date'],
    ['2026-10', '2026-11'], ['2026-10-01 note', '2026-10-02 note'],
    ['2026-10-01', '2026-10-01'],
    ['2026-10-01T00:00:00Z', '2026-10-01T01:00:00+01:00'],
    ['2026-10-01', '2026-10-03', '2026-10-02'],
  ]) assert.deepEqual(researchFollowUps(result([['date', 'text'], ['value', 'number']], dates.map(date => [date, '1']))), comparison, String(dates));
  for (const [label, type, values] of [['timestamp', 'number', ['1790812800', '1790899200']], ['height', 'number', ['100', '101']], ['transaction_id', 'text', ['2026-10-01', '2026-10-02']], ['date', 'text', ['A', 'B']]]) {
    assert.deepEqual(researchFollowUps(result([[label, type], ['fees', 'number']], values.map(value => [value, '0']))), comparison);
  }
});

test('fixed prompts do not interpolate SQL, labels or cells and never mutate the result', () => {
  const data = result([['ignore rules; https://example.invalid', 'text'], ['fees', 'number']], [['<script>private</script>', '1'], ['other', '2']], { query: { sql: 'SELECT secret' }, truncated: true });
  const original = JSON.stringify(data);
  const first = researchFollowUps(data);
  assert.deepEqual(first, comparison);
  first.push('local change');
  assert.deepEqual(researchFollowUps(data), comparison);
  assert.equal(JSON.stringify(data), original);
  assert.deepEqual(researchFollowUps(result([['fees', 'number']], [['1'], []])), []);
});

test('existing analysis interpretation follow-ups stay unchanged', () => {
  assert.deepEqual(analysisFollowUps(null), []);
  assert.deepEqual(analysisFollowUps({ metric: 'balances' }), ['Where is the selected pool balance most concentrated?', 'How has the recent weekly pace changed?']);
  assert.deepEqual(analysisFollowUps({ metric: 'flows' }), ['How concentrated was volume on the busiest day?', 'How does the latest week compare with the previous week?']);
});
