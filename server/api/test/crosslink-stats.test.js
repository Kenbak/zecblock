const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { attachLocals } = require('../routes/crosslink/_helpers');

test('native and legacy BFT connection timestamps drive liveness; unavailable remains null', async () => {
  const app = express();
  const rpc = {
    getblockcount: 100,
    get_tfl_final_block_height_and_hash: { height: 99 },
    getpeerinfo: [],
    get_tfl_roster_zats: ['native', 'legacy', 'unknown'].map(identity => ({ identity, stake_zats: 100000000 })),
    get_tfl_recency_status: { now_utc: 1000, my_height: 20, my_round: 0,
      finalizer_statuses: [
        ['native', { last_direct_connection_utc: 990 }],
        ['legacy', { last_connected_utc: 980 }],
        ['unknown', {}],
      ] },
  };
  app.locals.callZebraRPC = async method => rpc[method];
  app.use(attachLocals, require('../routes/crosslink/stats'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/crosslink`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.liveness.connectedCount, 2);
    assert.equal(body.roster[0].last_connected_utc, 990);
    assert.equal(body.roster[0].connected, true);
    assert.equal(body.roster[1].connected, true);
    assert.equal(body.roster[2].connected, null);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
