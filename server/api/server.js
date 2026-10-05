/**
 * Zcash Explorer API Server
 * Express.js + PostgreSQL + WebSocket
 * Runs on Hetzner, serves data to Vercel frontend
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const WebSocket = require('ws');
const http = require('http');
const redis = require('redis');
const fs = require('fs');
const { createListCache } = require('./list-cache');
const { createRequestObservability } = require('./request-observability');
const createV1Router = require('./v1');
const { sendProblem: sendV1Problem } = require('./v1/lib/problem');
const { isKnownServiceKey, createServiceKeyOnlySkip } = require('./service-auth');
const {
  createInstanceId,
  wrapEnvelope,
  createSeenMessageTracker,
  receiveEnvelope,
} = require('./broadcast-relay');
const { createChainTipBroadcaster } = require('./chain-tip-broadcast');

// Redacts dynamic path segments (addresses, tx/block hashes, heights) before
// logging so request logs never contain queried identifiers or amounts.
function redactPathForLogging(path) {
  return path
    .split('/')
    .map((segment) => {
      if (/^[0-9a-fA-F]{64}$/.test(segment)) return ':txhash';
      if (/^[0-9a-fA-F]{40,66}$/.test(segment)) return ':hash';
      if (/^(t1|t3|zc|zs|u1|utest1|ztestsapling1|tm|tn)[0-9a-zA-Z]{10,}$/.test(segment)) {
        return ':address';
      }
      if (/^\d+$/.test(segment)) return ':n';
      return segment;
    })
    .join('/');
}

// Initialize Express
const app = express();
const server = http.createServer(app);

// Import routes
const blocksRouter = require('./routes/blocks');
const transactionsRouter = require('./routes/transactions');
const networkRouter = require('./routes/network');
const { createAttestationRouter } = require('./routes/attestations');
const crosschainRouter = require('./routes/crosschain');
const wrappedZecRouter = require('./routes/wrapped-zec');
const statsRouter = require('./routes/stats');
const privacyRouter = require('./routes/privacy');
const scanRouter = require('./routes/scan');
const addressRouter = require('./routes/address');
const blendCheckRouter = require('./routes/blend-check');
const { logSafeError } = require('./lib/safe-log');
const crosslinkRouter = require('./routes/crosslink');
const reorgsRouter = require('./routes/reorgs');
const poolsRouter = require('./routes/pools');
const miningRouter = require('./routes/mining');
const analyticsRouter = require('./routes/analytics');
const migrationRouter = require('./routes/migration');
const sitemapsRouter = require('./routes/sitemaps');
const transparentRouter = require('./routes/transparent');
const valuationRouter = require('./routes/valuation');
const pulseRouter = require('./routes/pulse');
const signalsRouter = require('../signals/api');

// Import privacy linkage functions
const {
  findLinkedTransactions,
  formatTimeDelta,
  getTransparentAddresses,
  detectBatchDeshields,
  detectBatchForShield,
  queryPrivacyLinkageEdges,
  queryPrivacyBatchClusters,
  getPrivacyGraph,
} = require('./privacy-linkage');

// Import Zebra gRPC client
const { ZebraGrpcClient } = require('./zebra-grpc');

// Import Fork Monitor
const { ForkMonitor } = require('./fork-monitor');
 
// PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'zcash_explorer_testnet',
  user: process.env.DB_USER || 'zcash_user',
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  // Bounds a runaway/heavy query instead of letting it pin a pool connection
  // indefinitely. Endpoints that need longer should use a cached/estimated
  // query pattern (see reltuples-based counts) rather than raising this.
  statement_timeout: 15000,
  query_timeout: 15000,
  application_name: 'cipherscan-api',
});

// Catch idle-client errors so a terminated connection (e.g. replica recovery
// conflict) logs a warning instead of crashing the process via unhandled
// EventEmitter 'error'.
pool.on('error', (err) => {
  logSafeError('[pool:primary] Idle client error:', err);
});

// Read/write pool routing with circuit breaker — auto-creates replica pool
// if REPLICA_DATABASE_URL is set. The smart read pool transparently falls
// back to primary on any replica failure (connection, lag, query error).
const poolRouting = require('./pool-routing');
poolRouting.configureFromEnv({ primary: pool });

app.locals.pool = poolRouting.createSmartReadPool();
app.locals.writePool = pool;
app.locals.poolRouting = poolRouting;
app.locals.queryWithFallback = poolRouting.queryWithReplicaFallback;

// Test the authoritative database before accepting traffic. Only after the
// primary is confirmed do we probe an optional replica's PostgreSQL role;
// reads stay on the primary until that probe confirms recovery mode.
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    logSafeError('❌ Database connection failed:', err);
    process.exit(1);
  }
  console.log('✅ Database connected:', res.rows[0].now);
  if (poolRouting.hasReplica()) void poolRouting.verifyReplicaRole();
});

// ============================================================================
// REDIS CLIENT
// ============================================================================

// Create Redis client
const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
  // No password for local Redis
});
const listCache = createListCache({ redisClient });

// Create Redis Pub/Sub clients (separate connections required)
const redisPub = redisClient.duplicate();
const redisSub = redisClient.duplicate();

// Connect to Redis
(async () => {
  try {
    await redisClient.connect();
    await redisPub.connect();
    await redisSub.connect();
    console.log('✅ Redis connected');
  } catch (err) {
    logSafeError('❌ Redis connection failed:', err);
    console.warn('⚠️  Continuing without Redis (fallback to in-memory cache)');
  }
})();

// Handle Redis errors
redisClient.on('error', (err) => logSafeError('Redis Client Error:', err));
redisPub.on('error', (err) => logSafeError('Redis Pub Error:', err));
redisSub.on('error', (err) => logSafeError('Redis Sub Error:', err));

// Identifies this process's broadcasts on the shared Redis channel so its
// own publishes are never re-delivered to its own WebSocket clients (see
// broadcast-relay.js). Every API instance publishes AND subscribes to the
// same 'zcash:broadcast' channel, so without this check the instance that
// originates an event would deliver it locally twice: once synchronously,
// and once again when its own publish echoes back through its subscription.
const SERVER_INSTANCE_ID = createInstanceId();
const seenBroadcastMessages = createSeenMessageTracker();

// Subscribe to Redis broadcast channel (for multi-server support)
(async () => {
  try {
    if (redisSub.isOpen) {
      await redisSub.subscribe('zcash:broadcast', (message) => {
        // Drops self-echoes (already delivered locally by broadcastToAll)
        // and already-seen message IDs; forwards everything else — i.e.
        // events genuinely originating from another instance.
        const body = receiveEnvelope({
          raw: message,
          ownInstanceId: SERVER_INSTANCE_ID,
          tracker: seenBroadcastMessages,
        });
        if (body === null) return;

        console.log('📡 [Redis] Received broadcast from another server');
        const bodyStr = JSON.stringify(body);
        clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(bodyStr);
          }
        });
      });
      console.log('✅ Subscribed to Redis broadcast channel');
    }
  } catch (err) {
    logSafeError('❌ Redis subscribe error:', err);
  }
})();

// ============================================================================
// ZEBRA RPC HELPER
// ============================================================================

const https = require('https');

/**
 * Call Zebra RPC
 * Reads cookie authentication from file (like the indexer does)
 */
