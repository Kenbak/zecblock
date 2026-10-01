// Deployment identity, not the browser host, controls network-specific data.
function networkName(env = process.env) {
  if (env.NETWORK) {
    const name = env.NETWORK.toLowerCase();
    return name === 'crosslink' ? 'crosslink-testnet' : name;
  }
  if (/crosslink/i.test(env.DB_NAME || '')) return 'crosslink-testnet';
  return /testnet/i.test(env.DB_NAME || '') || /:18232(?:\/|$)/.test(env.ZEBRA_RPC_URL || '') ? 'testnet' : 'mainnet';
}
function isTestnet(env = process.env) { return networkName(env) === 'testnet'; }
function isNonMainnet(env = process.env) { return networkName(env) !== 'mainnet'; }
function mainnetOnly(feature) {
  return (_req, res, next) => {
    if (!isNonMainnet()) return next();
    const network = networkName();
    return res.status(404).json({
      success: false, available: false, network,
      code: 'FEATURE_UNAVAILABLE_ON_NETWORK', feature,
      error: `${feature} is not available on ${network}`,
    });
  };
}
module.exports = { networkName, isTestnet, isNonMainnet, mainnetOnly };
