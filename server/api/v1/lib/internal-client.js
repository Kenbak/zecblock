/**
 * server/api/v1/lib/internal-client.js
 *
 * ⚠️ TRANSITIONAL ARCHITECTURE — READ BEFORE EXTENDING ⚠️
 *
 * This is a loopback/reverse-proxy dispatcher: v1 adapters call the legacy
 * Express API (server/api/routes/*.js, mounted by server/api/server.js)
 * over HTTP instead of importing route handlers or issuing their own SQL.
 *
 * This is explicitly a DARK-LAUNCH / BRIDGE pattern for getting a stable
 * public contract in front of the legacy API without touching it — it is
 * NOT presented as the final or "top-class" architecture for CipherScan's
 * API layer. It works, and it is safe (fails closed, bounded, header- and
 * size-limited), but it has real, permanent costs relative to a native
 * implementation:
 *   - An extra network hop and JSON re-serialization on every request
 *     (see the `X-CipherScan-Internal-Timing` / Server-Timing `internal`
 *     entry this module adds — that cost is measured, not hand-waved).
 *   - Legacy response shape changes can silently break a v1 adapter's
 *     assumptions (mitigated by, but not eliminated by, the contract
 *     tests in server/api/test/v1/).
 *   - It inherits whatever caching/rate-limit behavior the legacy handler
 *     already has; it does not (and cannot, from outside) make a slow
 *     query fast.
 * The intended follow-up, once /v1 traffic and the contract are validated
 * in dark launch, is to migrate individual adapters to a real data-access
 * layer (shared query modules callable directly, or a proper internal
 * gateway) and delete this file's role for those routes one at a time —
 * not to keep proxying indefinitely. See server/api/v1/README.md,
 * "Architecture status".
 *
 * Why HTTP instead of in-process function calls (for as long as this
 * bridge exists):
 *   - Existing route handlers are Express closures. Reusing their HTTP contract
 *     preserves one authoritative implementation during this migration.
 *   - It guarantees zero duplicated business SQL: the legacy handler's
 *     query, caching, and validation logic all still run exactly once.
 *
 * Safety properties:
 *   - Fixed timeout (V1_INTERNAL_TIMEOUT_MS) via AbortController — a slow
 *     legacy query cannot hang a v1 request indefinitely.
 *   - Configurable response size cap (V1_INTERNAL_MAX_RESPONSE_BYTES,
 *     default 50MB — matching the existing upstream Zebra RPC cap in
 *     server/lib/zebra-rpc.js) so a truly unbounded response still can't
 *     exhaust memory, WITHOUT rejecting real, currently-valid public
 *     payloads (e.g. the ~10.4MB /api/migration/scatter response).
 *   - Request header allowlist outbound: cookies, auth headers, and
 *     arbitrary client headers are never forwarded upstream — only an
 *     optional internal service key is attached. Ownership/payment routes instead
 *     use their explicit credential allowlists and never receive that key.
 *   - Response header allowlist inbound: see ALLOWED_RESPONSE_HEADERS.
 *     Only headers that are safe transport/cache/quota signals are
 *     surfaced back to the caller (build-route.js relays them onto the
 *     v1 response) — arbitrary legacy headers are never blindly relayed.
 *   - Never forwards the client's original IP/host headers upstream
 *     (avoids header-spoofing / cache-poisoning vectors on the internal
 *     hop).
 */

const { performance } = require('node:perf_hooks');

/**
 * Response headers considered safe to relay verbatim from the legacy API
 * back onto the v1 response. Chosen because they carry transport/cache/
 * quota semantics that the client needs to behave correctly (CDN/browser
 * caching, conditional requests, backoff) and never carry secrets or
 * internal implementation detail:
 *   - Cache-Control, ETag        → caching semantics must survive the proxy
 *                                  hop or v1 silently destroys legacy's
 *                                  existing cache/CDN behavior.
 *   - Retry-After                → set by legacy's rate limiter on 429s.
 *   - RateLimit-* / X-RateLimit-* → draft standard + legacy-style quota
 *                                  headers (express-rate-limit in
 *                                  server.js sets the RateLimit-* family
 *                                  today; X-RateLimit-* covers older/other
 *                                  clients or future limiters).
 *   - X-ZecBlock-* / X-CipherScan-* → project-specific, already documented
 *                                  as CORS-exposed in server.js
 *                                  (X-CipherScan-Cache today).
 * Deliberately excluded: Set-Cookie, Server, X-Powered-By, and anything
 * else that could leak internal infrastructure detail or set cookies on
 * behalf of a client that never asked for them.
 */
const ALLOWED_RESPONSE_HEADERS = [
  'cache-control',
  'etag',
  'retry-after',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'ratelimit-policy',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
];
const ALLOWED_RESPONSE_HEADER_PREFIXES = ['x-zecblock-', 'x-cipherscan-'];