// Shared HTTP agent: reuses TCP connections to zebrad instead of
const { callZebraRPC } = require('../lib/zebra-rpc');

// ============================================================================
// LIGHTWALLETD GRPC CLIENT
// ============================================================================

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

// Load proto files
const PROTO_PATH = path.join(__dirname, 'proto/service.proto');
const COMPACT_FORMATS_PATH = path.join(__dirname, 'proto/compact_formats.proto');

let CompactTxStreamer = null;

// Initialize gRPC client
try {
  const packageDefinition = protoLoader.loadSync(
    [PROTO_PATH, COMPACT_FORMATS_PATH],
    {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    }
  );

  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
  CompactTxStreamer = protoDescriptor.cash.z.wallet.sdk.rpc.CompactTxStreamer;
  console.log('✅ Lightwalletd gRPC client initialized');
} catch (error) {
  logSafeError('❌ Failed to initialize Lightwalletd gRPC client:', error);
  console.error('   Make sure proto files exist in proto/ directory');
}

// Trust proxy: exactly one hop (Caddy). With `true`, Express would trust the
// left-most X-Forwarded-For entry, which a client can set arbitrarily to
// spoof the IP used for rate limiting. `1` makes Express use the right-most
// entry, which Caddy appends and a client cannot override.
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// CORS configuration (only allow your domains)
const allowedOrigins = [
  'https://testnet.cipherscan.app',
  'https://testnet.zecblock.com',
  'https://cipherscan.app',
  'https://zecblock.com',
  'https://www.zecblock.com',
  'https://crosslink.cipherscan.app',
  'https://crosslink.zecblock.com',
  'http://localhost:3000',
  'http://localhost:3001',
  ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : []),
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g., curl, server-to-server, mobile apps)
    if (!origin) {
      return callback(null, true);
    }

    // Allow Chrome extensions (chrome-extension://...)
    if (origin.startsWith('chrome-extension://')) {
      return callback(null, true);
    }

    // Allow browser extensions (moz-extension:// for Firefox, safari-web-extension:// for Safari)
    if (origin.startsWith('moz-extension://') || origin.startsWith('safari-web-extension://')) {
      return callback(null, true);
    }

    // Check if origin is in whitelist
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`⚠️  Blocked request from unauthorized origin: ${origin}`);
      callback(Object.assign(new Error('Not allowed by CORS'), { status: 403 }));
    }
  },
  credentials: true,
  exposedHeaders: [
    'X-Request-Id',
    'X-CipherScan-Cache',
    'X-CipherScan-Indexed-Height',
    'X-CipherScan-Data-Age-Blocks',
    'Server-Timing',
    'Retry-After',
    'RateLimit-Limit',
    'RateLimit-Remaining',
    'RateLimit-Reset',
    'Deprecation',
    'Sunset',
    'Link',
    'Payment-Required', 'WWW-Authenticate', 'Payment-Response', 'Payment-Receipt', 'X-Session-Balance', 'X-Session-Id',
  ],
}));

