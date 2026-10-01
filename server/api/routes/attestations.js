const express = require('express');
const { fetchArtifact, readCanarySnapshot, attachCanary } = require('../../lib/canary');
const { canaryConfig } = require('../../canary/config.js');
const { readSnapshot, publicSnapshot } = require('../../lib/attestation-store');

function createAttestationRouter({ read = readSnapshot, network = process.env.ZCASH_NETWORK || process.env.NETWORK || 'mainnet', now = Date.now, readCanary = readCanarySnapshot, artifact = fetchArtifact } = {}) {
  const router = express.Router();
  // The deployed feature-net service uses NETWORK=crosslink. Attestation
  // documents use the explicit crosslink-testnet identity for that network.
  const configuredNetwork = network.toLowerCase() === 'crosslink' ? 'crosslink-testnet' : network.toLowerCase();
  if (!['mainnet', 'testnet', 'crosslink-testnet'].includes(configuredNetwork)) throw new Error('Invalid attestation network');
  // Canary's CLI requires an origin, so its protocol artifacts live at fixed
  // root paths. Preserve exact canonical bytes (especially keys.json).
  router.get(['/config.json', '/keys.json', '/status.json', '/targets/:id/statement', '/targets/:id/evidence', '/targets/:id/history'], async (req, res) => {
    res.set('X-Robots-Tag', 'noindex, follow');
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if (!['mainnet', 'testnet'].includes(configuredNetwork)
      || (req.params.id && !canaryConfig(configuredNetwork).targets.some(t => t.id === req.params.id))) {
      return res.status(404).json({ error: 'Unknown Canary target' });
    }
    try { return res.type('application/json').send(await artifact(req.path)); }
    catch { return res.status(503).json({ error: 'Canary artifact unavailable' }); }
  });
  router.get(['/api/network/attestations', '/api/network/attestations/:id'], async (req, res) => {
    res.set('X-Robots-Tag', 'noindex, follow');
    // Dynamic freshness must not be hidden by a stale CDN success.
    res.set('Cache-Control', 'no-store');
    let snapshot = null;
    const results = await Promise.allSettled([read(), readCanary()]);
    if (results[0].status === 'fulfilled') snapshot = results[0].value;
    const report = results[1].status === 'fulfilled' ? results[1].value : null;
    const data = attachCanary(publicSnapshot(snapshot, configuredNetwork, now()), report, now());
    if (req.params.id) {
      const endpoint = data.endpoints.find((entry) => entry.id === req.params.id);
      if (!endpoint) return res.status(404).json({ success: false, error: 'Unknown attestation endpoint', network: configuredNetwork });
      return res.json({ ...data, endpoints: undefined, endpoint });
    }
    return res.json(data);
  });
  return router;
}
module.exports = { createAttestationRouter };
