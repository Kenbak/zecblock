'use strict';
// Operator-only SQL generator: no connections, credentials or activation.
const catalogue=require('../v1/lib/ask-public-catalogue');
const TYPES={
 blocks:{height:'bigint',hash:'text',previous_block_hash:'text',timestamp:'bigint',transaction_count:'integer',size:'integer',total_fees:'bigint',miner_address:'text'},
 transactions:{txid:'text',block_height:'bigint',block_hash:'text',block_time:'bigint',is_coinbase:'boolean',fee:'bigint',size:'integer',has_sapling:'boolean',has_orchard:'boolean',has_ironwood:'boolean',has_sprout:'boolean',value_balance_orchard:'bigint',value_balance_ironwood:'bigint'},
 shielded_flows:{id:'integer',txid:'text',block_height:'integer',block_time:'integer',flow_type:'text',pool:'text',amount_zat:'bigint'},
};
const TABLES=Object.freeze([
 {name:'blocks',key:['height'],columns:['height','hash','previous_block_hash','timestamp','transaction_count','size','total_fees','miner_address']},
 {name:'transactions',key:['txid'],columns:Object.keys(catalogue.sources.find(s=>s.id==='transactions').fields)},
 // Keep the existing replica identity; expose only txid/direction in reader views.
 {name:'shielded_flows',key:['id'],columns:['id','txid','block_height','block_time','flow_type','pool','amount_zat']},
].map(t=>Object.freeze({...t,key:Object.freeze(t.key),columns:Object.freeze(t.columns),types:Object.freeze(TYPES[t.name])})));
const quote=value=>`'${value.replaceAll("'","''")}'`;
function publicationDDL() {
 return `CREATE PUBLICATION ask_public_core_v1 FOR TABLE\n${TABLES.map(t=>` public.${t.name} (${t.columns.join(',')})`).join(',\n')}\n WITH (publish='insert, update, delete, truncate');`;
}
function buildPreflightSQL() {
 const candidates=TABLES.map(t=>`(${quote(t.name)},ARRAY[${t.columns.map(quote).join(',')}]::text[])`).join(',');
 return `\\set ON_ERROR_STOP on
\\pset format unaligned
\\pset tuples_only on
BEGIN READ ONLY;
SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='200ms'; SET LOCAL timezone='UTC'; SET LOCAL search_path=pg_catalog;
SELECT jsonb_build_object('kind','logical_sync_preflight','observed_at',clock_timestamp(),
 'database',current_database(),'version',current_setting('server_version'),'standby',pg_is_in_recovery(),
 'settings',(SELECT jsonb_object_agg(name,jsonb_build_object('value',setting,'unit',unit,'pending_restart',pending_restart)) FROM pg_settings
  WHERE name IN ('wal_level','max_replication_slots','max_wal_senders','max_slot_wal_keep_size','hot_standby_feedback','max_logical_replication_workers','max_worker_processes')),
 'slots',(SELECT jsonb_build_object('total',count(*),'logical',count(*) FILTER(WHERE slot_type='logical'),'inactive',count(*) FILTER(WHERE NOT active)) FROM pg_replication_slots),
 'connected_wal_senders',(SELECT count(*) FROM pg_stat_replication),
 'publications',(SELECT count(*) FROM pg_publication),
 'core_keys',(SELECT jsonb_agg(jsonb_build_object('relation',wanted.name,'present',c.oid IS NOT NULL,
  'replica_identity',c.relreplident,'identity_valid',identity.indisvalid,
  'identity_columns',(SELECT jsonb_agg(a.attname ORDER BY u.ordinality) FROM unnest(identity.indkey) WITH ORDINALITY u(attnum,ordinality)
   JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=u.attnum),
  'missing_columns',(SELECT coalesce(jsonb_agg(field),'[]'::jsonb) FROM unnest(wanted.fields) field WHERE NOT EXISTS
   (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname=field AND NOT a.attisdropped)),
  'columns',(SELECT jsonb_object_agg(a.attname,format_type(a.atttypid,a.atttypmod)) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname=ANY(wanted.fields) AND NOT a.attisdropped)))
 FROM (VALUES ${candidates}) wanted(name,fields)
 LEFT JOIN pg_namespace n ON n.nspname='public' LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=wanted.name AND c.relkind='r'
 LEFT JOIN pg_index identity ON identity.indrelid=c.oid AND ((c.relreplident='d' AND identity.indisprimary) OR (c.relreplident='i' AND identity.indisreplident))));
ROLLBACK;
`;
}
function assessPreflight(report) {
 const blockers=[];
 if(report?.kind!=='logical_sync_preflight') throw new Error('Invalid logical preflight report');
 if(report.database!=='zcash_explorer_mainnet' || report.standby!==false) blockers.push('verified_mainnet_primary_required');
 const major=Number.parseInt(report.version,10);
 if(major!==16) blockers.push('reviewed_pg16_required');
 const settings=report.settings||{};
 if(settings.wal_level?.value!=='logical') blockers.push('logical_wal_requires_planned_restart');
 if(!Number.isFinite(Number(settings.max_slot_wal_keep_size?.value)) || Number(settings.max_slot_wal_keep_size.value)<=0) blockers.push('finite_positive_slot_wal_budget_required');
 const slots=Number(settings.max_replication_slots?.value)-Number(report.slots?.total);
 if(!Number.isFinite(slots) || slots<4) blockers.push('snapshot_slot_headroom_required');
 const senders=Number(settings.max_wal_senders?.value)-Number(report.connected_wal_senders);
 if(!Number.isFinite(senders) || senders<4) blockers.push('snapshot_sender_headroom_required');
 if(Object.values(settings).some(setting=>setting.pending_restart===true)) blockers.push('pending_settings_require_review');
 for(const table of TABLES) {
  const actual=report.core_keys?.find(t=>t.relation===table.name);
  if(!actual || actual.present!==true || actual.identity_valid!==true || !['d','i'].includes(actual.replica_identity)
    || !Array.isArray(actual.identity_columns) || actual.identity_columns.length!==table.key.length
    || actual.identity_columns.some((k,i)=>k!==table.key[i]) || !Array.isArray(actual.missing_columns) || actual.missing_columns.length)
   blockers.push(`reviewed_identity_and_columns_required:${table.name}`);
  if(!actual || table.columns.some(column=>actual.columns?.[column]!==table.types[column])) blockers.push(`reviewed_types_required:${table.name}`);
 }
 return {configuration_ready:blockers.length===0,activation_authorized:false,blockers,
  next:'PG16 fixture proof, explicit host/WAL/failover budget review and operator rollout approval still required'};
}
function buildPublicationPlan() {
 return `-- REVIEW ONLY: creating this publication is a production change.
-- Source role, TLS/private transport, subscriber schema, WAL retention alarms,
-- source capacity, initial-sync readiness and failover runbook are separate gates.
BEGIN;
SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='500ms';
DO $$ BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery() OR current_setting('server_version_num')::int NOT BETWEEN 160000 AND 169999
 OR current_setting('wal_level')<>'logical' OR NOT COALESCE((SELECT setting::numeric>0 FROM pg_settings WHERE name='max_slot_wal_keep_size'),false)
 THEN RAISE EXCEPTION 'Reviewed PG16 mainnet primary and finite positive WAL budget required'; END IF;
END $$;
${publicationDDL()}
COMMIT;
-- No password, subscription, replication slot or primary configuration change.
`;
}
if(require.main===module) {
 const args=process.argv.slice(2);
 if(args.length===0) process.stdout.write(buildPreflightSQL());
 else if(args.length===1 && args[0]==='--publication-plan') process.stdout.write(buildPublicationPlan());
 else {process.stderr.write('Usage: profile-ask-logical-sync.js [--publication-plan]\n');process.exitCode=2;}
}
module.exports={TABLES,publicationDDL,buildPreflightSQL,assessPreflight,buildPublicationPlan};