app.use(createRequestObservability({
  getIndexedHeight: () => app.locals.chainTip?.height,
  getDataAgeBlocks: () => app.locals.poolRouting?.getCircuitState().cachedLagBlocks,
}));

// Internal service API keys bypass rate limiting (comma-separated in env)
const SERVICE_API_KEYS = (process.env.SERVICE_API_KEYS || '').split(',').filter(Boolean);

// Our own frontend domains — never rate-limit browsers visiting CipherScan
const OWN_ORIGINS = [
  'https://cipherscan.app',
  'https://zecblock.com',
  'https://www.zecblock.com',
  'https://www.cipherscan.app',
  'https://testnet.cipherscan.app',
  'https://testnet.zecblock.com',
  'https://crosslink.cipherscan.app',
  'https://crosslink.zecblock.com',
  'http://localhost:3000',
  'http://localhost:3001',
];

// OWN_ORIGINS is used ONLY for the WebSocket upgrade check below — it is
// NOT a rate-limit bypass signal (see the HTTP rate limiter's `skip`,
// which is service-key only for exactly that reason).
//
// WebSocket upgrades are gated here (no cookies/CORS involved in the
// handshake): allow a valid service key from any origin (CipherPay, internal
// services), allow our own frontend origins, and allow requests with no
// Origin header at all (native apps, curl, mobile clients reading public
// chain data). Reject only unrecognized cross-site browser origins.
const wss = new WebSocket.Server({
  server,
  verifyClient: (info, callback) => {
    const serviceKey = info.req.headers['x-service-key'];
    if (isKnownServiceKey(serviceKey, SERVICE_API_KEYS)) {
      return callback(true);
    }
    const origin = info.origin || info.req.headers['origin'];
    if (!origin || OWN_ORIGINS.includes(origin)) {
      return callback(true);
    }
    return callback(false, 403, 'Origin not allowed');
  },
});

