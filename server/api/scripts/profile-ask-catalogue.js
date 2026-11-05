'use strict';

// Emits a fixed, operator-only psql script. No DSN/credentials, arbitrary SQL,
// runtime grants, schema modifications or model calls. Read-only standby only.
const catalogue = require('../v1/lib/ask-public-catalogue');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const DAY = 86400000;

function windowOptions(options = {}, now = Date.now()) {
  const end = options.end || new Date(Math.floor(now / DAY) * DAY - DAY).toISOString().slice(0, 10);
  const start = options.start || new Date(Date.parse(end) - 6 * DAY).toISOString().slice(0, 10);
  for (const date of [start, end]) {
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(Date.parse(date)).toISOString().slice(0, 10) !== date) throw new Error('Invalid completed UTC date');
  }
  const days = (Date.parse(end) - Date.parse(start)) / DAY + 1;
  if (days < 1 || days > 31 || Date.parse(end) >= Math.floor(now / DAY) * DAY) throw new Error('Choose 1–31 completed UTC days');
  return { start, end, days, from: Date.parse(start) / 1000, to: Date.parse(end) / 1000 + DAY / 1000 };
}

const GUARD_SQL = `DO $$ BEGIN
  IF current_database() <> 'zcash_explorer_mainnet' OR NOT pg_is_in_recovery()
    OR pg_last_xact_replay_timestamp() IS NULL
    OR clock_timestamp() - pg_last_xact_replay_timestamp() > interval '120 seconds'
  THEN RAISE EXCEPTION 'Fresh mainnet standby required; no primary fallback'; END IF;
END $$;`;

function metadataSQL() {
  const rows = catalogue.sources.map(s => `(${quote(s.id)},${quote(s.relation)},ARRAY[${Object.keys(s.fields).map(quote).join(',')}])`).join(',\n');
  return `WITH requested(id,relation,expected_columns) AS (VALUES ${rows}),
  inspected AS (SELECT r.*,c.oid,c.relkind,c.reltuples,c.relpages FROM requested r LEFT JOIN pg_class c ON c.oid=to_regclass(r.relation)),
  head AS (SELECT b.height,b.hash,b.timestamp FROM public.blocks b ORDER BY b.height DESC LIMIT 1)
SELECT jsonb_build_object('kind','inventory','catalogue_version',${catalogue.version},'observed_at',clock_timestamp(),'standby',pg_is_in_recovery(),
  'replay_age_seconds',extract(epoch FROM clock_timestamp()-pg_last_xact_replay_timestamp()),
  'snapshot_height',(SELECT height::text FROM head),
  'snapshot_hash',(SELECT hash FROM head),
  'snapshot_block_time',(SELECT timestamp::text FROM head),
  'sources',(SELECT jsonb_agg(jsonb_build_object('id',i.id,'relation',i.relation,'present',i.oid IS NOT NULL,'kind',i.relkind,
    'estimated_rows',CASE WHEN i.reltuples>=0 THEN i.reltuples::numeric::text ELSE NULL END,
    'heap_bytes',CASE WHEN i.oid IS NOT NULL THEN pg_relation_size(i.oid)::text END,
    'table_bytes',CASE WHEN i.oid IS NOT NULL THEN pg_table_size(i.oid)::text END,
    'index_bytes',CASE WHEN i.oid IS NOT NULL THEN pg_indexes_size(i.oid)::text END,
    'total_bytes',CASE WHEN i.oid IS NOT NULL THEN pg_total_relation_size(i.oid)::text END,
    'missing_columns',(SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM unnest(i.expected_columns) e WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=i.oid AND a.attname=e AND a.attnum>0 AND NOT a.attisdropped)),
    'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',NOT a.attnotnull) ORDER BY a.attnum),'[]'::jsonb) FROM pg_attribute a WHERE a.attrelid=i.oid AND a.attname=ANY(i.expected_columns) AND a.attnum>0 AND NOT a.attisdropped),
    'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',ic.relname,'valid',x.indisvalid,'unique',x.indisunique,'primary',x.indisprimary,'definition',pg_get_indexdef(x.indexrelid)) ORDER BY ic.relname),'[]'::jsonb) FROM pg_index x JOIN pg_class ic ON ic.oid=x.indexrelid WHERE x.indrelid=i.oid)
  ) ORDER BY i.id) FROM inspected i));`;
}

