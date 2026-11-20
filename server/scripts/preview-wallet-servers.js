#!/usr/bin/env node
// Local-only preview of the real wallet server checks. It probes the
// registered public servers over gRPC and reads the canonical tip and block
// hashes from the public explorer API in place of the database. No DB, chain
// RPC or credentials. Use it as the upstream of the private v1 preview:
//
//   node server/scripts/preview-wallet-servers.js
//   V1_PREVIEW_UPSTREAM=http://127.0.0.1:3112 npm run dev:v1
const path = require('node:path');
const express = require('../api/node_modules/express');
const grpc = require('../api/node_modules/@grpc/grpc-js');
const protoLoader = require('../api/node_modules/@grpc/proto-loader');
const { createWalletServersRouter } = require('../api/routes/wallet-servers');

const UPSTREAM = 'https://api.mainnet.cipherscan.app';
const proto = (name) => path.join(__dirname, '../api/proto', name);
const definition = protoLoader.loadSync([proto('service.proto'), proto('compact_formats.proto')], { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const { CompactTxStreamer } = grpc.loadPackageDefinition(definition).cash.z.wallet.sdk.rpc;

async function read(route) {
  const response = await fetch(`${UPSTREAM}${route}`, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!response.ok) throw new Error('Public preview data unavailable');
  return response.json();
}
// Answers only the two fixed queries server/lib/wallet-servers.js sends.
const pool = { query: async (sql, params = []) => {
  if (sql.includes('MAX(height)')) return { rows: [{ height: (await read('/api/info')).blocks }] };
  const heights = (params[0] || []).filter((height) => Number.isSafeInteger(height) && height >= 0);
  const blocks = await Promise.allSettled(heights.map((height) => read(`/api/block/${height}`)));
  return { rows: blocks.flatMap((block) => (block.status === 'fulfilled' && block.value?.hash ? [{ height: block.value.height, hash: block.value.hash }] : [])) };
} };

const app = express();
Object.assign(app.locals, { grpc, CompactTxStreamer, pool });
app.use(createWalletServersRouter({ network: 'mainnet' }));
// Keep the rest of the explorer usable: forward other public GET reads to the
// fixed public backend, without credentials.
app.use(async (req, res) => {
  if (req.method !== 'GET' || !req.path.startsWith('/api/')) return res.sendStatus(404);
  try {
    const response = await fetch(`${UPSTREAM}${req.originalUrl}`, { signal: AbortSignal.timeout(8000), redirect: 'error' });
    const body = await response.text();
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) return res.sendStatus(502);
    res.status(response.status).type('application/json').send(body);
  } catch { res.status(502).json({ success: false, error: 'Public preview data unavailable' }); }
});
const server = app.listen(3112, '127.0.0.1', () => console.log('Wallet server preview API: http://127.0.0.1:3112/api/network/wallet-servers'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
