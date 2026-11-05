'use strict';

const {cacheKey,readCached,saveCached}=require('./ask-research-cache');
const { Pool, Client } = require('pg');
const { createHash, randomUUID } = require('node:crypto');
const { compilePlan } = require('./ask-analytics-plan');
const { catalogue, views } = require('./ask-query-plan');
const { coreCatalogue, coreViews } = require('./ask-core-catalogue');
const { queryEvidence } = require('./ask-query-evidence');
const {compileResearchSQL,researchEvidence}=require('./ask-research-sql');
const {coreGatedIds}=require('../../../../lib/ask/research-catalogue');
const { askError } = require('./ask-errors');
const { sqlQuotaError } = require('./ask-sql-quota');
const { databaseFeedback, costFeedback } = require('../../../../lib/ask/sql-feedback');

// Planner cost ceilings for visitor SQL, checked with EXPLAIN (no execution)
// before a query uses a database slot for seconds. Defaults stop runaway joins
// and full cross products; tune per host with ASK_RESEARCH_MAX_COST(_BACKGROUND).
const COST_DEFAULTS = { interactive: 50000000, background: 250000000 };
function researchCostBudget(env, background) {
  const raw = background ? env.ASK_RESEARCH_MAX_COST_BACKGROUND : env.ASK_RESEARCH_MAX_COST;
  if (raw === undefined || raw === '') return background ? COST_DEFAULTS.background : COST_DEFAULTS.interactive;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1000) throw new Error('Invalid research cost budget');
  return value;
}
async function checkResearchCost(client, compiled, budget) {
  const explained = await client.query({ text: 'EXPLAIN (FORMAT JSON) ' + compiled.text, values: compiled.values });
  const estimate = Number(explained.rows[0]?.['QUERY PLAN']?.[0]?.Plan?.['Total Cost']);
  if (!Number.isFinite(estimate) || estimate < 0) throw askError('source');
  if (estimate > budget) { const error = askError('resource'); error.sqlFeedback = costFeedback(estimate, budget); throw error; }
  return estimate;
}