function probes(options = {}, now) {
  const w = windowOptions(options, now);
  return [
    { id: 'daily_coverage', text: `SELECT d::date::text AS day, p.date IS NOT NULL AS observed,
      (p.shielded_count::numeric+p.transparent_count::numeric)::text AS transactions,
      p.orchard_pool_size IS NULL AS orchard_missing,p.ironwood_pool_size IS NULL AS ironwood_missing
      FROM generate_series(${quote(w.start)}::date,${quote(w.end)}::date,interval '1 day') d
      LEFT JOIN public.privacy_trends_daily p ON p.date=d::date ORDER BY d`, values: w },
    { id: 'canonical_activity', text: `SELECT (to_timestamp(b.timestamp) AT TIME ZONE 'UTC')::date::text AS day,
      count(*)::text AS blocks,sum(activity.transactions)::text AS transactions,
      sum(activity.coinbase_transactions)::text AS coinbase_transactions,sum(activity.unknown_coinbase)::text AS unknown_coinbase
      FROM public.blocks b CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE t.is_coinbase=false) AS transactions,
        count(*) FILTER (WHERE t.is_coinbase=true) AS coinbase_transactions,
        count(*) FILTER (WHERE t.is_coinbase IS NULL) AS unknown_coinbase
        FROM public.transactions t WHERE t.block_height=b.height AND t.block_hash=b.hash
      ) activity WHERE b.timestamp>=${w.from} AND b.timestamp<${w.to} GROUP BY 1 ORDER BY 1`, values: w },
    { id: 'shielding_by_miner', text: `WITH boundary AS MATERIALIZED (
      SELECT txid,block_height,block_time,sum(amount_zat::numeric) AS amount FROM public.shielded_flows
      WHERE flow_type='shield' AND amount_zat>=0 AND block_time>=${w.from} AND block_time<${w.to}
      GROUP BY txid,block_height,block_time)
      SELECT b.miner_address AS miner,count(*)::text AS shielding_transactions,sum(f.amount)::text AS shielding_zat,
      round(avg(t.fee::numeric),6)::text AS average_fee_zat,count(*) FILTER (WHERE t.fee IS NULL)::text AS missing_fees
      FROM boundary f JOIN public.transactions t ON t.txid=f.txid AND t.block_height=f.block_height
      JOIN public.blocks b ON b.height=t.block_height AND b.hash=t.block_hash AND b.timestamp=f.block_time
      WHERE t.is_coinbase=false AND b.timestamp>=${w.from} AND b.timestamp<${w.to}
      GROUP BY b.miner_address ORDER BY count(*) DESC,b.miner_address ASC NULLS LAST LIMIT 10`, values: w },
    { id: 'address_activity_sample', text: `SELECT count(DISTINCT a.address)::text AS active_transparent_addresses,
      count(*)::text AS address_transaction_incidences,
      count(*) FILTER (WHERE a.block_time IS DISTINCT FROM b.timestamp)::text AS timestamp_mismatches
      FROM public.blocks b JOIN public.transactions t ON t.block_height=b.height AND t.block_hash=b.hash
      JOIN public.address_transactions a ON a.txid=t.txid AND a.block_height=t.block_height
      WHERE b.timestamp>=${w.from} AND b.timestamp<${Math.min(w.to,w.from+86400)}
      AND a.address ~ '^t[13]'`, values: { ...w, sample: 'first UTC day only; active is not new' } },
    { id: 'shielding_reference', text: `SELECT b.miner_address AS miner,count(DISTINCT t.txid)::text AS shielding_transactions,
      sum(f.amount_zat::numeric)::text AS shielding_zat,round(avg(t.fee::numeric),6)::text AS average_fee_zat,
      count(*) FILTER (WHERE t.fee IS NULL)::text AS missing_fees
      FROM public.blocks b JOIN public.transactions t ON t.block_height=b.height AND t.block_hash=b.hash
      JOIN public.shielded_flows f ON f.txid=t.txid AND f.block_height=t.block_height AND f.block_time=b.timestamp
      WHERE t.is_coinbase=false AND f.flow_type='shield' AND f.amount_zat>=0 AND b.timestamp>=${w.from} AND b.timestamp<${w.to}
      AND f.block_time>=${w.from} AND f.block_time<${w.to}
      GROUP BY b.miner_address ORDER BY count(DISTINCT t.txid) DESC,b.miner_address ASC NULLS LAST LIMIT 10`,
      values: { ...w, purpose: 'independent reference; requires reviewed unique (txid,flow_type) source key' } },
  ];
}

