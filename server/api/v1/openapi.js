/**
 * server/api/v1/openapi.js
 *
 * Builds the OpenAPI 3.1 document for the /v1 contract layer directly from
 * the manifest (inventory/manifest.js), so the spec cannot drift from the
 * actually-mounted routes. server/api/openapi/v1.yaml is a generated
 * artifact — regenerate it with `node server/api/v1/tools/write-openapi.js`
 * after editing the manifest, and see server/api/test/v1/openapi.test.js
 * for the drift check that runs in CI.
 */

const { MANIFEST } = require('./inventory/manifest');
const queryParameters = require('./inventory/query-parameters.json');
const { getQueryConstraint } = require('./inventory/parameter-schemas');

const PROBLEM_SCHEMA = {
  type: 'object',
  description: 'RFC 9457 problem+json error body.',
  required: ['type', 'title', 'status'],
  properties: {
    type: { type: 'string', format: 'uri', description: 'A URI identifying the problem category.' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { field: { type: 'string' }, issue: { type: 'string' } },
      },
    },
  },
};

const ZATOSHI_STRING_SCHEMA = {
  type: 'string',
  pattern: '^-?[0-9]+$',
  description: 'Integer amount in zatoshis (1 ZEC = 100,000,000 zatoshis), encoded as a decimal string to avoid float precision loss. Never a JSON number.',
};

const META_SCHEMA = {
  type: 'object',
  required: ['requestId', 'network', 'generatedAt', 'indexedHeight', 'source', 'cache', 'freshness', 'units'],
  properties: {
    requestId: { type: 'string', format: 'uuid' },
    network: { type: 'string', enum: ['mainnet', 'testnet', 'crosslink-testnet'] },
    generatedAt: { type: 'string', format: 'date-time' },
    indexedHeight: { type: ['integer', 'null'] },
    source: {
      type: 'object',
      required: ['indexedHeight', 'observedAt'],
      properties: {
        indexedHeight: { type: ['integer', 'null'] },
        observedAt: { type: ['string', 'null'], format: 'date-time' },
      },
    },
    cache: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['hit', 'miss', 'stale', 'unknown'] },
        ageSeconds: { type: ['number', 'null'] },
      },
    },
    dataAgeSeconds: { type: 'number' },
    freshness: {
      type: 'object',
      required: ['status', 'ageSeconds'],
      properties: {
        status: { type: 'string', enum: ['fresh', 'stale', 'unknown', 'unavailable'] },
        ageSeconds: { type: ['number', 'null'] },
      },
    },
    units: {
      type: 'object',
      required: ['authoritativeMonetary', 'authoritativeEncoding', 'zatoshiPerZec', 'legacyFormattedFields'],
      properties: {
        authoritativeMonetary: { const: 'zatoshi' },
        authoritativeEncoding: { const: 'decimal-string' },
        zatoshiPerZec: { const: '100000000' },
        legacyFormattedFields: { const: 'field-defined' },
      },
    },
    warnings: {
      type: 'array',
      items: { type: 'object', properties: { field: { type: 'string' }, issue: { type: 'string' } } },
    },
    page: {
      type: 'object',
      description: 'Present on cursor-paginated list endpoints.',
      properties: {
        limit: { type: 'integer' },
        hasNext: { type: 'boolean' },
        hasPrev: { type: 'boolean' },
        nextCursor: { type: ['string', 'null'] },
        prevCursor: { type: ['string', 'null'] },
        total: { type: ['integer', 'null'] },
      },
    },
  },
};

function successEnvelopeSchema(dataSchema) {
  return {
    type: 'object',
    required: ['data', 'meta'],
    properties: {
      data: dataSchema,
      meta: { $ref: '#/components/schemas/Meta' },
    },
  };
}

