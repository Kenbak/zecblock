const { networkName } = require('./network-features');

/**
 * Peer protocol version a node must advertise to follow the network's next or
 * current upgrade. NU7 values come from ZIP 204 as set in Zakura v1.7.0:
 * 170190 on mainnet, 170180 on testnet. Crosslink keeps its NU6.3 reference.
 * A protocol version is self-reported and does not prove a node carries the
 * activation height, so callers describe it as advertised support.
 */
const REFERENCE_PROTOCOLS = {
  mainnet: { protocol: 170190, upgrade: 'NU7' },
  testnet: { protocol: 170180, upgrade: 'NU7' },
  'crosslink-testnet': { protocol: 170160, upgrade: 'NU6.3' },
};

function referenceProtocol(env = process.env) {
  return REFERENCE_PROTOCOLS[networkName(env)] || REFERENCE_PROTOCOLS.mainnet;
}

module.exports = { REFERENCE_PROTOCOLS, referenceProtocol };
