const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('../scripts/data/hyperunit-deposit-addresses.json');

test('Hyperunit deposit-address list is well formed and disjoint from the hot wallet', () => {
  assert.equal(data.label, 'Hyperunit Deposit');
  assert.equal(data.category, 'exchange');
  assert.ok(data.addresses.length > 0);
  for (const address of data.addresses) {
    assert.match(address, /^t1[1-9A-HJ-NP-Za-km-z]{33}$/, address);
  }
  assert.equal(new Set(data.addresses).size, data.addresses.length, 'duplicate address');
  assert.ok(!data.addresses.includes(data.hotWallet), 'hot wallet must keep its own label');
  assert.deepEqual([...data.addresses].sort(), data.addresses, 'keep sorted for reviewable diffs');
});