function storageSamples() {
  return catalogue.sources.map(source => ({
    id: `storage_${source.id}`, values: { system_sample_percent:0.01, maximum_rows:256, seed:20261003, estimate_only:true },
    text: `SELECT count(*)::text AS sampled_rows,round(avg(bytes),2)::text AS mean_selected_row_bytes,
      min(bytes)::text AS minimum_selected_row_bytes,max(bytes)::text AS maximum_selected_row_bytes
      FROM (SELECT pg_column_size(ROW(${Object.keys(source.fields).map(name=>`t."${name}"`).join(',')})) AS bytes
      FROM ${source.relation} t TABLESAMPLE SYSTEM (0.01) REPEATABLE (20261003) LIMIT 256) sample`,
  }));
}

function sampleSQL(probe) {
  // psql remembers ERROR/SQLSTATE before rollback. A timeout is a recorded failed
  // measurement, never zero activity; errors do not poison subsequent probes.
  return `SAVEPOINT probe;
SELECT extract(epoch FROM clock_timestamp()) AS probe_started \\gset
\\set ON_ERROR_STOP off
WITH result AS (${probe.text}) SELECT jsonb_build_object('kind','probe_result','id',${quote(probe.id)},'window',${quote(JSON.stringify(probe.values))}::jsonb,'rows',coalesce(jsonb_agg(result),'[]'::jsonb)) FROM result;
\\if :ERROR
\\set probe_state :SQLSTATE
\\set probe_failed true
ROLLBACK TO SAVEPOINT probe;
SELECT jsonb_build_object('kind','probe_status','id',${quote(probe.id)},'status','unavailable','sqlstate',:'probe_state','elapsed_ms',round((extract(epoch FROM clock_timestamp())-:probe_started)*1000,3));
\\else
SELECT jsonb_build_object('kind','probe_status','id',${quote(probe.id)},'status','passed','elapsed_ms',round((extract(epoch FROM clock_timestamp())-:probe_started)*1000,3));
\\endif
\\set ON_ERROR_STOP on
RELEASE SAVEPOINT probe;`;
}

function buildSQL(options = {}, now) {
  // Validate dates even for metadata-only execution so unknown options cannot
  // smuggle identifiers or SQL through any argument path.
  windowOptions(options, now);
  return `\\set ON_ERROR_STOP on
\\pset format unaligned
\\pset tuples_only on
\\pset pager off
\\set probe_failed false
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='3s';
SET LOCAL lock_timeout='200ms';
SET LOCAL idle_in_transaction_session_timeout='5s';
SET LOCAL work_mem='1MB';
SET LOCAL temp_file_limit='16MB';
SET LOCAL max_parallel_workers_per_gather=0;
SET LOCAL jit=off;
SET LOCAL search_path=pg_catalog;
SET LOCAL timezone='UTC';
${GUARD_SQL}
${metadataSQL()}
${options.benchmarks ? probes(options, now).map(sampleSQL).join('\n') : ''}
${options.samples ? storageSamples().map(sampleSQL).join('\n') : ''}
ROLLBACK;
\\if :probe_failed
DO $$ BEGIN RAISE EXCEPTION 'Audit contains unavailable probes; inspect recorded statuses'; END $$;
\\endif
`;
}

function parseArgs(args) {
  const options = {};
  for (let i=0;i<args.length;i++) {
    if (args[i]==='--benchmarks') options.benchmarks=true;
    else if (args[i]==='--samples') options.samples=true;
    else if (args[i]==='--start' || args[i]==='--end') {
      if (!args[i+1]) throw new Error('Missing date');
      options[args[i].slice(2)]=args[++i];
    } else throw new Error('Expected --start YYYY-MM-DD --end YYYY-MM-DD [--benchmarks] [--samples]');
  }
  return options;
}
if (require.main===module) {
  try { process.stdout.write(buildSQL(parseArgs(process.argv.slice(2)))); }
  catch { process.stderr.write('Invalid options: choose 1–31 completed UTC days with --start/--end and optional --benchmarks/--samples.\n'); process.exitCode=1; }
}
module.exports = { windowOptions, metadataSQL, probes, sampleSQL, buildSQL, parseArgs, storageSamples, GUARD_SQL };
