'use strict';
// Zift SQL over MCP (mainnet only, opt-in with ZIFT_MCP_SQL_ENABLED=true).
// No AI runs here: the client's own model writes the SQL. Queries take the
// same path as Zift's manual SQL: the reviewed AST compiler and policy, then
// the read-only analytics worker with its row, time and site-wide limits.
// Turnstile cannot run inside an MCP client, so sql_query needs an operator-
// issued API key (stored only as a SHA-256 hash) with its own quotas.
const { z } = require('zod');
const { createHash, timingSafeEqual } = require('node:crypto');
const { compileResearchSQL, instructionsFor } = require('../lib/ask-research-sql');
const { policyFeedback } = require('../../../../lib/ask/sql-feedback');
const { catalogueFor } = require('../../../../lib/ask/research-catalogue');
const { examplesFor } = require('../../../../lib/ask/sql-examples');
const { ADMIT_WORK } = require('../lib/ask-budget');
const { classifyFailure } = require('../lib/ask-errors');
const { createAnalyticsClient } = require('../lib/ask-analytics-client');

const KEY_LIMITS = Object.freeze({ minute: 10, day: 300 });
const sha256 = value => createHash('sha256').update(value).digest();

// ZIFT_MCP_SQL_KEYS: comma-separated "label:sha256hex" entries. Labels name
// the key holder in quotas only; raw keys are never stored or logged.
function parseKeys(value) {
  const keys = [];
  for (const entry of String(value || '').split(',').map(part => part.trim()).filter(Boolean)) {
    const match = /^([a-z0-9][a-z0-9_-]{0,31}):([a-f0-9]{64})$/.exec(entry);
    if (match) keys.push({ label: match[1], hash: Buffer.from(match[2], 'hex') });
  }
  return keys;
}

function keyHolder(req, keys) {
  const token = /^Bearer\s+([A-Za-z0-9_-]{24,128})$/.exec(req.headers.authorization || '')?.[1];
  if (!token) return null;
  const hash = sha256(token);
  let holder = null;
  // Compare against every key so timing does not reveal which one matched.
  for (const key of keys) if (timingSafeEqual(hash, key.hash)) holder = key.label;
  return holder;
}

async function admitKey(redis, label, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10), minute = Math.floor(now / 60000);
  const prefix = `ask:{mainnet}:work:mcp:${sha256(label).toString('hex').slice(0, 32)}:${day}`;
  return Number(await redis.eval(ADMIT_WORK, {
    keys: [`${prefix}:${minute}`, `${prefix}:day`, `${prefix}:${minute}`, `${prefix}:day`],
    arguments: [String(KEY_LIMITS.minute), String(KEY_LIMITS.day)],
  }));
}

const fail = (text, extra = {}) => ({ isError: true, content: [{ type: 'text', text }], structuredContent: { error: text, ...extra } });

function catalogue(extended) {
  return {
    datasets: catalogueFor(extended).map(({ id, title, columns, description }) => ({ id, title, columns: columns.split(', '), description })),
    rules: instructionsFor(extended).replace(/^Write one PostgreSQL 16 SELECT[^.]*\.\s*/, ''),
    examples: examplesFor(extended).map(({ title, description, sql }) => ({ title, description, sql })),
    limits: { rowsPerQuery: 200, defaultRows: 100, queryKey: `${KEY_LIMITS.minute} per minute and ${KEY_LIMITS.day} per day per key`, statement: 'one read-only SELECT (CTEs, joins and window functions allowed)' },
    units: 'fees, amount and balances are integer zatoshis (100000000 = 1 ZEC) unless a dataset says otherwise; timestamp is Unix seconds UTC; missing values are unknown, never zero.',
  };
}

function createSqlTools(env, network, dependencies = {}) {
  const extended = env.ASK_RESEARCH_EXTENDED === 'true';
  const keys = parseKeys(env.ZIFT_MCP_SQL_KEYS);
  const enabled = network === 'mainnet' && env.ZIFT_MCP_SQL_ENABLED === 'true' && env.ASK_RESEARCH_ENABLED === 'true' && env.ASK_ANALYTICS_STORE === 'logical_public_core';
  if (!enabled) return { tools: [], stop: async () => {} };
  const analytics = dependencies.analytics || createAnalyticsClient(env);
  if (!analytics) return { tools: [], stop: async () => {} };
  const tools = [
    {
      name: 'sql_catalogue',
      description: 'Describe the public Zcash datasets queryable with sql_query: tables, columns, units, query rules and worked examples. Read this before writing SQL. No key needed.',
      schema: z.object({}).strict(),
      timeoutMs: 15000,
      async run() {
        const value = catalogue(extended);
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      },
    },
    {
      name: 'sql_query',
      description: 'Run one read-only PostgreSQL SELECT over the public Zcash datasets from sql_catalogue and return the rows. Rejected SQL comes back with the policy or database error so you can fix it. Requires an API key (Authorization: Bearer <key>).',
      schema: z.object({ sql: z.string().min(1).max(8192), limit: z.number().int().min(1).max(200).default(100) }).strict(),
      timeoutMs: 20000,
      async run({ sql, limit }, req, signal) {
        if (!keys.length) return fail('SQL over MCP has no keys configured yet.');
        const holder = keyHolder(req, keys);
        if (!holder) return fail('sql_query requires an API key: send Authorization: Bearer <key>. Ask ZecBlock for a key, or use sql_catalogue and run the query in Zift at https://zecblock.com/zift.');
        let request;
        try { request = (await compileResearchSQL({ version: 3, sql, limit }, { extended })).request; }
        catch (error) {
          const feedback = policyFeedback(error, sql);
          return fail(`SQL rejected: ${feedback?.message || 'use one read-only SELECT over the datasets in sql_catalogue.'}${feedback?.hint ? ` ${feedback.hint}` : ''}`, { stage: feedback?.stage || 'policy', ...(feedback?.line ? { line: feedback.line, column: feedback.column } : {}) });
        }
        const redis = dependencies.redis || req.app?.locals?.redisClient;
        if (!redis?.isReady) return fail('SQL is temporarily unavailable. Retry shortly.');
        const admitted = await admitKey(redis, holder).catch(() => 0);
        if (admitted === -1 || admitted === -2) return fail(`This key reached its ${admitted === -1 ? 'per-minute' : 'daily'} query allowance (${admitted === -1 ? KEY_LIMITS.minute : KEY_LIMITS.day}). Retry later.`, { quota: admitted === -1 ? 'minute' : 'day' });
        if (admitted !== 1) return fail('SQL is temporarily unavailable. Retry shortly.');
        try {
          const { result } = await analytics.execute(request, { signal });
          const value = {
            sql: result.query.sql, columns: result.columns.map(column => ({ name: column.label, type: column.type })),
            rows: result.rows, rowCount: result.rows.length, truncated: result.truncated, datasets: result.datasets,
            coverage: result.coverage, units: result.units, indexedThrough: result.indexedThrough, retrievedAt: result.retrievedAt, fingerprint: result.fingerprint,
          };
          return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
        } catch (error) {
          const failure = classifyFailure(error);
          return fail(`${failure.detail}${failure.sql ? ` Database said: ${failure.sql.message}${failure.sql.hint ? ` (${failure.sql.hint})` : ''}` : ''}`, { code: failure.code });
        }
      },
    },
  ];
  return { tools, stop: async () => { if (!dependencies.analytics) await analytics.close?.(); } };
}

module.exports = { createSqlTools, parseKeys, keyHolder, admitKey, catalogue, KEY_LIMITS };
