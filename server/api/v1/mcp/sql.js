'use strict';
// Zift SQL over MCP (mainnet only, opt-in with ZIFT_MCP_SQL_ENABLED=true).
// No AI runs here: the client's own model writes the SQL. Queries take the
// same path as Zift's manual SQL: the reviewed AST compiler and policy, then
// the read-only analytics worker with its row, time and site-wide limits.
// Turnstile cannot run inside an MCP client, so sql_query is limited per client
// IP (like Zift's SQL lane) and by an MCP-wide daily cap that keeps the shared
// worker available to Zift. Operator-issued API keys (stored only as SHA-256
// hashes) are optional and get their own, higher quotas instead.
const { z } = require('zod');
const { createHash, timingSafeEqual } = require('node:crypto');
const { compileResearchSQL, instructionsFor } = require('../lib/ask-research-sql');
const { policyFeedback } = require('../../../../lib/ask/sql-feedback');
const { catalogueFor } = require('../../../../lib/ask/research-catalogue');
const { examplesFor } = require('../../../../lib/ask/sql-examples');
const { ADMIT_WORK, identityFor } = require('../lib/ask-budget');
const { classifyFailure } = require('../lib/ask-errors');
const { createAnalyticsClient } = require('../lib/ask-analytics-client');

const KEY_LIMITS = Object.freeze({ minute: 10, day: 300 });
const IP_LIMITS = Object.freeze({ minute: 10, day: 100 });
const DEFAULT_DAILY_LIMIT = 2000;
// Keyless admission: per-IP minute and day counters plus the MCP-wide day cap,
// checked and incremented together so a denial changes nothing.
const ADMIT_KEYLESS = `
if tonumber(redis.call('GET', KEYS[3]) or '0') >= tonumber(ARGV[3]) then return -3 end
if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[2]) then return -2 end
if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return -1 end
redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], 120)
redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], 172800)
redis.call('INCR', KEYS[3]); redis.call('EXPIRE', KEYS[3], 172800)
return 1`;
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

// undefined: no key sent; null: a key was sent but is not recognized.
function keyHolder(req, keys) {
  if (!req.headers.authorization) return undefined;
  const token = /^Bearer\s+([A-Za-z0-9_-]{24,128})$/.exec(req.headers.authorization)?.[1];
  if (!token) return null;
  const hash = sha256(token);
  let holder = null;
  // Compare against every key so timing does not reveal which one matched.
  for (const key of keys) if (timingSafeEqual(hash, key.hash)) holder = key.label;
  return holder;
}

async function admitKeyless(redis, config, req, dailyLimit, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10), minute = Math.floor(now / 60000);
  const prefix = `ask:{mainnet}:work:mcp-ip:${identityFor(config, req, day)}`;
  return Number(await redis.eval(ADMIT_KEYLESS, {
    keys: [`${prefix}:${minute}`, `${prefix}:day`, `ask:{mainnet}:work:mcp-all:${day}`],
    arguments: [String(IP_LIMITS.minute), String(IP_LIMITS.day), String(dailyLimit)],
  }));
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
    limits: { rowsPerQuery: 200, defaultRows: 100, perClient: `${IP_LIMITS.minute} queries per minute and ${IP_LIMITS.day} per UTC day per client IP (no key needed)`, withKey: `${KEY_LIMITS.minute} per minute and ${KEY_LIMITS.day} per day per optional API key`, statement: 'one read-only SELECT (CTEs, joins and window functions allowed)' },
    units: 'fees, amount and balances are integer zatoshis (100000000 = 1 ZEC) unless a dataset says otherwise; timestamp is Unix seconds UTC; missing values are unknown, never zero.',
  };
}

function createSqlTools(env, network, dependencies = {}) {
  const extended = env.ASK_RESEARCH_EXTENDED === 'true';
  const keys = parseKeys(env.ZIFT_MCP_SQL_KEYS);
  const dailyLimit = Number.isSafeInteger(Number(env.ZIFT_MCP_SQL_DAILY_LIMIT)) && Number(env.ZIFT_MCP_SQL_DAILY_LIMIT) > 0 ? Number(env.ZIFT_MCP_SQL_DAILY_LIMIT) : DEFAULT_DAILY_LIMIT;
  // Per-IP identity uses the same daily HMAC as Zift's admission (never the raw IP).
  const abuse = env.ASK_ABUSE_SECRET && env.ASK_ABUSE_SECRET.length >= 32 ? { abuseSecret: env.ASK_ABUSE_SECRET } : null;
  const enabled = network === 'mainnet' && env.ZIFT_MCP_SQL_ENABLED === 'true' && env.ASK_RESEARCH_ENABLED === 'true' && env.ASK_ANALYTICS_STORE === 'logical_public_core' && !!abuse;
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
      description: 'Run one read-only PostgreSQL SELECT over the public Zcash datasets from sql_catalogue and return the rows. Rejected SQL comes back with the policy or database error so you can fix it. No key needed; limited per client.',
      schema: z.object({ sql: z.string().min(1).max(8192), limit: z.number().int().min(1).max(200).default(100) }).strict(),
      timeoutMs: 20000,
      async run({ sql, limit }, req, signal) {
        const holder = keyHolder(req, keys);
        if (holder === null) return fail('This API key is not recognized. Remove the Authorization header to use the keyless limits, or check the key.');
        let request;
        try { request = (await compileResearchSQL({ version: 3, sql, limit }, { extended })).request; }
        catch (error) {
          const feedback = policyFeedback(error, sql);
          return fail(`SQL rejected: ${feedback?.message || 'use one read-only SELECT over the datasets in sql_catalogue.'}${feedback?.hint ? ` ${feedback.hint}` : ''}`, { stage: feedback?.stage || 'policy', ...(feedback?.line ? { line: feedback.line, column: feedback.column } : {}) });
        }
        const redis = dependencies.redis || req.app?.locals?.redisClient;
        if (!redis?.isReady) return fail('SQL is temporarily unavailable. Retry shortly.');
        const limits = holder ? KEY_LIMITS : IP_LIMITS, who = holder ? 'This key' : 'This client';
        const admitted = await (holder ? admitKey(redis, holder) : admitKeyless(redis, abuse, req, dailyLimit)).catch(() => 0);
        if (admitted === -3) return fail('SQL over MCP reached its site-wide daily allowance. It resets at 00:00 UTC; Zift at https://zecblock.com/zift remains available.', { quota: 'site-day' });
        if (admitted === -1 || admitted === -2) return fail(`${who} reached its ${admitted === -1 ? 'per-minute' : 'daily'} query allowance (${admitted === -1 ? limits.minute : limits.day}). Retry later.`, { quota: admitted === -1 ? 'minute' : 'day' });
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

module.exports = { createSqlTools, parseKeys, keyHolder, admitKey, admitKeyless, catalogue, KEY_LIMITS, IP_LIMITS, ADMIT_KEYLESS, DEFAULT_DAILY_LIMIT };
