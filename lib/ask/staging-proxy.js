/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';
require('server-only');
const https = require('node:https');
const { isIP } = require('node:net');

const UPSTREAM = 'https://135.181.17.198:8443';
const PREFIX = '/api/ask-staging';
const BODY_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 300 * 1024;
const POST_PATHS = new Set([
  '/v1/ask/chat', '/v1/ask/research/plan', '/v1/ask/research/query',
  '/v1/ask/research/jobs', '/v1/ask/research/jobs/status',
  '/v1/ask/research/jobs/cancel', '/v1/ask/research/jobs/explain', '/v1/ask/feedback',
]);
const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store, max-age=0',
  'cdn-cache-control': 'no-store',
  'vercel-cdn-cache-control': 'no-store',
  'x-robots-tag': 'noindex, follow',
  'x-content-type-options': 'nosniff',
};
function failure(status) {
  // A too-large body is the visitor's to fix, not an outage.
  const detail = status === 413 ? 'This request is too large. SQL can contain up to 8,192 characters.' : 'Ask staging is unavailable.';
  return Response.json({ type: 'upstream-error', code: status === 413 ? 'ask-request-size' : 'ask-staging', detail }, { status, headers: PRIVATE_HEADERS });
}
function upstreamConfig(env) {
  if (env.VERCEL_ENV !== 'preview' || env.ASK_STAGING_ENABLED !== 'true') return null;
  try {
    const origin = new URL(env.ASK_STAGING_ORIGIN);
    if (origin.origin !== UPSTREAM || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) return null;
    if (![env.ASK_STAGING_CA_PEM, env.ASK_STAGING_CLIENT_CERT_PEM, env.ASK_STAGING_CLIENT_KEY_PEM].every(value => typeof value === 'string' && value.trim())) return null;
    return origin;
  } catch { return null; }
}
async function readBody(request, timeoutMs) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) throw 413;
  const reader = request.body?.getReader();
  if (!reader) throw 400;
  const chunks = [];
  let size = 0;
  let timer, abort;
  const interrupted = new Promise((_, reject) => {
    const stop = status => { reject(status); void reader.cancel().catch(() => {}); };
    abort = () => stop(499);
    request.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop(504), timeoutMs);
    if (request.signal.aborted) abort();
  });
  try {
    while (true) {
      request.signal.throwIfAborted();
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) { void reader.cancel().catch(() => {}); throw 413; }
      chunks.push(Buffer.from(value));
    }
  } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const body = Buffer.concat(chunks);
  try { JSON.parse(body.toString('utf8')); } catch { throw 400; }
  return body;
}
/** All request headers are rebuilt; browser cookies, auth and forwarding hints never reach the API. */
function clientIP(request, env) {
  // Vercel's platform-owned header is documented at
  // https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for.
  const value = env.VERCEL === '1' ? request.headers.get('x-vercel-forwarded-for') : null;
  // Missing/invalid platform identity shares one conservative admission bucket.
  return value && isIP(value) ? value : '198.18.0.1';
}
function createStagingProxy(env = process.env, transport = https.request, timeoutMs = 40000) {
  return async function proxy(request) {
    const deadline = Date.now() + timeoutMs;
    const origin = upstreamConfig(env);
    if (!origin) return failure(404);
    let url;
    try { url = new URL(request.url); } catch { return failure(400); }
    const path = url.pathname.startsWith(PREFIX + '/') ? url.pathname.slice(PREFIX.length) : '';
    if (url.search || url.hash || !(path === '/v1/ask' || POST_PATHS.has(path))) return failure(404);
    if (!(request.method === 'GET' && path === '/v1/ask') && !(request.method === 'POST' && POST_PATHS.has(path))) return failure(405);
    if (request.method === 'POST') {
      if (url.protocol !== 'https:' || request.headers.get('origin') !== url.origin || (request.headers.get('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) return failure(403);
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') || '')) return failure(415);
    }
    if (request.signal.aborted) return failure(499);
    let body;
    try { if (request.method === 'POST') body = await readBody(request, Math.max(1, deadline - Date.now())); }
    catch (error) { return failure(request.signal.aborted ? 499 : error === 413 ? 413 : error === 504 ? 504 : 400); }
    if (request.signal.aborted) return failure(499);
    return new Promise(resolve => {
      let upstream, response, timer, settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal.removeEventListener('abort', abort);
        resolve(result);
      };
      const stop = (status) => { finish(failure(status)); response?.destroy(); upstream?.destroy(); };
      const abort = () => stop(499);
      const headers = { accept: 'application/json', host: origin.host, 'x-ask-staging-client-ip': clientIP(request, env) };
      if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(body.length); }
      try {
        upstream = transport(new URL(path, origin), {
          method: request.method, headers,
          ca: env.ASK_STAGING_CA_PEM,
          cert: env.ASK_STAGING_CLIENT_CERT_PEM,
          key: env.ASK_STAGING_CLIENT_KEY_PEM,
          rejectUnauthorized: true, minVersion: 'TLSv1.2',
          // Keep Node's default hostname/IP SAN verification. Never override checkServerIdentity.
          agent: false,
        }, incoming => {
          response = incoming;
          if (settled) { incoming.destroy(); return; }
          const status = incoming.statusCode || 502;
          const contentType = incoming.headers['content-type'];
          if (status < 200 || status > 599 || status >= 300 && status < 400 || typeof contentType !== 'string' || !/^application\/(?:json|problem\+json)(?:\s*;|\s*$)/i.test(contentType)) { stop(502); return; }
          const declaredLength = incoming.headers['content-length'];
          if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > RESPONSE_LIMIT)) { stop(502); return; }
          const chunks = [];
          let size = 0;
          incoming.on('data', chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > RESPONSE_LIMIT) { stop(502); return; }
            chunks.push(Buffer.from(chunk));
          });
          incoming.on('error', () => stop(502));
          incoming.on('aborted', () => stop(502));
          incoming.on('end', () => {
            if (settled) return;
            const data = Buffer.concat(chunks);
            try { JSON.parse(data.toString('utf8')); } catch { stop(502); return; }
            const resultHeaders = { ...PRIVATE_HEADERS, 'content-type': contentType.split(';')[0].trim().toLowerCase() };
            const retry = incoming.headers['retry-after'];
            if (typeof retry === 'string' && /^\d{1,7}$/.test(retry) && Number(retry) >= 1 && Number(retry) <= 2678400) resultHeaders['retry-after'] = retry;
            try { finish(new Response(data, { status, headers: resultHeaders })); }
            catch { stop(502); }
          });
        });
        upstream.on('error', () => stop(request.signal.aborted ? 499 : 502));
        request.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => stop(504), Math.max(1, deadline - Date.now()));
        if (request.signal.aborted) { abort(); return; }
        upstream.end(body);
      } catch { stop(502); }
    });
  };
}
const proxyAskStaging = createStagingProxy();
module.exports = { proxyAskStaging, createStagingProxy };
