const test = require('node:test');
const assert = require('node:assert/strict');
const { referenceProtocol } = require('../api/lib/upgrade-protocol');

test('node readiness measures NU7 peer protocol per network (ZIP 204)', () => {
  assert.deepEqual(referenceProtocol({ NETWORK: 'mainnet' }), { protocol: 170190, upgrade: 'NU7' });
  assert.deepEqual(referenceProtocol({ NETWORK: 'testnet' }), { protocol: 170180, upgrade: 'NU7' });
  assert.deepEqual(referenceProtocol({ NETWORK: 'crosslink' }), { protocol: 170160, upgrade: 'NU6.3' });
  // The NU6.3 baseline no longer counts as ready on mainnet.
  assert.ok(170160 < referenceProtocol({ NETWORK: 'mainnet' }).protocol);
});