function isAllowedResponseHeader(name) {
  const lower = name.toLowerCase();
  if (ALLOWED_RESPONSE_HEADERS.includes(lower)) return true;
  return ALLOWED_RESPONSE_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Extracts only the allowlisted headers from a fetch Response into a plain object. */
function pickAllowedHeaders(fetchHeaders) {
  const picked = {};
  for (const [name, value] of fetchHeaders.entries()) {
    if (isAllowedResponseHeader(name)) picked[name.toLowerCase()] = value;
  }
  return picked;
}

class UpstreamTimeoutError extends Error {
  constructor(message, { timingMs } = {}) {
    super(message);
    this.name = 'UpstreamTimeoutError';
    this.timingMs = timingMs;
  }
}

class UpstreamError extends Error {
  constructor(message, { status, body, timingMs } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.body = body;
    this.timingMs = timingMs;
  }
}

/**
 * @param {object} config - result of require('../config').loadV1Config()
 */
function createInternalClient(config, { fetchImpl = fetch } = {}) {
  const baseUrl = config.internalBaseUrl;
  const timeoutMs = config.internalTimeoutMs;
  const maxResponseBytes = config.maxResponseBytes;

  /**
   * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
   * @param {string} legacyPath - e.g. '/api/blocks/list' (must start with /api or /health)
   * @param {object} [opts]
   * @param {URLSearchParams|object} [opts.query]
   * @param {object} [opts.body] - JSON body for write methods
   * @param {AbortSignal} [opts.parentSignal] - abort if the inbound v1 request is aborted
   * @returns {Promise<{status:number, ok:boolean, body:any, headers:object, timingMs:number}>}
   */
  async function dispatch(method, legacyPath, opts = {}) {
    if (!/^\/(api|health)(\/|$)/.test(legacyPath)) {
      // Fail closed rather than silently proxying to an unexpected path —
      // this would only happen from a manifest authoring mistake, never
      // from client input (legacyPath is never client-controlled).
      throw new Error(`internal-client: refusing to dispatch to non-legacy path "${legacyPath}"`);
    }

    const url = new URL(baseUrl + legacyPath);
    if (opts.query) {
      const params = opts.query instanceof URLSearchParams ? opts.query : new URLSearchParams(opts.query);
      for (const [k, v] of params) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      }
    }

    const startedAt = performance.now();
    const elapsed = () => Number((performance.now() - startedAt).toFixed(1));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new UpstreamTimeoutError(`internal dispatch to ${legacyPath} exceeded ${timeoutMs}ms`, { timingMs: elapsed() })), timeoutMs);

    const onParentAbort = () => controller.abort(opts.parentSignal.reason);
    if (opts.parentSignal) {
      if (opts.parentSignal.aborted) controller.abort(opts.parentSignal.reason);
      else opts.parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }

    const headers = { Accept: 'application/json' };
    if (config.internalServiceKey && opts.useServiceKey !== false) headers['X-Service-Key'] = config.internalServiceKey;
    if (opts.nodeToken) headers['X-Node-Token'] = opts.nodeToken;
    if (opts.paymentAuth) Object.assign(headers, opts.paymentAuth);
    // Marks the request as v1-originated for legacy-side logging only; the
    // legacy API does not currently branch on this header.
    headers['X-CipherScan-Internal'] = 'v1-adapter';

    let init = { method, headers, signal: controller.signal };
    if (opts.body !== undefined && method !== 'GET' && method !== 'DELETE') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    try {
      const response = await fetchImpl(url, init);
      const relayedHeaders = pickAllowedHeaders(response.headers);
      if (opts.paymentAuth) for (const name of ['payment-required', 'www-authenticate', 'payment-response', 'payment-receipt', 'x-session-balance', 'x-session-id']) {
        if (response.headers.has(name)) relayedHeaders[name] = response.headers.get(name);
      }
      if (Number(response.headers.get('content-length') || 0) > maxResponseBytes) {
        await response.body?.cancel();
        throw new UpstreamError('Internal response exceeds the configured size limit.', { status: response.status, timingMs: elapsed() });
      }
      const reader = response.body?.getReader();
      const chunks = [];
      let bytes = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxResponseBytes) {
            await reader.cancel();
            throw new UpstreamError('Internal response exceeds the configured size limit.', { status: response.status, timingMs: elapsed() });
          }
          chunks.push(Buffer.from(value));
        }
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (text.length) {
        try { body = JSON.parse(text); } catch {
          throw new UpstreamError('Internal response is not valid JSON.', { status: response.status, timingMs: elapsed() });
        }
      }
      return { status: response.status, ok: response.ok, body, headers: relayedHeaders, timingMs: elapsed() };
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason instanceof UpstreamTimeoutError) throw controller.signal.reason;
      if (err instanceof UpstreamError) throw err;
      throw new UpstreamError('Internal request failed.', { timingMs: elapsed() });
    } finally {
      clearTimeout(timer);
      if (opts.parentSignal) opts.parentSignal.removeEventListener('abort', onParentAbort);
    }

  }

  return { dispatch, maxResponseBytes };
}

module.exports = {
  createInternalClient,
  UpstreamTimeoutError,
  UpstreamError,
  ALLOWED_RESPONSE_HEADERS,
  ALLOWED_RESPONSE_HEADER_PREFIXES,
  isAllowedResponseHeader,
  pickAllowedHeaders,
};