// Separate connection and credentials. Never import the explorer's read router:
// it can fall back to primary, which is forbidden for this service.
// The role must keep a finite connection limit; 16 matches the highest
// ASK_ANALYTICS_CONCURRENCY, and the limit must be at least that setting.
const GUARD = `SELECT pg_catalog.pg_is_in_recovery() AS standby,
  current_user = 'ask_analytics_reader' AND session_user = current_user AS identity,
  EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - pg_catalog.pg_last_xact_replay_timestamp())) AS replay_age,
  NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
    AND r.rolconnlimit BETWEEN 1 AND 16 AS restricted,
  pg_catalog.pg_size_bytes(current_setting('temp_file_limit')) BETWEEN 0 AND 16777216 AS disk_bounded,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid) AS no_memberships,
  NOT pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE')) AS no_create,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind IN ('r','v','m','f','p')
    AND (pg_catalog.has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
      OR pg_catalog.has_any_column_privilege(current_user, c.oid, 'INSERT,UPDATE,REFERENCES')
      OR ((pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT') OR pg_catalog.has_any_column_privilege(current_user, c.oid, 'SELECT'))
        AND NOT (n.nspname = 'ask_public' AND c.relname IN (${views.map(name => `'${name}'`).join(',')}) AND c.relkind = 'v')))) AS only_public_view,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind = 'S'
    AND pg_catalog.has_sequence_privilege(current_user, c.oid, 'SELECT,USAGE,UPDATE')) AS no_sequences,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosecdef
    AND pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE')) AS no_definers
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

const CORE_GUARD=GUARD.replace("pg_catalog.pg_is_in_recovery() AS standby", "NOT pg_catalog.pg_is_in_recovery() AND current_database()='ask_analytics' AS dedicated")
 .replaceAll("ask_analytics_reader", "ask_public_reader")
 .replace(/EXTRACT\(EPOCH FROM \(pg_catalog.clock_timestamp\(\) - pg_catalog.pg_last_xact_replay_timestamp\(\)\)\) AS replay_age/,"true AS source_guard")
 .replace("n.nspname = 'ask_public'", "n.nspname = 'analytics_public'")
 .replace(views.map(name=>`'${name}'`).join(','),coreViews.map(name=>`'${name}'`).join(','))
 .replace("AND pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE')) AS no_definers", "AND pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE') AND NOT (n.nspname='analytics_meta' AND p.proname='is_admitted' AND p.pronargs=0 AND p.prorettype='boolean'::regtype AND p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='analytics_owner') AND p.proconfig=ARRAY['search_path=pg_catalog'])) AS no_definers");
function checkCoreGuard(row){if(!row || !['dedicated','identity','restricted','disk_bounded','no_memberships','no_create','only_public_view','no_sequences','no_definers'].every(key=>row[key]===true))throw askError('source');}

const ADMIT_QUERY = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[4]) then return -2 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5] or '2') then
 local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
 return {-1, math.max(1, math.min(45, math.ceil((tonumber(first[2]) - tonumber(ARGV[1])) / 1000)))}
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3]); redis.call('EXPIRE', KEYS[1], 60)
redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], 172800)
return 1`;
function analyticsConfig(env) {
  const daily = Number(env.ASK_ANALYTICS_DAILY_QUERY_LIMIT);
  if (env.ASK_ANALYTICS_ENABLED !== 'true' || !env.ASK_ANALYTICS_DATABASE_URL || !Number.isInteger(daily) || daily < 1 || daily > 10000) return null;
  if(env.ASK_ANALYTICS_STORE==='logical_public_core') {
    if(env.ASK_ANALYTICS_SOCKET!=='/run/ask-public-db' || env.ASK_ANALYTICS_DATABASE_URL!=='peer-only')return null;
    return {profile:'logical_public_core',daily,connection:{host:env.ASK_ANALYTICS_SOCKET,user:'ask_public_reader',database:'ask_analytics'}};
  }
  if(env.ASK_ANALYTICS_STORE && env.ASK_ANALYTICS_STORE!=='standby_v2')return null;
  try {
    const url = new URL(env.ASK_ANALYTICS_DATABASE_URL);
    // Dedicated login, no DSN options/search_path/SSL overrides from a URL.
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.username) !== 'ask_analytics_reader' || !url.hostname || url.search || url.hash) return null;
  } catch { return null; }
  return { connectionString: env.ASK_ANALYTICS_DATABASE_URL, daily };
}
function checkGuard(row) {
  if (!row || !['standby','identity','restricted','disk_bounded','no_memberships','no_create','only_public_view','no_sequences','no_definers'].every(key => row[key] === true)
    || row.replay_age === null || !Number.isFinite(Number(row.replay_age)) || Number(row.replay_age) < -5 || Number(row.replay_age) > 120) throw askError('source');
}
function bounded(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function format(value, unit) {
  if (!/^(?:0|[1-9]\d{0,39})$/.test(value)) throw askError('source');
  const n = BigInt(value);
  return unit === 'ZEC' ? `${n / 100000000n}.${String(n % 100000000n).padStart(8, '0')} ZEC` : `${n.toLocaleString('en-US')} transactions`;
}
function evidenceFor(compiled, rows, coverage, retrievedAt) {
  if (compiled.plan.version === 2) return queryEvidence(compiled, rows, coverage, retrievedAt);
  const { plan, days, definition } = compiled;
  if (rows.length > plan.limit || Buffer.byteLength(JSON.stringify(rows)) > 16384) throw askError('source');
  if (!coverage || !Number.isInteger(Number(coverage.observed_days)) || Number(coverage.observed_days) < 0 || Number(coverage.observed_days) > days) throw askError('source');
  const facts = { window_start: plan.start, window_end: plan.end, missing_days: String(days - Number(coverage.observed_days)), returned_rows: String(rows.length) };
  const resultRows = rows.map((row, index) => {
    for (const key of ['bucket','observed_through']) if (!/^20\d{2}-\d{2}-\d{2}$/.test(row[key] || '')) throw askError('source');
    if (row.observed_through < plan.start || row.observed_through > plan.end || !Number.isInteger(row.observed_days) || row.observed_days < 1 || row.observed_days > days) throw askError('source');
    const id = `row_${String.fromCharCode(97 + index)}`;
    const value = format(row.value, definition.unit);
    facts[`${id}_date`] = row.bucket; facts[`${id}_value`] = value;
    // Calendar week/month labels may precede the selected window. They never
    // mean that observations outside the requested dates were included.
    facts[`${id}_window_start`] = row.bucket < plan.start ? plan.start : row.bucket;
    facts[`${id}_through`] = row.observed_through; facts[`${id}_days`] = String(row.observed_days);
    return { date: row.bucket, value: row.value, formatted: value, observedDays: row.observed_days, observedThrough: row.observed_through };
  });
  const result = { plan, label: definition.label, unit: definition.unit, kind: definition.kind, rows: resultRows,
    coverage: { expectedDays: days, observedDays: Number(coverage.observed_days), missingDays: days - Number(coverage.observed_days) }, retrievedAt,
    methodology: definition.kind === 'count' ? 'Non-coinbase transactions, classified by shielded components. Counts sum within the selected UTC window; weeks start Monday. Missing days are not zero. Historical counts are maintained snapshots, not a fresh transaction-table replay.' : 'Last observed pool snapshot per selected UTC day/week/month, in exact zatoshis. Balances are not summed. Week/month buckets can be partial; observedThrough identifies the actual snapshot date. Pool changes do not trace individual transfers.' };
  return { result, facts, evidenceKey: createHash('sha256').update(JSON.stringify([plan, rows, coverage])).digest('hex') };
}
function createAnalytics(env, dependencies = {}) {
  const config = analyticsConfig(env);
  if (!config) return null;
  // Simultaneous queries across every worker process (Redis leases) and in
  // this process (pool). Keep the database role's CONNECTION LIMIT at least this.
  const concurrency = Number.isInteger(Number(env.ASK_ANALYTICS_CONCURRENCY)) && Number(env.ASK_ANALYTICS_CONCURRENCY) >= 1 && Number(env.ASK_ANALYTICS_CONCURRENCY) <= 16 ? Number(env.ASK_ANALYTICS_CONCURRENCY) : 2;
  const pool = dependencies.pool || new Pool({ ...(config.connection || {connectionString:config.connectionString}), max: concurrency, connectionTimeoutMillis: 1500, idleTimeoutMillis: 10000,
    statement_timeout: 3000, query_timeout: env.ASK_RESEARCH_JOBS_ENABLED==='true'?35000:3500, application_name: 'zecblock-ask-analytics', options: '-c default_transaction_read_only=on -c search_path=pg_catalog' });
  pool.on?.('error', () => {}); // Never log connection strings or raw SQL errors.
  let active = 0;
  return {
    async execute(input, { redis, signal, now = Date.now(), execution = 'interactive' } = {}) {
      const research=input?.version===3;
      const background=research&&execution==='background'&&env.ASK_RESEARCH_JOBS_ENABLED==='true';
      if(research && (env.ASK_RESEARCH_ENABLED!=='true'||config.profile!=='logical_public_core'))throw askError('source');
      const compiled = research ? await compileResearchSQL(input,{extended:env.ASK_RESEARCH_EXTENDED==='true'}) : compilePlan(input, now, config.profile); // Validate before quota or pool access.
      if (!redis?.isReady) throw askError('unavailable');
      if (active >= concurrency) throw sqlQuotaError('ask-sql-busy', 1);
      active++;
      const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(background?35000:10000)]);
      const lease = randomUUID(); let admitted = false; let client; let released = false;
      const destroy = () => { if (client && !released) {
        // A protocol CancelRequest targets this backend only. Closing its data
        // socket alone can leave a CPU-bound query running until timeout.
        if(client.activeQuery&&Number.isInteger(client.processID))try{
          const cancel=new Client(config.connection||{connectionString:config.connectionString});
          cancel.on('error',()=>{});cancel.cancel(client,client.activeQuery);
          const timer=setTimeout(()=>cancel.connection.stream.destroy(),1000);timer.unref();
          cancel.connection.once('end',()=>clearTimeout(timer));
        }catch{/* statement_timeout remains the independent final bound */}
        released = true; client.release(true);
      } };
      deadline.addEventListener('abort', destroy, { once: true });
      try {
        deadline.throwIfAborted();
        const accepted = await bounded(redis.eval(ADMIT_QUERY, { keys: ['ask:{mainnet}:analytics:active', `ask:{mainnet}:analytics:queries:${new Date(now).toISOString().slice(0,10)}`], arguments: [String(now), String(now + (background?45000:30000)), lease, String(config.daily), String(concurrency)] }), deadline);
        admitted = Number(accepted) === 1;
        deadline.throwIfAborted();
        if (!admitted) {
          if (Number(accepted) === -2) throw sqlQuotaError('ask-sql-global-day', Math.max(1, Math.ceil((86400000 - now % 86400000) / 1000)));
          if (Array.isArray(accepted) && Number(accepted[0]) === -1) throw sqlQuotaError('ask-sql-busy', Math.max(1, Math.min(45, Number(accepted[1]) || 1)));
          const error = askError('quota'); error.quota = true; throw error;
        }
        client = await bounded(pool.connect().then(connection => { if (deadline.aborted) { connection.release(true); throw deadline.reason; } return connection; }), deadline);
        deadline.throwIfAborted();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query(`SET LOCAL statement_timeout='${background?'30s':'3s'}'; SET LOCAL lock_timeout='500ms'; SET LOCAL idle_in_transaction_session_timeout='5s'; SET LOCAL work_mem='1MB'; SET LOCAL search_path=pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL jit=off`);
        if(config.profile==='logical_public_core')checkCoreGuard((await client.query(CORE_GUARD)).rows[0]);
        else checkGuard((await client.query(GUARD)).rows[0]);
        let coverage,checkpoint;
        if(config.profile==='logical_public_core'){
          const verified=(await client.query('SELECT * FROM analytics_public.coverage')).rows;
          if(verified.length!==1 || verified[0].schema_version!==1 || verified[0].authority!=='logical_public_core' || verified[0].network!=='mainnet' || verified[0].ready!==true)throw askError('source');
          checkpoint=verified[0];
          coverage=(await client.query('SELECT NULL::int AS observed_days,pg_catalog.to_timestamp(timestamp)::text AS indexed_through FROM analytics_public.blocks ORDER BY height DESC LIMIT 1')).rows[0];
          if(!coverage)throw askError('source');
          coverage.consistency='verified-canonical-core';
        } else coverage = (await client.query(compiled.plan.version === 2
          ? `SELECT ${compiled.plan.dataset === 'daily' ? '(SELECT count(*)::int FROM ask_public.daily_v2 WHERE date >= $1::date AND date <= $2::date)' : 'NULL::int'} AS observed_days, (SELECT pg_catalog.to_timestamp(timestamp)::text FROM ask_public.blocks_v2 ORDER BY height DESC LIMIT 1) AS indexed_through`
          : 'SELECT count(*)::int AS observed_days FROM ask_public.daily_v1 WHERE date >= $1::date AND date <= $2::date', compiled.plan.version === 1 || compiled.plan.dataset === 'daily' ? compiled.values.slice(0,2) : [])).rows[0];
        // Extended relation readiness precedes execution and cache lookup. A failed
        // copy/refresh is never reported as an empty dataset.
        let datasetCheckpoints=[];
        if(research&&compiled.datasets.some(d=>!coreGatedIds.includes(d))){
          datasetCheckpoints=(await client.query('SELECT dataset,ready,generation,verified_at,source_through FROM analytics_public.dataset_coverage WHERE dataset=ANY($1::text[])',[compiled.datasets.filter(d=>!coreGatedIds.includes(d))])).rows;
          if(datasetCheckpoints.length!==compiled.datasets.filter(d=>!coreGatedIds.includes(d)).length||datasetCheckpoints.some(d=>d.ready!==true))throw askError('dataset');
          // Independent refresh generations invalidate cached joined research.
          checkpoint={...checkpoint,datasetCheckpoints};
          const times=datasetCheckpoints.map(d=>Date.parse(d.source_through)).filter(Number.isFinite);
          if(times.length)coverage.indexed_through=new Date(Math.min(Date.parse(coverage.indexed_through),...times)).toISOString();
        }
        // Read admission in this transaction BEFORE any cache lookup. A stale
        // feed or changed checkpoint never reuses an old canonical result.
        const key=research&&env.ASK_RESEARCH_CACHE_ENABLED==='true'?cacheKey(compiled,checkpoint):null;
        const cached=key?await bounded(readCached(redis,key,compiled),deadline):null;
        if(cached){await client.query('ROLLBACK');client.release();released=true;return {result:cached};}
        if (research) await checkResearchCost(client, compiled, researchCostBudget(env, background));
        const raw = research ? await client.query({text:compiled.text,values:compiled.values,rowMode:'array',types:{getTypeParser:()=>value=>value}}) : await client.query(compiled.text, compiled.values);
        const rows=raw.rows;
        deadline.throwIfAborted();
        const evidence = research ? {result:researchEvidence(compiled,rows,raw.fields,coverage,new Date(now).toISOString())} : evidenceFor(compiled, rows, coverage, new Date(now).toISOString());
        await client.query('ROLLBACK');
        client.release(); released = true;
        // Cache is only an optimization. Cache-write failures cannot turn a
        // verified result into an unavailable source or trigger a SQL retry.
        if(key)try{await bounded(saveCached(redis,key,evidence.result),deadline);}catch{/* no cache */}
        return evidence;
      } catch (error) {
        // Discard aborted/failed transactions; no session state can leak back.
        destroy();
        if (deadline.aborted) throw deadline.reason;
        if (error?.quota || error?.askKind) throw error;
        // Fixed categories only, plus sanitized messages for allowlisted
        // SQLSTATEs caused by the visitor's own SQL text (see sql-feedback).
        if(research&&error?.code==='53400'){const safe=askError('resource');safe.code='53400';throw safe;}
        if(research&&error?.code==='57014'){const safe=askError('timeout');safe.code='57014';throw safe;}
        const feedback=research?databaseFeedback(error):null;
        if(feedback){const safe=askError('query');safe.code=error.code;safe.sqlFeedback=feedback;throw safe;}
        throw askError('source');
      } finally {
        deadline.removeEventListener('abort', destroy);
        active--;
        if (admitted) { try { await bounded(redis.zRem('ask:{mainnet}:analytics:active', lease), AbortSignal.timeout(1000)); } catch { /* bounded lease expires */ } }
      }
    },
    close: () => pool.end(),
    catalogue:config.profile==='logical_public_core'?coreCatalogue:catalogue,
  };
}
module.exports = { createAnalytics, researchCostBudget, checkResearchCost, analyticsConfig, checkGuard, evidenceFor, ADMIT_QUERY, GUARD, CORE_GUARD, checkCoreGuard };
