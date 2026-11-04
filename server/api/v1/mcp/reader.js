'use strict';

const { MANIFEST } = require('../inventory/manifest');
const { buildAdapterHandler, fillLegacyPath } = require('../lib/build-route');
const queryParameters = require('../inventory/query-parameters.json');

// Adapt the existing response-producing handler to a value-producing MCP call.
// This small response sink deliberately supports only the methods used by the
// public adapters. It avoids a second HTTP hop, duplicate SQL or monetary logic.
function responseSink(req) {
  const headers = new Map();
  return {
    req, statusCode: 200, body: undefined,
    status(value) { this.statusCode = value; return this; },
    set(name, value) { headers.set(name.toLowerCase(), String(value)); return this; },
    get(name) { return headers.get(name.toLowerCase()); },
    json(value) { this.body = value; return this; },
  };
}

function createReader({ internalClient, config }) {
  return async function read(tool, input, parentRequest, signal) {
    const entry = MANIFEST.find(e => e.method === 'GET' && e.v1.path === tool.path);
    if (!entry || entry.classification !== 'public' || entry.auth !== 'none' || entry.v1.status !== 'adapter'
      || entry.v1.forwardNodeToken || entry.v1.forwardPaymentAuth || entry.v1.rateLimitKey) {
      throw new Error('MCP tool is not an eligible public read.');
    }
    const params = {};
    const query = {};
    const pathKeys = [...tool.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
    const allowedQuery = queryParameters[`GET ${tool.path}`] || [];
    for (const [key, value] of Object.entries(input)) {
      if (pathKeys.includes(key)) params[key] = String(value);
      else if (allowedQuery.includes(key)) query[key] = String(value);
      else throw new Error('MCP argument is outside the public route contract.');
    }
    const path = fillLegacyPath(tool.path, params);
    const req = {
      params, query, headers: {}, originalUrl: path,
      v1: { ...parentRequest.v1, warnings: [], abortSignal: signal },
    };
    // Do not copy the outer context's resolver: it closes over the ordinary
    // 50-MiB client and original request signal. Metadata must obey the same
    // bounded client and combined cancellation signal as the tool data.
    req.v1.resolveIndexedHeight = async () => {
      if (req.v1.indexedHeight != null) return req.v1.indexedHeight;
      try {
        const result = await internalClient.dispatch('GET', '/api/info', { parentSignal: signal });
        if (result.ok && Number.isSafeInteger(result.body?.height) && result.body.height >= 0) req.v1.indexedHeight = result.body.height;
      } catch { /* Tip metadata is best effort; never invent an indexed height. */ }
      return req.v1.indexedHeight ?? null;
    };
    const res = responseSink(req);
    await buildAdapterHandler(entry, internalClient, config)(req, res);
    if (res.body === undefined) throw new Error('Public adapter did not produce a response.');
    const host = config.network === 'mainnet' ? 'https://api.zecblock.com'
      : config.network === 'crosslink-testnet' ? 'https://api.crosslink.zecblock.com' : 'https://api.testnet.zecblock.com';
    const url = new URL(path, host);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return { ...res.body, endpoint: url.href, httpStatus: res.statusCode };
  };
}

module.exports = { createReader };
