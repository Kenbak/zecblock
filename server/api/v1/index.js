/**
 * server/api/v1/index.js
 *
 * Entry point for the /v1 API contract layer.
 *
 * ⚠️ ARCHITECTURE STATUS: TRANSITIONAL / DARK-LAUNCH BRIDGE, NOT FINAL.
 * This module proxies every request to the legacy monolith over an
 * internal HTTP hop (lib/internal-client.js) rather than querying data
 * directly. That is a deliberate, temporary bridge to get a stable public
 * contract shipped without touching server/api/server.js or any route
 * file — it is explicitly NOT presented as the intended long-term/"final"
 * architecture. See README.md, "Architecture status", for the migration
 * path (adapter-by-adapter cutover to a real data-access layer once /v1
 * is validated in dark launch) and the measured cost of this bridge (the
 * `internal` Server-Timing entry every adapter response carries).
 *
 * This module deliberately does NOT touch server/api/server.js, does not
 * import any file under server/api/routes/**, and never opens a database
 * connection or Redis client itself — see server/api/v1/README.md for the
 * exact mount instructions and why this is designed to run standalone on
 * a dedicated API host, proxying to the legacy monolith over HTTP.
 *
 * Usage (see README.md for full detail):
 *
 *   const createV1Router = require('./v1');
 *   app.use('/v1', createV1Router());
 *
 * `createV1Router(envOverrides?)` accepts an optional plain object of env
 * var overrides (primarily for tests) that take precedence over
 * process.env; see config.js for the full list of variables.
 */

const express = require('express');
const { loadV1Config } = require('./config');
const { createInternalClient } = require('./lib/internal-client');
const { createFeatureGate } = require('./middleware/feature-gate');
const { createRequestContext } = require('./middleware/request-context');
const { sendProblem } = require('./lib/problem');
const { buildV1Routes } = require('./routes/index');
const { buildOpenApiDocument } = require('./openapi');
const { logSafeError } = require('../lib/safe-log');
const { createMcpRouter } = require('./mcp');

function createV1Router(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  const config = loadV1Config(env);
  const internalClient = createInternalClient(config);

  const router = express.Router();

  // Express sets `X-Powered-By: Express` at the start of app.handle(), i.e.
  // before any router middleware runs — remove it here (headers aren't
  // flushed yet) rather than relying on whatever app eventually mounts
  // this router to remember `app.disable('x-powered-by')`. Same spirit as
  // the internal-client response-header allowlist: /v1 shouldn't leak
  // implementation fingerprints, whether they come from the legacy proxy
  // hop or from this router's own host framework.
  router.use((req, res, next) => {
    res.removeHeader('X-Powered-By');
    next();
  });

  // Body parsing for write routes. Mirrors the legacy app's express.json()
  // — safe to apply unconditionally since GET/DELETE requests have no body.
  router.use(createFeatureGate(config));
  router.use(createRequestContext(config, internalClient));
  // MCP shares the public gate/context and existing adapter authority. Mount
  // before the general JSON parser so its smaller request bound is enforced.
  const mcpRouter = createMcpRouter(config, { env });
  router.use('/mcp', mcpRouter);
  // Ask accepts only a short question and a small recipe, never file uploads.
  // Apply before the general parser on standalone hosts; also check decoded
  // bodies when the parent application already parsed the request.
  router.use('/ask', express.json({ limit: '16kb' }), (req, res, next) => {
    if (req.body && Buffer.byteLength(JSON.stringify(req.body), 'utf8') > 16384) {
      return sendProblem(res, 'validation-error', { status: 413, detail: 'Ask request body exceeds 16 KiB.' });
    }
    next();
  });
  router.use(express.json({ limit: '1mb' }));

  // Machine-readable contract served by the same feature gate as the preview.
  router.get('/openapi.json', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300, must-revalidate');
    res.json(buildOpenApiDocument());
  });

  const dataRoutes = buildV1Routes(internalClient, config, env);
  router.use(dataRoutes);

  // /v1-scoped 404 — only reached once the feature gate has already let
  // the request through, so this is a "real" unknown-route 404, distinct
  // from the feature-gate's deliberately generic disabled-state 404.
  router.use((req, res) => {
    sendProblem(res, 'not-found', {
      instance: req.originalUrl,
      detail: 'No v1 route matches this path and method.',
    });
  });

  // Final safety net — an adapter/middleware bug must still produce a
  // problem+json body, never an Express HTML error page or a stack trace.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  router.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return sendProblem(res, 'validation-error', { status: err.type === 'entity.too.large' ? 413 : 400, detail: err.type === 'entity.too.large' ? err.limit === 16384 ? 'Ask request body exceeds 16 KiB.' : 'Request body exceeds 1 MB.' : 'Request body must be valid JSON.' });
    }
    logSafeError('[v1] unhandled router error:', err);
    sendProblem(res, 'internal-error', { instance: req.originalUrl, detail: 'Unexpected server error.' });
  });

  router.__v1Config = config;
  router.__v1RouteCount = dataRoutes.mountedCount;
  router.__stopRateLimiters = () => { mcpRouter.stop(); dataRoutes.__stopRateLimiters(); };
  return router;
}

module.exports = createV1Router;
module.exports.createV1Router = createV1Router;
