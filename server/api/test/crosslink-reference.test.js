const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const router = require('../routes/crosslink');
const { usableForkReference, matchKnownSamples } = require('../routes/crosslink/_helpers');
const { createAttestationRouter } = require('../routes/attestations');
const hash = 'a'.repeat(64);

test('deployed Crosslink network alias starts the attestation router', () => {
  assert.doesNotThrow(() => createAttestationRouter({ network: 'crosslink' }));
  assert.throws(() => createAttestationRouter({ network: 'invalid' }), /Invalid attestation network/);
});

test('degraded and display-only cTAZ references cannot establish alignment', () => {
  const reference = { tip: 666052, tip_hash: hash };
  assert.equal(usableForkReference({ reference }), true);
  assert.equal(usableForkReference({ degraded: true, reference }), false);
  assert.equal(usableForkReference({ reference: { ...reference, authority: false } }), false);
  assert.equal(usableForkReference({ reference: { tip: null, tip_hash: null } }), false);
});

test('unknown registration samples supply no branch evidence', () => {
  assert.equal(matchKnownSamples([{ height: 42, hash }], () => null), null);
  assert.equal(matchKnownSamples([{ height: 42, hash }], () => hash), true);
  assert.equal(matchKnownSamples([{ height: 42, hash }], () => 'b'.repeat(64)), false);
});

test('degraded public fallback is unavailable, preserves null finality and leaves unobserved nodes unknown', async t => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => String(url).startsWith('http://127.0.0.1:')
    ? originalFetch(url, options)
    : { ok: true, json: async () => ({ degraded: true, reference: { tip: null, tip_hash: null, finalized: null, finality_gap: null } }) };
  t.after(() => { global.fetch = originalFetch; });
  const app = express();
  Object.assign(app.locals, {
    redisClient: null,
    callZebraRPC: async method => method === 'getblockcount' ? 100
      : method === 'get_tfl_final_block_height_and_hash' ? { height: 99 }
        : method === 'getpeerinfo' ? [] : hash,
    pool: { query: async () => ({ rows: [{ name: 'unobserved', sample_hashes: [{ height: 42, hash }] }] }) },
    writePool: { query: async () => ({ rows: [] }) },
  });
  app.use(router);
  const server = await new Promise(resolve => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
  });
  t.after(() => server.close());
  const response = await originalFetch(`http://127.0.0.1:${server.address().port}/api/crosslink/fork-monitor`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ctaz_unavailable');
  assert.equal(body.ctaz.finalized, null);
  assert.equal(body.ctaz.finality_gap, null);
  assert.equal(body.nodes[0].branch, 'unknown');
});