// Rate-limit bypass is service-key only. Origin/Referer headers are
// client-supplied and trivially spoofable by any non-browser HTTP client
// (there is no CORS/browser enforcement on the server side of a plain
// HTTP request), so they must never gate a rate-limit bypass — doing so
// let any caller claim to be "our own frontend" and evade the global
// limit entirely by sending an Origin/Referer header matching one of our
// domains. Only a shared secret an outside caller cannot forge is safe
// here.
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 600,
  handler: (req, res) => {
    if (req.path === '/v1' || req.path.startsWith('/v1/')) return sendV1Problem(res, 'rate-limited', { detail: 'Too many requests, please try again later.' });
    res.status(429).send('Too many requests, please try again later.');
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: createServiceKeyOnlySkip(SERVICE_API_KEYS),
});

app.use(limiter);

// Body parser
const legacyJsonParser = express.json();
app.use((req, res, next) => req.path === '/v1' || req.path.startsWith('/v1/') ? next() : legacyJsonParser(req, res, next));

// Request logging — path is redacted (see redactPathForLogging) so
// addresses, tx/block hashes, and heights never reach application logs.
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${redactPathForLogging(req.path)}`);
  next();
});

// ============================================================================
// ROUTES (Modular)
// ============================================================================

// Make additional dependencies available to routes
app.locals.callZebraRPC = callZebraRPC;
app.locals.CompactTxStreamer = CompactTxStreamer;
app.locals.grpc = grpc;
app.locals.findLinkedTransactions = findLinkedTransactions;
app.locals.formatTimeDelta = formatTimeDelta;
app.locals.getTransparentAddresses = getTransparentAddresses;
app.locals.detectBatchDeshields = detectBatchDeshields;
app.locals.detectBatchForShield = detectBatchForShield;
app.locals.queryPrivacyLinkageEdges = queryPrivacyLinkageEdges;
app.locals.queryPrivacyBatchClusters = queryPrivacyBatchClusters;
app.locals.getPrivacyGraph = getPrivacyGraph;
app.locals.redisClient = redisClient;
app.locals.listCache = listCache;

// Block routes: /health, /api/info, /api/blocks, /api/block/:height
app.use(blocksRouter);

// Transaction routes: /api/tx/*, /api/mempool
app.use(transactionsRouter);

// Network routes: /api/network/*
app.use(networkRouter);
app.use(createAttestationRouter());

// Cross-chain routes: /api/crosschain/*
app.use(crosschainRouter);

// Wrapped ZEC routes: /api/wrapped-zec/* (read-only Base/Solana/NEAR RPC, no shared DB access)
app.use(wrappedZecRouter);

// Stats routes: /api/stats/*, /api/privacy-stats
app.use(statsRouter);

// Privacy routes: /api/privacy/*
app.use(privacyRouter);

// Scan routes: /api/scan/*, /api/lightwalletd/*
app.use(scanRouter);

// Address routes: /api/address/*
app.use(addressRouter);

// Blend check routes: /api/blend-check
app.use(blendCheckRouter);

// Crosslink routes: /api/crosslink
app.use(crosslinkRouter);
app.use(reorgsRouter);
app.use(poolsRouter);

// Mining routes: /api/mining/*
app.use(miningRouter);
app.use(analyticsRouter);

// Orchard → Ironwood migration routes: /api/migration/*
app.use(migrationRouter);
app.use(sitemapsRouter);

// Transparent address analysis: /api/transparent/*
app.use(transparentRouter);
app.use(valuationRouter);
app.use(pulseRouter);

// Private trading signals: /api/signals/* (service-key protected)
app.use('/api/signals', signalsRouter);

// Stable public API contract. The router is fail-closed by default and returns
// an indistinguishable 404 until API_V1_ENABLED is explicitly configured.
app.use('/v1', createV1Router());

// Count registered API routes (available as app.locals.apiRouteCount)
function countApiRoutes(app) {
  let count = 0;
  if (!app._router) return count;
  app._router.stack.forEach(layer => {
    if (layer.route && layer.route.path?.startsWith('/api/')) {
      count++;
    } else if (layer.name === 'router' && layer.handle?.stack) {
      layer.handle.stack.forEach(routeLayer => {
        if (routeLayer.route && routeLayer.route.path?.startsWith('/api/')) {
          count++;
        }
      });
    }
  });
  return count;
}
app.locals.apiRouteCount = countApiRoutes(app);
console.log(`📊 Registered ${app.locals.apiRouteCount} API routes`);

// ============================================================================
// WEBSOCKET SERVER (Real-time updates)
// ============================================================================

let clients = new Set();
let rawMempoolSubscribers = 0;

/**
 * In-process fallback limiter used only when Redis is unavailable, so the
 * WebSocket rate limit fails CLOSED (still bounded) instead of allowing
 * unlimited connections. Not shared across API instances, which is
 * acceptable for a fallback path.
 */
const wsFallbackLimiter = new Map(); // ip -> { count, resetAt }
function checkWebSocketRateLimitFallback(ip) {
  const now = Date.now();
  const entry = wsFallbackLimiter.get(ip);
  if (!entry || now >= entry.resetAt) {
    wsFallbackLimiter.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}
// Periodic sweep so the fallback map cannot grow unbounded under sustained
// distinct-IP traffic while Redis is down.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of wsFallbackLimiter) {
    if (now >= entry.resetAt) wsFallbackLimiter.delete(ip);
  }
}, 5 * 60_000).unref();

/**
 * Rate limit WebSocket connections using Redis
 * Returns true if allowed, false if rate limited
 */
async function checkWebSocketRateLimit(ip) {
  try {
    if (!redisClient.isOpen) {
      return checkWebSocketRateLimitFallback(ip);
    }

    const key = `ws:ratelimit:${ip}`;
    const count = await redisClient.incr(key);

    if (count === 1) {
      await redisClient.expire(key, 60);
    }

    return count <= 10;
  } catch (err) {
    logSafeError('Redis rate limit error:', err);
    return checkWebSocketRateLimitFallback(ip);
  }
}

wss.on('connection', async (ws, req) => {
  // Behind a single reverse proxy (Caddy), the right-most X-Forwarded-For
  // entry is the real client (Caddy appends it and a client cannot override
  // that final hop). The left-most entry is attacker-controlled.
  const xff = req.headers['x-forwarded-for'];
  const ip = (xff ? xff.split(',').pop().trim() : null) || req.socket.remoteAddress || 'unknown';

  const allowed = await checkWebSocketRateLimit(ip);
  if (!allowed) {
    ws.close(1008, 'Rate limit exceeded. Max 10 connections per minute.');
    return;
  }

  // Authenticate service clients via X-Service-Key header on upgrade
  const serviceKey = req.headers['x-service-key'];
  ws.isService = isKnownServiceKey(serviceKey, SERVICE_API_KEYS);
  ws.subscriptions = new Set();

  if (ws.isService) {
    console.log('🔑 [WS] Service client connected');
  }

  clients.add(ws);

  // Push current chain tip immediately so the client can detect staleness
  try {
    const tipResult = await pool.query(
      'SELECT height, hash, timestamp FROM blocks ORDER BY height DESC LIMIT 1'
    );
    if (tipResult.rows[0] && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'chain_tip',
        data: {
          height: parseInt(tipResult.rows[0].height),
          hash: tipResult.rows[0].hash,
          timestamp: parseInt(tipResult.rows[0].timestamp),
        },
      }));
    }
  } catch {
    // Non-fatal — client will receive the next new_block event
  }

  ws.on('message', (raw) => {
    if (!ws.isService) return;
    try {
      const msg = JSON.parse(raw);
      if (msg.subscribe === 'raw_mempool' && !ws.subscriptions.has('raw_mempool')) {
        ws.subscriptions.add('raw_mempool');
        rawMempoolSubscribers++;
        console.log(`📡 [WS] Service client subscribed to raw_mempool (${rawMempoolSubscribers} total)`);
        ws.send(JSON.stringify({ type: 'subscribed', channel: 'raw_mempool' }));
      } else if (msg.unsubscribe === 'raw_mempool' && ws.subscriptions.has('raw_mempool')) {
        ws.subscriptions.delete('raw_mempool');
        rawMempoolSubscribers = Math.max(0, rawMempoolSubscribers - 1);
        console.log(`📡 [WS] Service client unsubscribed from raw_mempool (${rawMempoolSubscribers} total)`);
        ws.send(JSON.stringify({ type: 'unsubscribed', channel: 'raw_mempool' }));
      }
    } catch {}
  });

  const cleanup = () => {
    if (ws.subscriptions.has('raw_mempool')) {
      rawMempoolSubscribers = Math.max(0, rawMempoolSubscribers - 1);
      console.log(`📡 [WS] raw_mempool subscriber disconnected (${rawMempoolSubscribers} remaining)`);
    }
    clients.delete(ws);
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// Keep WebSocket connections alive for long-running clients (screensaver mode).
// Sends a ping every 30s; terminates unresponsive clients after 35s.
const WS_PING_INTERVAL = 30_000;
const wsAliveCheck = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

wss.on('close', () => clearInterval(wsAliveCheck));

// Broadcast message to all connected clients (local + Redis Pub/Sub).
// serviceExtra: optional object merged into data for raw_mempool subscribers only.
async function broadcastToAll(message, serviceExtra = null) {
  const regularStr = JSON.stringify(message);

  let serviceStr = null;
  if (serviceExtra && rawMempoolSubscribers > 0) {
    serviceStr = JSON.stringify({
      ...message,
      data: { ...message.data, ...serviceExtra },
    });
  }

  clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;

    if (serviceStr && client.isService && client.subscriptions?.has('raw_mempool')) {
      client.send(serviceStr);
    } else {
      client.send(regularStr);
    }
  });

  // Publish the regular (non-service) payload to Redis for multi-server
  // support, wrapped with this instance's ID + a message ID so every
  // instance's own subscription can recognize and drop its own publishes
  // (see broadcast-relay.js). Service-only fields (raw_hex) are NEVER
  // published here — they remain local to whichever instance received the
  // underlying gRPC event, unchanged from before this fix.
  try {
    if (redisPub.isOpen) {
      await redisPub.publish('zcash:broadcast', wrapEnvelope(SERVER_INSTANCE_ID, message));
    }
  } catch (err) {
    logSafeError('Redis publish error:', err);
  }
}

// In-memory canonical chain tip, updated on every new block (gRPC or poll).
// Routes include this in list-cache keys for chain-derived families so a
// reorg (same height, different hash) automatically invalidates stale data.
let chainTip = { height: 0, hash: '' };
app.locals.chainTip = chainTip;

// Broadcast new block to all connected clients
function broadcastNewBlock(block) {
  const h = parseInt(block.height, 10);
  if (h >= chainTip.height) {
    chainTip = { height: h, hash: block.hash || '' };
    app.locals.chainTip = chainTip;
  }
  broadcastToAll({
    type: 'new_block',
    data: block,
  });
  purgeChainTipCache();
}

// Purge the Next.js CDN cache for chain-tip tagged pages (on-demand ISR)
async function purgeChainTipCache() {
  const url = process.env.REVALIDATION_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!url || !secret) return;

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-revalidate-secret': secret,
      },
      body: JSON.stringify({ tag: 'chain-tip' }),
    });
  } catch (err) {
    // Non-fatal — ISR time-based fallback handles freshness
  }
}

// ============================================================================
// ZEBRA GRPC STREAMING (real-time mempool + blocks)
// ============================================================================

let lastKnownHeight = 0;

// Bounds the PRIMARY (write pool) commit-polling window for a just-announced
// chain tip and self-corrects with the full row once the indexer catches up.
// `pool` here is intentionally the top-level primary Pool (== app.locals.writePool),
// never the smart read pool — the replica can legitimately lag the primary
// (see pool-routing.js), which would make this wait on data that already
// committed.
const chainTipBroadcaster = createChainTipBroadcaster({
  queryBlockByHeight: async (height) => {
    const result = await pool.query('SELECT * FROM blocks WHERE height = $1', [height]);
    return result.rows[0] || null;
  },
  broadcast: broadcastNewBlock,
  getChainTip: () => chainTip,
  onError: (context, err) => {
    logSafeError(`[chain-tip:${context}] primary query failed:`, err);
  },
});

const zebraGrpc = new ZebraGrpcClient(
  process.env.ZEBRA_GRPC_URL || null,
  {
    onMempoolChange: async (change) => {
      if (change.type === 'ADDED') {
        try {
          const tx = await callZebraRPC('getrawtransaction', [change.txid, 1]);
          if (tx) {
            const orchardActions = tx.orchard?.actions?.length || 0;
            const ironwoodActions = tx.ironwood?.actions?.length || 0;
            const data = {
              txid: change.txid,
              size: tx.size || 0,
              fee: tx.fee || 0,
              hasOrchard: orchardActions > 0,
              hasSapling: (tx.vShieldedSpend?.length || 0) > 0 || (tx.vShieldedOutput?.length || 0) > 0,
              hasIronwood: ironwoodActions > 0,
              orchardActions,
              ironwoodActions,
              // Public regardless of pool — needed so the frontend can show a
              // known amount for shield/deshield txs (see /api/mempool parity).
              valueBalanceSapling: tx.valueBalance || 0,
              valueBalanceOrchard: tx.orchard?.valueBalance || 0,
              valueBalanceIronwood: tx.ironwood?.valueBalance || 0,
              totalOutput: (tx.vout || []).reduce((sum, o) => sum + (o.value || 0), 0),
              inputCount: tx.vin?.length || 0,
              outputCount: tx.vout?.length || 0,
              time: Math.floor(Date.now() / 1000),
            };

            // tx.hex is included in the verbose response — pass it to
            // service subscribers without an extra RPC call.
            const serviceExtra = (rawMempoolSubscribers > 0 && tx.hex)
              ? { raw_hex: tx.hex }
              : null;

            broadcastToAll({ type: 'mempool_tx', data }, serviceExtra);
          }
        } catch (err) {
          broadcastToAll({ type: 'mempool_tx', data: { txid: change.txid } });
        }
      } else if (change.type === 'MINED') {
        broadcastToAll({ type: 'mempool_removed', data: { txid: change.txid, reason: 'mined' } });
      } else if (change.type === 'INVALIDATED') {
        broadcastToAll({ type: 'mempool_removed', data: { txid: change.txid, reason: 'invalidated' } });
      }
    },

    onChainTipChange: async (tip) => {
      lastKnownHeight = tip.height;
      await chainTipBroadcaster.handleChainTipChange(tip);
    },

    onConnectionChange: () => {
      // No-op: the mempool and chain-tip streams are supervised
      // independently (see zebra-grpc.js). Callers that need connectivity
      // should read zebraGrpc.getStatus() directly rather than relying on
      // a combined flag captured at some point in the past — the poll
      // fallback below specifically checks the chain-tip stream, since
      // that's the one that determines block-freshness correctness.
    },
  }
);

zebraGrpc.start();

// Fork Monitor: poll external lightwalletd nodes for chain tip comparison
const forkMonitor = new ForkMonitor({ pool, grpc, CompactTxStreamer });
forkMonitor.start();
app.locals.forkMonitor = forkMonitor;

// Fallback: poll for new blocks every 10s when the chain-tip gRPC stream
// specifically is not connected. Gating on the chain-tip stream (rather
// than a combined mempool+chain-tip flag) matters: previously the
// chain-tip stream had no reconnect logic of its own, so if it died while
// the mempool stream stayed healthy, `grpcConnected` never flipped to
// false and this fallback never engaged — new blocks silently stopped
// being detected until the whole process restarted.
setInterval(async () => {
  if (zebraGrpc.getStatus().chainTip) return;

  try {
    const result = await pool.query('SELECT MAX(height) as max_height FROM blocks');
    // pg returns BIGINT as a string; once assigned to lastKnownHeight below,
    // an uncoerced value would make later comparisons lexicographic instead
    // of numeric (silently wrong across digit-length boundaries).
    const currentHeight = Number(result.rows[0]?.max_height ?? 0);

    if (currentHeight > lastKnownHeight) {
      console.log(`📦 New block detected (poll fallback): ${currentHeight}`);

      const blockResult = await pool.query(
        `SELECT * FROM blocks WHERE height = $1`,
        [currentHeight]
      );

      if (blockResult.rows.length > 0) {
        broadcastNewBlock(blockResult.rows[0]);
      }

      lastKnownHeight = currentHeight;
    }
  } catch (error) {
    logSafeError('Error polling for new blocks:', error);
  }
}, 10000);

// Expose gRPC + WebSocket status for health checks
app.get('/api/grpc-status', (req, res) => {
  const serviceClients = [...clients].filter(c => c.isService && c.readyState === WebSocket.OPEN).length;
  const streamStatus = zebraGrpc.getStatus();
  res.json({
    connected: streamStatus.mempool && streamStatus.chainTip,
    streams: streamStatus,
    url: process.env.ZEBRA_GRPC_URL ? 'configured' : 'not configured',
    websocket: {
      clients: [...clients].filter(c => c.readyState === WebSocket.OPEN).length,
      serviceClients,
      rawMempoolSubscribers,
    },
  });
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  logSafeError('Unhandled error:', err);
  if (req.path === '/v1' || req.path.startsWith('/v1/')) {
    return sendV1Problem(res, err.status === 403 ? 'access-denied' : 'internal-error', { detail: err.status === 403 ? 'Origin is not allowed.' : 'Internal server error.' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🚀 Zcash Explorer API Server                           ║
║                                                           ║
║   HTTP:      http://localhost:${PORT}                        ║
║   WebSocket: ws://localhost:${PORT}                          ║
║                                                           ║
║   Environment: ${process.env.NODE_ENV || 'development'}                              ║
║   Database:    ${process.env.DB_NAME || 'zcash_explorer_testnet'}              ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown: stop originating new work first (stream supervisors,
// pollers, the ping interval), then stop accepting connections, then close
// the datastores those components depend on. A force-exit timer guards
// against any single step hanging (e.g. a stuck socket) blocking a
// deploy/restart indefinitely.
let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`${signal} received, closing server...`);

  const forceExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out after 10s — forcing exit');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref?.();

  // Stop producing new broadcasts/streams before tearing down the transport
  // they'd otherwise try to send through.
  zebraGrpc.stop();
  forkMonitor.stop();
  clearInterval(wsAliveCheck);

  // Upgraded WebSocket connections are not closed by http.Server.close(), so
  // a connected browser could keep every deploy waiting for the force-exit
  // timer. Terminate them before closing the HTTP listener; clients already
  // reconnect automatically after an API restart.
  for (const client of wss.clients) {
    client.terminate();
  }
  wss.close();

  server.close(async () => {
    try {
      await Promise.allSettled([
        redisClient.isOpen ? redisClient.close() : null,
        redisPub.isOpen ? redisPub.close() : null,
        redisSub.isOpen ? redisSub.close() : null,
      ]);
    } catch (err) {
      logSafeError('Error closing Redis clients:', err);
    }

    // The replica pool (if configured) is a separate `pg.Pool` from the
    // primary and must be closed independently, or its connections leak
    // past process exit until the OS/Postgres time them out.
    const replicaPool = poolRouting.hasReplica() ? poolRouting.getReadPool() : null;

    pool.end(() => {
      console.log('Primary database pool closed');
      if (replicaPool && typeof replicaPool.end === 'function') {
        replicaPool.end(() => {
          console.log('Replica database pool closed');
          clearTimeout(forceExitTimer);
          process.exit(0);
        });
      } else {
        clearTimeout(forceExitTimer);
        process.exit(0);
      }
    });
  });
  server.closeIdleConnections?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
