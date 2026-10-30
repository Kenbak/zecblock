'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createMcpRouter } = require('../../v1/mcp');
const { parseKeys, KEY_LIMITS, IP_LIMITS, ADMIT_KEYLESS, DEFAULT_DAILY_LIMIT } = require('../../v1/mcp/sql');
const { ADMIT_WORK } = require('../../v1/lib/ask-budget');
const { compileResearchSQL, researchEvidence } = require('../../v1/lib/ask-research-sql');

// Obviously fake, low-entropy test tokens (built at runtime, never real keys).
const token = letter => `zift_${letter.repeat(30)}`;
const KEY = token('k');
const hash = value => createHash('sha256').update(value).digest('hex');
const env = { ZIFT_MCP_SQL_ENABLED: 'true', ZIFT_MCP_SQL_KEYS: `acme:${hash(KEY)}`, ASK_ABUSE_SECRET: 'mcp-test-abuse-secret-at-least-32-chars', ASK_RESEARCH_ENABLED: 'true', ASK_RESEARCH_EXTENDED: 'true', ASK_ANALYTICS_STORE: 'logical_public_core' };
const config = { network: 'mainnet', internalBaseUrl: 'http://127.0.0.1:1', internalServiceKey: 'x', maxResponseBytes: 1048576 };

async function serve(t, { envOverrides = {}, network = 'mainnet', admit = 1, execute } = {}) {
  const state = { executed: [], admissions: [] };
  const analytics = {
    async execute(request) {
      state.executed.push(request);
      if (execute) return execute(request);
      const compiled = await compileResearchSQL(request, { extended: true });
      return { result: researchEvidence(compiled, [['100', '100000']], [{ name: 'height', dataTypeID: 20 }, { name: 'fees', dataTypeID: 1700 }], { indexed_through: '2026-10-29T00:00:00Z' }, '2026-10-30T00:00:00Z') };
    },
  };
  const redis = { isReady: true, async eval(script, options) { assert.ok(script === ADMIT_WORK || script === ADMIT_KEYLESS); state.admissions.push({ ...options, keyless: script === ADMIT_KEYLESS }); return admit; } };
  const router = createMcpRouter({ ...config, network }, { env: { ...env, ...envOverrides }, analytics, redis });
  const app = express();
  app.use((req, _res, next) => { req.v1 = { network, abortSignal: new AbortController().signal }; next(); });
  app.use('/mcp', router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { router.stop(); server.closeAllConnections(); server.close(); });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  async function client(key) {
    const c = new Client({ name: 'zift-sql-test', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(url, key ? { requestInit: { headers: { Authorization: `Bearer ${key}` } } } : {}));
    t.after(() => c.close());
    return c;
  }
  return { state, client };
}
const text = result => result.content[0].text;

test('SQL tools appear only when enabled on mainnet; the catalogue needs no key', async t => {
  const off = await (await serve(t, { envOverrides: { ZIFT_MCP_SQL_ENABLED: 'false' } })).client();
  assert.ok(!(await off.listTools()).tools.some(tool => /sql/.test(tool.name)));
  const testnet = await (await serve(t, { network: 'testnet' })).client();
  assert.ok(!(await testnet.listTools()).tools.some(tool => /sql/.test(tool.name)));
  const api = await serve(t), c = await api.client();
  const tools = (await c.listTools()).tools.filter(tool => /^sql_/.test(tool.name));
  assert.deepEqual(tools.map(tool => tool.name), ['sql_catalogue', 'sql_query']);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));
  const catalogue = (await c.callTool({ name: 'sql_catalogue', arguments: {} })).structuredContent;
  assert.ok(catalogue.datasets.some(dataset => dataset.id === 'address_activity'), 'extended datasets are listed');
  assert.ok(catalogue.examples.length > 0 && catalogue.rules.includes('zatoshis'));
  assert.equal(api.state.admissions.length, 0); assert.equal(api.state.executed.length, 0);
});

