'use strict';

// Browser origins allowed to read the HTTP API with CORS.
//
// This list governs HTTP CORS only. WebSocket upgrades use the separate
// OWN_ORIGINS list in server.js, and neither list affects rate limiting
// (only a service key bypasses the limiter).

const OWN_HTTP_ORIGINS = [
  'https://testnet.cipherscan.app',
  'https://testnet.zecblock.com',
  'https://cipherscan.app',
  'https://zecblock.com',
  'https://www.zecblock.com',
  'https://crosslink.cipherscan.app',
  'https://crosslink.zecblock.com',
  'http://localhost:3000',
  'http://localhost:3001',
];

// Third-party pages that read public chain data from visitors' browsers.
// They receive normal per-IP rate limits and no WebSocket access.
const PARTNER_HTTP_ORIGINS = [
  'https://nsm.shieldedlabs.net', // Shielded Labs NSM balance page (reads /v1/network/accounting)
];

function parseExtraOrigins(value) {
  return (value || '').split(',').map((origin) => origin.trim()).filter(Boolean);
}

function allowedHttpOrigins(env = process.env) {
  return [...OWN_HTTP_ORIGINS, ...PARTNER_HTTP_ORIGINS, ...parseExtraOrigins(env.CORS_ORIGINS)];
}

module.exports = { OWN_HTTP_ORIGINS, PARTNER_HTTP_ORIGINS, allowedHttpOrigins };
