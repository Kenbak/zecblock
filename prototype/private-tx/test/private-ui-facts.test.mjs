import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../ui/private-record-facts.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { exactZec, privateFeeLabel } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('private fee presentation distinguishes unknown, coinbase and exact zero', () => {
  assert.equal(privateFeeLabel({ feeZat: null, fee: null }), 'Unavailable');
  assert.equal(privateFeeLabel({ feeZat: null, isCoinbase: true }), 'Not applicable (coinbase)');
  assert.equal(privateFeeLabel({ feeZat: '0' }), '0.00000000 ZEC');
  assert.equal(privateFeeLabel({ fee: 0 }), 'Unavailable');
  assert.equal(privateFeeLabel({ feeZat: 10_000 }), 'Unavailable');
  assert.equal(privateFeeLabel({ feeZat: '-1' }), 'Unavailable');
});

test('captured exact balances keep zatoshi precision beyond safe Number range', () => {
  assert.equal(privateFeeLabel({ feeZat: '9007199254740993' }), '90071992.54740993 ZEC');
  assert.equal(exactZec('-9007199254740993', true), '-90071992.54740993');
  assert.equal(exactZec('-1', true), '-0.00000001');
  assert.equal(exactZec('1', true), '0.00000001');
  assert.equal(exactZec('0', true), '0.00000000');
});

test('missing or inexact amount observations remain unavailable', () => {
  for (const value of [undefined, null, 0, 1.5, '1.5', '1e8', '01', '', 'NaN', 'Infinity']) assert.equal(exactZec(value, true), null);
});
