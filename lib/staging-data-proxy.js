/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';
require('server-only');

const PUBLIC_ORIGIN = 'https://api.zecblock.com';
const PREFIX = '/api/staging-data';
const MAX_RESPONSE_BYTES = 1024 * 1024;
// Public GETs used by Ask evidence/labels, the stats bar, freshness checks and
// bounded rich-list recovery after a protected-preview SSR deadline.
// Keep this list exact: Ask, job, scan, and arbitrary API routes are excluded.
const PUBLIC_PATHS = new Set([
  '/health', '/v1/blocks', '/v1/mempool', '/v1/labels',
  '/v1/addresses/rich-list',
  '/v1/network/price', '/v1/network/stats', '/v1/network/info',
  '/v1/privacy/stats', '/v1/pulse',
  '/v1/shielded-pools/history', '/v1/shielded-pools/flows',
  '/v1/crosschain/trends', '/v1/crosschain/volume-by-chain',
  '/api/privacy-stats', '/api/pulse', '/api/network/pool-history',
  '/api/pools/flows', '/api/crosschain/trends', '/api/crosschain/volume-by-chain',
]);
const PRIVATE_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'private, no-store, max-age=0',
  'cdn-cache-control': 'no-store',
  'vercel-cdn-cache-control': 'no-store',
  'x-robots-tag': 'noindex, follow',
  'x-content-type-options': 'nosniff',
};
function validRichListPaging(params) {
  for (const [key, value] of params) {
    if (!['limit', 'offset'].includes(key) || params.getAll(key).length !== 1 || !/^(?:0|[1-9]\d*)$/.test(value)) return false;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || key === 'limit' && (number < 1 || number > 500) || key === 'offset' && number > 100000) return false;
  }
  return true;
}
function failure(status) {
  return Response.json({ type: 'upstream-error', detail: 'Public staging data is unavailable.' }, { status, headers: PRIVATE_HEADERS });
}
function createStagingDataProxy(env = process.env, fetchImpl = fetch, timeoutMs = 9000) {
  return async function proxy(request) {
    if (env.VERCEL_ENV !== 'preview' || env.ASK_STAGING_ENABLED !== 'true') return failure(404);
    if (request.method !== 'GET') return failure(405);
    let url;
    try { url = new URL(request.url); } catch { return failure(400); }
    const path = url.pathname.startsWith(PREFIX + '/') ? url.pathname.slice(PREFIX.length) : '';
    if (url.hash || !PUBLIC_PATHS.has(path)) return failure(404);
    if (Buffer.byteLength(url.search, 'utf8') > 4096) return failure(414);
    if (path === '/v1/addresses/rich-list' && !validRichListPaging(url.searchParams)) return failure(400);
    if (request.signal.aborted) return failure(499);
    // The query is never interpreted as an upstream URL or used to choose a host.
    const target = new URL(path, PUBLIC_ORIGIN);
    target.search = url.search;
    const controller = new AbortController();
    let timedOut = false, reader, timer, rejectAbort;
    const abortFromCaller = () => controller.abort();
    const interrupted = new Promise((_, reject) => {
      rejectAbort = () => reject(Error('Request interrupted'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    request.signal.addEventListener('abort', abortFromCaller, { once: true });
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    if (request.signal.aborted) abortFromCaller();
    const work = async () => {
      // Never use fetchWithDeadline here: it injects a server service key.
      const upstream = await fetchImpl(target, {
        method: 'GET', headers: { accept: 'application/json' },
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (upstream.status < 200 || upstream.status > 599 || upstream.status >= 300 && upstream.status < 400
        || !/^application\/(?:json|problem\+json)(?:\s*;|\s*$)/i.test(upstream.headers.get('content-type') || '')) throw Error('Invalid upstream response');
      const length = upstream.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw Error('Response too large');
      reader = upstream.body?.getReader();
      if (!reader) throw Error('Missing response');
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw Error('Response too large');
        chunks.push(Buffer.from(value));
      }
      const data = Buffer.concat(chunks);
      JSON.parse(data.toString('utf8'));
      const headers = { ...PRIVATE_HEADERS, 'content-type': upstream.headers.get('content-type').split(';')[0].trim().toLowerCase() };
      const retry = upstream.headers.get('retry-after');
      if (retry && /^\d{1,5}$/.test(retry)) headers['retry-after'] = retry;
      return new Response(data, { status: upstream.status, headers });
    };
    try { return await Promise.race([work(), interrupted]); }
    catch { return failure(controller.signal.aborted ? timedOut ? 504 : 499 : 502); }
    finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abortFromCaller);
      controller.signal.removeEventListener('abort', rejectAbort);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
  };
}
const proxyStagingData = createStagingDataProxy();
module.exports = { proxyStagingData, createStagingDataProxy };