test('sql_query works without a key under per-IP and MCP-wide limits; a wrong key is refused', async t => {
  const api = await serve(t, { envOverrides: { ZIFT_MCP_SQL_DAILY_LIMIT: '1500' } });
  const ok = await (await api.client()).callTool({ name: 'sql_query', arguments: { sql: 'SELECT height FROM blocks LIMIT 1' } });
  assert.equal(ok.isError, undefined); assert.equal(api.state.executed.length, 1);
  const [admission] = api.state.admissions;
  assert.equal(admission.keyless, true);
  assert.match(admission.keys[0], /^ask:\{mainnet\}:work:mcp-ip:[a-f0-9]{64}:\d+$/, 'a daily HMAC of the IP, never the raw address');
  assert.match(admission.keys[2], /^ask:\{mainnet\}:work:mcp-all:\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(admission.arguments, [String(IP_LIMITS.minute), String(IP_LIMITS.day), '1500']);
  const wrong = await (await api.client(token('w'))).callTool({ name: 'sql_query', arguments: { sql: 'SELECT height FROM blocks LIMIT 1' } });
  assert.equal(wrong.isError, true); assert.match(text(wrong), /not recognized/);
  assert.equal(api.state.executed.length, 1); assert.equal(api.state.admissions.length, 1);
});

test('SQL tools stay off without the abuse secret that hashes client IPs', async t => {
  const c = await (await serve(t, { envOverrides: { ASK_ABUSE_SECRET: '' } })).client();
  assert.ok(!(await c.listTools()).tools.some(tool => /^sql_/.test(tool.name)));
});

test('sql_query runs a compiled read-only SELECT and returns rows, units and provenance', async t => {
  const api = await serve(t), c = await api.client(KEY);
  const result = await c.callTool({ name: 'sql_query', arguments: { sql: 'SELECT height, fees FROM blocks ORDER BY height DESC', limit: 5 } });
  assert.equal(result.isError, undefined);
  const value = result.structuredContent;
  assert.deepEqual(value.rows, [['100', '100000']]); assert.equal(value.rowCount, 1);
  assert.deepEqual(value.columns.map(column => column.name), ['height', 'fees']);
  assert.match(value.sql, /analytics_public\.blocks_query/); assert.ok(value.fingerprint && value.coverage);
  assert.equal(api.state.executed[0].limit, 5);
  assert.equal(api.state.admissions.length, 1); assert.equal(api.state.admissions[0].keyless, false, 'a key holder uses its own quota');
  assert.match(api.state.admissions[0].keys[0], /^ask:\{mainnet\}:work:mcp:[a-f0-9]{32}:\d{4}-\d{2}-\d{2}:\d+$/);
  assert.deepEqual(api.state.admissions[0].arguments, [String(KEY_LIMITS.minute), String(KEY_LIMITS.day)]);
});

test('writes, system catalogues and invalid SQL are rejected by policy before any quota or worker use', async t => {
  const api = await serve(t), c = await api.client(KEY);
  for (const sql of ['DELETE FROM blocks', 'SELECT usename, passwd FROM pg_shadow', "SELECT pg_read_file('/etc/passwd')", 'SELECT * FROM blocks; DROP TABLE blocks', 'SELEC height FROM blocks']) {
    const result = await c.callTool({ name: 'sql_query', arguments: { sql } });
    assert.equal(result.isError, true, sql); assert.match(text(result), /^SQL rejected:/, sql);
  }
  assert.equal(api.state.executed.length, 0); assert.equal(api.state.admissions.length, 0);
});

test('per-key quotas and database errors come back as readable tool errors', async t => {
  const site = await serve(t, { admit: -3 });
  const capped = await (await site.client()).callTool({ name: 'sql_query', arguments: { sql: 'SELECT height FROM blocks LIMIT 1' } });
  assert.equal(capped.isError, true); assert.match(text(capped), /site-wide daily allowance/); assert.equal(site.state.executed.length, 0);
  const limited = await serve(t, { admit: -1 });
  const quota = await (await limited.client(KEY)).callTool({ name: 'sql_query', arguments: { sql: 'SELECT height FROM blocks LIMIT 1' } });
  assert.equal(quota.isError, true); assert.match(text(quota), /per-minute query allowance/); assert.equal(limited.state.executed.length, 0);
  const failing = await serve(t, { execute: async () => { throw Object.assign(Error('worker'), { askKind: 'query', sqlFeedback: { stage: 'database', message: 'column "fee" does not exist', code: '42703' } }); } });
  const error = await (await failing.client(KEY)).callTool({ name: 'sql_query', arguments: { sql: 'SELECT height FROM blocks LIMIT 1' } });
  assert.equal(error.isError, true); assert.match(text(error), /column "fee" does not exist/);
});

test('keys are parsed strictly and stored only as hashes', () => {
  const keys = parseKeys(`acme:${hash(KEY)}, bad entry ,UPPER:${hash('x')},x:${'z'.repeat(64)}, team-2:${hash(token('a'))}`);
  assert.deepEqual(keys.map(key => key.label), ['acme', 'team-2']);
  assert.ok(keys.every(key => Buffer.isBuffer(key.hash) && key.hash.length === 32));
});

test('keyless admission is atomic in Redis: a denial changes no counter', async t => {
  const { spawn } = require('node:child_process');
  const { mkdtemp, rm } = require('node:fs/promises');
  const { createClient } = require('redis');
  const dir = await mkdtemp('/tmp/mcp-sql-redis-'), socket = `${dir}/redis.sock`;
  const child = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700', '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => { let out = ''; child.stdout.on('data', d => { out += d; if (/ready to accept connections/i.test(out)) resolve(); }); child.once('exit', () => reject(Error('redis exited'))); setTimeout(() => reject(Error('redis timeout')), 5000); });
  const redis = createClient({ socket: { path: socket, reconnectStrategy: false } }); redis.on('error', () => {}); await redis.connect();
  t.after(async () => { redis.destroy(); child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); });
  const keys = ['m', 'd', 'all'], admit = (minute, day, all) => redis.eval(ADMIT_KEYLESS, { keys, arguments: [String(minute), String(day), String(all)] });
  assert.equal(await admit(2, 5, 3), 1); assert.equal(await admit(2, 5, 3), 1);
  assert.equal(await admit(2, 5, 3), -1, 'per-minute limit');
  assert.deepEqual(await Promise.all(keys.map(key => redis.get(key))), ['2', '2', '2'], 'the denied call changed nothing');
  await redis.set('m', '0');
  assert.equal(await admit(2, 5, 2), -3, 'MCP-wide cap is checked first');
  assert.deepEqual(await Promise.all(keys.map(key => redis.get(key))), ['0', '2', '2']);
  assert.ok(await redis.ttl('all') > 0 && await redis.ttl('d') > 0, 'counters expire');
  assert.equal(DEFAULT_DAILY_LIMIT, 2000);
});