function pathParams(v1Path) {
  const names = [...v1Path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  return names.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

function toOpenApiPath(v1Path) {
  return v1Path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

function operationId(method, v1Path) {
  const slug = v1Path
    .replace(/^\/v1\//, '')
    .replace(/[:{}]/g, '')
    .split('/')
    .filter(Boolean)
    .map((seg, i) => (i === 0 ? seg : seg[0].toUpperCase() + seg.slice(1)))
    .join('_');
  return `${method.toLowerCase()}_${slug || 'root'}`;
}

const ERROR_RESPONSES = {
  '402': { description: 'Payment required. Protocol challenges remain in Payment-Required / WWW-Authenticate; the original challenge is also in problem.paymentRequired.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
  '401': { description: 'Preview or endpoint authentication required.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
  '403': { description: 'Origin or ownership authorization denied.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
  '413': { description: 'JSON body exceeds 1 MB.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
  '503': { description: 'Source temporarily unavailable or still building.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
  '400': { description: 'Validation error.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
  '404': { description: 'Resource not found.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
  '429': { description: 'Rate limited (enforced by the legacy endpoint this proxies to).', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
  '500': { description: 'Internal error.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
  '502': { description: 'Upstream (legacy API) error.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
  '504': { description: 'Upstream (legacy API) timeout.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
};

const HASH = { type: 'string', pattern: '^[a-fA-F0-9]{64}$' };
const HEIGHT = { type: 'integer', minimum: 0, maximum: 100_000_000 };
function requestSchema(entry) {
  if (entry.v1.nativeKey === 'ask') {
    const { z } = require('zod');
    const schema = z.toJSONSchema(entry.v1.path.endsWith('/research/query') ? require('../../../lib/ask/research-contract').sqlQuerySchema.extend({challenge:z.string().min(1).max(2048)}).strict() : entry.v1.path.endsWith('/research/plan') ? z.object({question:z.string().trim().min(1).max(1000),challenge:z.string().max(2048),execute:z.boolean().optional().default(false)}).strict() : entry.v1.path.endsWith('/chat') ? require('../../../lib/ask/chat').chatRequestSchema : entry.v1.path.endsWith('/explain') ? require('./lib/ask-explanation').explainRequestSchema : require('../../../lib/ask/contract').requestSchema);
    delete schema.$schema;
    return schema;
  }
  if (entry.v1.validateKey) return { type: 'object', required: ['startHeight', 'endHeight'], properties: {
    startHeight: { type: 'integer', minimum: entry.v1.validateKey === 'scanLightwalletd' ? 1 : 0 },
    endHeight: { type: 'integer', minimum: 0 },
  }, description: 'Inclusive block range. Maximum 10,000 blocks for lightwalletd or 50,000 for Orchard by default; configured server limits may differ.' };
  const schemas = {
    '/v1/transactions/broadcast': { required: ['rawTx'], properties: { rawTx: { type: 'string', pattern: '^[a-fA-F0-9]+$', description: 'Already signed serialized transaction. No private key is accepted.' } } },
    '/v1/transactions/raw/batch': { required: ['txids'], properties: { txids: { type: 'array', minItems: 1, maxItems: 100, items: HASH } } },
    '/v1/crosslink/fork-monitor/checks': { required: ['heights'], properties: { heights: { type: 'array', minItems: 1, maxItems: 10, items: HEIGHT } } },
    '/v1/crosslink/fork-monitor/nodes': { required: ['name', 'tip'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 32 }, tip: HEIGHT, tip_hash: HASH,
      peers: { type: 'integer', minimum: 0, maximum: 10000 }, mining: { type: 'boolean' },
      ttl: { type: 'string', enum: ['1h', '24h'] },
      sample_hashes: { type: 'array', maxItems: 12, items: { type: 'object', required: ['height', 'hash'], properties: { height: HEIGHT, hash: HASH } } },
    } },
    '/v1/uncles/reports': { required: ['height', 'hash'], properties: { height: HEIGHT, hash: HASH, node_id: { type: 'string' } } },
  };
  if (!schemas[entry.v1.path]) throw new Error(`Missing POST request schema: ${entry.v1.path}`);
  return { type: 'object', ...schemas[entry.v1.path] };
}

function buildOperation(entry) {
  const isList = entry.v1.shape === 'list' || entry.v1.nativeKey === 'names';
  const isNames = entry.v1.nativeKey === 'names';
  const isStub = entry.v1.status === 'stub';

  const dataSchema = isList || entry.v1.nativeKey === 'names'
    ? { type: 'array', items: {} }
    : { oneOf: [{ type: 'object' }, { type: 'array', items: {} }] };

  const parameters = [...pathParams(entry.v1.path)];
  const keys = queryParameters[`${entry.method} ${entry.v1.path}`] || [];
  for (const name of keys) {
    if (isList && ['cursor', 'limit'].includes(name)) continue;
    const requiredAmount = name === 'amount' && entry.domain === 'privacy' && entry.v1.path.includes('blend-check');
    const requiredDate = name === 'date' && entry.v1.path === '/v1/network/price/at';
    const requiredSince = name === 'since' && ['/v1/stats/shielded-count', '/v1/stats/shielded-daily'].includes(entry.v1.path);
    const constraint = getQueryConstraint(entry.v1.path, name);
    parameters.push({ name, in: 'query', required: constraint?.required ?? (requiredAmount || requiredDate || requiredSince),
      schema: constraint?.schema || (requiredAmount ? { type: 'number', exclusiveMinimum: 0, maximum: 21000000 } : requiredDate || requiredSince ? { type: 'string', format: 'date' } : { type: 'string' }),
      description: constraint?.description || (requiredSince ? 'Start date (YYYY-MM-DD).' : requiredAmount ? 'Amount in ZEC, greater than zero and at most 21 million.' : requiredDate ? 'UTC calendar date (YYYY-MM-DD). The response indicates when an earlier available price is used.' : name === 'format' && entry.legacyPath === '/api/circulating-supply' ? 'Compatibility parameter; v1 always returns JSON.' : 'Endpoint-specific filter or range; accepted values follow this endpoint’s data source.') });
  }
  if (isList) {
    parameters.push(
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: isNames ? 500 : 100, default: isNames ? 100 : 25 } },
      { name: 'cursor', in: 'query', required: false, description: 'Opaque cursor from a previous response\'s meta.page.nextCursor/prevCursor.', schema: { type: 'string' } },
    );
  }

  const responses = isStub
    ? {
      '501': {
        description: 'Not yet available under /v1 (fails closed) — see the `detail` field for why.',
        content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
      },
    }
    : {
      '200': {
        description: entry.description || 'Successful response.',
        content: { 'application/json': { schema: successEnvelopeSchema(dataSchema) } },
      },
      ...ERROR_RESPONSES,
    };

  const finalResponses = entry.v1.rateLimitKey && !isStub
    ? { ...responses, '429': ERROR_RESPONSES['429'] }
    : responses;
  if (entry.v1.nativeKey === 'ask') {
    finalResponses['503'] = { description: 'AI not configured, shared limiter unavailable, or provider failure. Guided analyses remain available.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } };
    finalResponses['429'] = { description: 'Per-IP, shared daily or concurrent request limit reached.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } };
  }

  return {
    operationId: operationId(entry.method, entry.v1.path),
    summary: entry.description,
    ...(entry.v1.description ? { description: entry.v1.description } : {}),
    tags: [entry.domain],
    ...(parameters.length ? { parameters } : {}),
    ...(entry.method === 'POST' ? { requestBody: { required: true, content: { 'application/json': { schema: requestSchema(entry) } } } } : {}),
    ...(entry.v1.forwardPaymentAuth ? { parameters: [...parameters, ...['Authorization', 'Payment-Signature', 'X-Payment', 'X-Service-Key'].map(name => ({ name, in: 'header', required: false, schema: { type: 'string' }, description: 'Existing signals-service credential. Never logged or replaced by the adapter internal key.' }))] } : {}),
    ...(entry.v1.forwardNodeToken ? { parameters: [...parameters, { name: 'X-Node-Token', in: 'header', required: entry.method === 'DELETE', schema: { type: 'string' }, description: 'Ownership token returned when registering the node. Required to modify or remove an existing registration.' }] } : {}),
    'x-cipherscan-legacy-path': entry.legacyPath,
    'x-cipherscan-legacy-method': entry.method,
    'x-cipherscan-classification': entry.classification,
    'x-cipherscan-v1-status': entry.v1.status,
    ...(entry.v1.validateKey ? { 'x-cipherscan-v1-validation': entry.v1.validateKey } : {}),
    ...(entry.v1.rateLimitKey ? { 'x-cipherscan-v1-rate-limit-key': entry.v1.rateLimitKey } : {}),
    responses: finalResponses,
  };
}

function buildOpenApiDocument() {
  const paths = {};
  const tagSet = new Set();

  for (const entry of MANIFEST) {
    if (entry.v1.status === 'excluded') continue;
    tagSet.add(entry.domain);
    const contractPath = toOpenApiPath(entry.v1.path);
    paths[contractPath] = paths[contractPath] || {};
    paths[contractPath][entry.method.toLowerCase()] = buildOperation(entry);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'ZecBlock API v1',
      version: '1.0.0-preview',
      summary: 'Versioned, contract-stable read/write API for the Zcash blockchain data and privacy-intelligence features exposed by ZecBlock.',
      description: [
        'This is the v1 contract layer. It is gated behind API_V1_ENABLED and,',
        'pre-launch, an X-API-Preview-Key header (see the previewKey security',
        'scheme) — see server/api/v1/README.md in the repository for exact',
        'mount instructions and current caveats. Every success response uses',
        'the {data, meta} envelope; every error response is an RFC 9457',
        'problem+json document. Every public inventory entry is adapted;',
        'The manifest explicitly identifies retained operational routes and payment-protected services.',
      ].join(' '),
      contact: { name: 'ZecBlock / Atmosphere Labs' },
    },
    servers: [
      { url: 'https://api.zecblock.com', description: 'Mainnet API host.' },
      { url: 'https://api.testnet.zecblock.com', description: 'Testnet API host.' },
      { url: 'http://127.0.0.1:3002', description: 'Private read-only development preview.' },
    ],
    tags: [...tagSet].sort().map((name) => ({ name })),
    security: [{ previewKey: [] }],
    components: {
      securitySchemes: {
        previewKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Preview-Key',
          description: 'Required while API_V1_LAUNCHED=false. Dropped once v1 is generally available.',
        },
      },
      schemas: {
        Problem: PROBLEM_SCHEMA,
        Meta: META_SCHEMA,
        ZatoshiString: ZATOSHI_STRING_SCHEMA,
      },
    },
    paths,
  };
}

module.exports = { buildOpenApiDocument, toOpenApiPath };
