/**
 * API Input Validation (Zod)
 *
 * Shared validation schemas and middleware for all API routes.
 * Validates query params, path params, and request bodies.
 */

const { z } = require('zod');
const { logSafeError } = require('./lib/safe-log');

// ============================================================================
// Common schemas
// ============================================================================

const txidSchema = z.string().regex(/^[a-fA-F0-9]{64}$/, 'Invalid transaction ID');

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const periodSchema = z.enum(['24h', '7d', '30d', '90d']).default('7d');

const addressSchema = z.string().min(1, 'Address is required');

// ============================================================================
// Route-specific schemas
// ============================================================================

const schemas = {
  // GET /api/tx/:txid
  txById: {
    params: z.object({ txid: txidSchema }),
  },

  // GET /api/tx/shielded
  shieldedTxs: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      pool: z.enum(['sapling', 'orchard', 'ironwood']).optional(),
      type: z.enum(['fully-shielded', 'partial']).optional(),
      min_actions: z.coerce.number().int().min(0).default(0),
      skip_count: z.enum(['true', 'false']).optional(),
    }),
  },

  // GET /api/address/:address
  addressById: {
    params: z.object({ address: addressSchema }),
    query: z.object({
      page: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
      cursor: z.string().max(4096).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
  },

  // GET /api/address/:address/graph
  addressGraph: {
    params: z.object({ address: addressSchema }),
  },

  // GET /api/crosschain/trends
  crosschainTrends: {
    query: z.object({
      period: z.enum(['7d', '30d', '90d', '1y', 'all']).default('30d'),
      granularity: z.enum(['daily', 'weekly']).default('daily'),
    }),
  },

  // GET /api/crosschain/history
  crosschainHistory: {
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      direction: z.enum(['inflow', 'outflow']).optional(),
      chain: z.string().min(1).optional(),
    }),
  },

  // GET /api/crosschain/volume-by-chain
  volumeByChain: {
    query: z.object({
      period: z.enum(['7d', '30d']).default('30d'),
    }),
  },

  // GET /api/privacy/recommended-swap-amounts
  recommendedAmounts: {
    query: z.object({
      chain: z.string().min(1, 'chain param required'),
      token: z.string().min(1, 'token param required'),
    }),
  },

  // GET /api/privacy/risks
  privacyRisks: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).default(0),
      minScore: z.coerce.number().int().min(0).default(40),
      period: periodSchema,
      riskLevel: z.enum(['ALL', 'HIGH', 'MEDIUM']).default('ALL'),
      sort: z.enum(['score', 'recent']).default('recent'),
    }),
  },

  // GET /api/privacy/linkage-edges
  privacyLinkageEdges: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).default(0),
      minScore: z.coerce.number().int().min(0).max(100).default(40),
      period: periodSchema,
      riskLevel: z.enum(['ALL', 'HIGH', 'MEDIUM']).default('ALL'),
      sort: z.enum(['score', 'recent']).default('recent'),
      txid: txidSchema.optional().or(z.literal('').transform(() => undefined)),
    }),
  },

  // GET /api/privacy/batch-risks and /api/privacy/clusters
  privacyBatchRisks: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      minScore: z.coerce.number().int().min(0).max(100).default(35),
      period: z.enum(['7d', '30d', '90d']).default('30d'),
      riskLevel: z.enum(['ALL', 'HIGH', 'MEDIUM']).default('ALL'),
      sort: z.enum(['score', 'recent']).default('score'),
      afterScore: z.coerce.number().optional(),
      afterAmount: z.coerce.number().optional(),
    }),
  },

  // GET /api/privacy/graph/:txid
  privacyGraph: {
    params: z.object({ txid: txidSchema }),
  },

  // GET /api/tx/:txid/linkability
  txLinkability: {
    params: z.object({ txid: txidSchema }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(20).default(5),
      tolerance: z.coerce.number().min(0.0001).max(0.1).default(0.001),
    }),
  },

  // POST /api/tx/broadcast
  txBroadcast: {
    body: z.object({
      rawTx: z.string().regex(/^[0-9a-fA-F]+$/, 'rawTx must be a valid hex string'),
    }),
  },

  // POST /api/tx/raw/batch
  txRawBatch: {
    body: z.object({
      txids: z.array(txidSchema).max(100).min(1),
    }),
  },

  // GET /api/transparent/exposed
  exposedAddresses: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
      cursor: z.string().regex(/^t[a-zA-Z0-9]+$/, 'cursor must be a valid t-address').optional(),
      sort: z.enum(['balance', 'address']).default('balance'),
      min_balance: z.coerce.number().int().min(0).default(0),
    }).refine(
      (d) => !(d.cursor && d.sort !== 'address'),
      { message: 'cursor pagination requires sort=address' }
    ),
  },
};

// ============================================================================
// Validation middleware factory
// ============================================================================

/**
 * Creates Express middleware that validates req.params, req.query, and/or req.body
 * against the given schema name. On failure, returns 400 with details.
 */
function validate(schemaName) {
  const schema = schemas[schemaName];
  if (!schema) throw new Error(`Unknown schema: ${schemaName}`);

  return (req, res, next) => {
    try {
      if (schema.params) {
        const result = schema.params.safeParse(req.params);
        if (!result.success) {
          return res.status(400).json({
            error: 'Invalid path parameters',
            details: result.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
          });
        }
        req.params = result.data;
      }

      if (schema.query) {
        const result = schema.query.safeParse(req.query);
        if (!result.success) {
          return res.status(400).json({
            error: 'Invalid query parameters',
            details: result.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
          });
        }
        req.query = { ...req.query, ...result.data };
      }

      if (schema.body) {
        const result = schema.body.safeParse(req.body);
        if (!result.success) {
          return res.status(400).json({
            error: 'Invalid request body',
            details: result.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
          });
        }
        req.body = result.data;
      }

      next();
    } catch (err) {
      logSafeError('Validation error:', err);
      res.status(400).json({ error: 'Validation failed', message: 'Invalid request parameters' });
    }
  };
}

module.exports = { validate, schemas, txidSchema, paginationSchema, periodSchema, addressSchema };
