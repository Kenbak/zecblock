const express = require('express');
const { createWalletServerMonitor, probeEndpoint, readChain, publicSnapshot } = require('../../lib/wallet-servers');

function createWalletServersRouter({ monitor = null, network = process.env.ZCASH_NETWORK || process.env.NETWORK || 'mainnet' } = {}) {
  const router = express.Router();
  const configuredNetwork = network.toLowerCase() === 'crosslink' ? 'crosslink-testnet' : network.toLowerCase();
  if (!['mainnet', 'testnet', 'crosslink-testnet'].includes(configuredNetwork)) throw new Error('Invalid wallet server network');
  let instance = monitor;
  router.get('/api/network/wallet-servers', async (req, res) => {
    res.set('X-Robots-Tag', 'noindex, follow');
    // Freshness is part of the answer; a CDN must not replay an old success.
    res.set('Cache-Control', 'no-store');
    let snapshot = null;
    try {
      const { grpc, CompactTxStreamer, pool } = req.app.locals;
      if (!instance && grpc && CompactTxStreamer && pool) {
        instance = createWalletServerMonitor({
          network: configuredNetwork,
          probe: (endpoint) => probeEndpoint(endpoint, { grpc, CompactTxStreamer }),
          readChain: (heights) => readChain(pool, heights),
        });
      }
      if (instance) snapshot = await instance.read();
    } catch { /* The registry and an explicit unavailable state still answer. */ }
    return res.json(publicSnapshot(snapshot, configuredNetwork));
  });
  return router;
}
module.exports = { createWalletServersRouter };
