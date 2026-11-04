'use strict';
// LOCAL bounded synchronization prototype. Never imported by Ask/HTTP routes.
const { createHash } = require('node:crypto');
const MAX_BLOCKS = 200;
const MAX_ROWS = 5000;
const MAX_BYTES = 4 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = {
  blocks: ['height','hash','previous_hash','timestamp','transaction_count','size','total_fees','miner_address'],
  transactions: ['txid','block_height','block_hash','block_time','is_coinbase','fee','size','has_sapling','has_orchard','has_ironwood','has_sprout','value_balance_orchard','value_balance_ironwood'],
  flows: ['txid','block_height','block_time','flow_type','pool','amount_zat'],
};
Object.values(FIELDS).forEach(Object.freeze);
Object.freeze(FIELDS);
function fail(message) { throw new Error(`Core store: ${message}`); }
function keys(object, expected) {
  if (!object || typeof object !== 'object' || Array.isArray(object)
      || Object.keys(object).length !== expected.length || expected.some(k => !Object.hasOwn(object,k))) fail('unexpected or missing fields');
}
function integer(value, {nullable=false,signed=false,max=null}={}) {
  if (nullable && value===null) return;
  if (typeof value !== 'string' || !(signed ? /^(0|-?[1-9][0-9]{0,77})$/ : /^(0|[1-9][0-9]{0,77})$/).test(value)) fail('exact integer strings required');
  if (max !== null && BigInt(value)>BigInt(max)) fail('integer exceeds limit');
}
function height(value) { integer(value,{max:2147483647}); }
function hash(value) { if(typeof value!=='string' || !HASH.test(value)) fail('invalid hash'); }
function text(value) { if(value!==null && (typeof value!=='string' || value.length>256 || /[\u0000-\u001f]/.test(value))) fail('invalid text'); }
function boolean(value) { if(typeof value!=='boolean') fail('explicit boolean required'); }
function timestamp(value) { integer(value,{max:253402300799}); }
function digest(snapshot) {
  const source={mode:snapshot.source.mode,id:snapshot.source.id,revision:snapshot.source.revision};
  return createHash('sha256').update(JSON.stringify({...snapshot,source})).digest('hex');
}
function validateSnapshot(input, now=Date.now()) {
  keys(input,['version','network','source','range','blocks','transactions','flows']);
  if(input.version!==1 || input.network!=='mainnet') fail('unsupported contract/network');
  keys(input.source,['mode','id','revision','observed_at']);
  if(input.source.mode!=='fixture_snapshot' || typeof input.source.id!=='string' || !UUID.test(input.source.id)) fail('fixture authority required');
  integer(input.source.revision); if(BigInt(input.source.revision)<1n) fail('positive source revision required');
  const observed=Date.parse(input.source.observed_at);
  if(typeof input.source.observed_at!=='string' || !Number.isFinite(observed)
     || new Date(observed).toISOString()!==input.source.observed_at || observed>now+60000) fail('invalid source observation time');
  keys(input.range,['from','through']);height(input.range.from);height(input.range.through);
  const from=BigInt(input.range.from),through=BigInt(input.range.through);
  if(through<from || through-from+1n>BigInt(MAX_BLOCKS)) fail('bounded height range required');
  let rows=0;
  for(const kind of Object.keys(FIELDS)) {
    if(!Array.isArray(input[kind]) || input[kind].length>MAX_ROWS) fail('row limit');
    rows+=input[kind].length;
    for(const row of input[kind]) keys(row,FIELDS[kind]);
  }
  if(rows>MAX_ROWS || Buffer.byteLength(JSON.stringify(input))>MAX_BYTES) fail('payload limit');
  // Normalize property/row ordering before hashing so equivalent retries agree.
  const snapshot={version:1,network:'mainnet',source:{mode:'fixture_snapshot',id:input.source.id,revision:input.source.revision,observed_at:input.source.observed_at},range:{from:input.range.from,through:input.range.through}};
  for(const [kind,fields] of Object.entries(FIELDS)) snapshot[kind]=input[kind].map(row=>Object.fromEntries(fields.map(k=>[k,row[k]])));
  snapshot.blocks.sort((a,b)=>BigInt(a.height)<BigInt(b.height)?-1:BigInt(a.height)>BigInt(b.height)?1:0);
  snapshot.transactions.sort((a,b)=>a.txid.localeCompare(b.txid));
  snapshot.flows.sort((a,b)=>`${a.txid}:${a.flow_type}`.localeCompare(`${b.txid}:${b.flow_type}`));
  if(snapshot.blocks.length!==Number(through-from+1n)) fail('missing block');
  const hashes=new Set(),blocks=new Map(),transactions=new Map(),counts=new Map(),coinbases=new Map(),flows=new Set();
  for(const [i,b] of snapshot.blocks.entries()) {
    height(b.height);hash(b.hash);hash(b.previous_hash);timestamp(b.timestamp);
    integer(b.transaction_count,{max:MAX_ROWS});if(b.transaction_count==='0') fail('missing coinbase');
    integer(b.size,{nullable:true,max:Number.MAX_SAFE_INTEGER});integer(b.total_fees,{nullable:true});text(b.miner_address);
    if(BigInt(b.height)!==from+BigInt(i)) fail('noncontiguous blocks');
    if(hashes.has(b.hash) || b.previous_hash===b.hash) fail('repeated block hash');
    hashes.add(b.hash);
    if(i>0 && b.previous_hash!==snapshot.blocks[i-1].hash) fail('broken parent chain');
    blocks.set(b.height,b);
  }
  for(const tx of snapshot.transactions) {
    hash(tx.txid);height(tx.block_height);hash(tx.block_hash);timestamp(tx.block_time);
    for(const k of ['is_coinbase','has_sapling','has_orchard','has_ironwood','has_sprout']) boolean(tx[k]);
    integer(tx.fee,{nullable:true});integer(tx.size,{nullable:true,max:Number.MAX_SAFE_INTEGER});
    for(const k of ['value_balance_orchard','value_balance_ironwood']) integer(tx[k],{nullable:true,signed:true});
    const b=blocks.get(tx.block_height);
    if(!b || tx.block_hash!==b.hash || tx.block_time!==b.timestamp) fail('noncanonical transaction');
    if(transactions.has(tx.txid)) fail('duplicate transaction');
    transactions.set(tx.txid,tx);
    counts.set(tx.block_height,(counts.get(tx.block_height)||0)+1);
    coinbases.set(tx.block_height,(coinbases.get(tx.block_height)||0)+Number(tx.is_coinbase));
  }
  for(const b of snapshot.blocks) {
    if(counts.get(b.height)!==Number(b.transaction_count) || coinbases.get(b.height)!==1) fail('incomplete block transactions');
  }
  for(const flow of snapshot.flows) {
    hash(flow.txid);height(flow.block_height);timestamp(flow.block_time);
    if(!['shield','deshield'].includes(flow.flow_type)) fail('invalid flow direction');
    integer(flow.amount_zat);text(flow.pool);
    const tx=transactions.get(flow.txid),key=`${flow.txid}:${flow.flow_type}`;
    if(!tx || tx.block_height!==flow.block_height || tx.block_time!==flow.block_time) fail('noncanonical flow');
    if(flows.has(key)) fail('duplicate flow direction');flows.add(key);
  }
  return snapshot;
}
const SOURCE_GUARD = `SELECT current_database() ~ '^ask_source_fixture_[0-9]+$' AND inet_server_addr() IS NULL AS local`;
const STORE_GUARD = `SELECT current_database() ~ '^ask_store_fixture_[0-9]+$' AND inet_server_addr() IS NULL
 AND current_user='ask_store_writer' AS local`;
const SETTINGS = `SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms';
 SET LOCAL idle_in_transaction_session_timeout='5s'; SET LOCAL work_mem='1MB';
 SET LOCAL timezone='UTC'; SET LOCAL search_path=pg_catalog; SET LOCAL max_parallel_workers_per_gather=0;`;
async function readCoreSnapshot(pool,range) {
  keys(range,['from','through']);height(range.from);height(range.through);
  if(BigInt(range.through)<BigInt(range.from) || BigInt(range.through)-BigInt(range.from)+1n>BigInt(MAX_BLOCKS)) fail('bounded height range required');
  const client=await pool.connect();
  let discard=false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(SETTINGS);
    if(!(await client.query(SOURCE_GUARD)).rows[0].local) fail('disposable local source required');
    const control=(await client.query(`SELECT id,revision::text,network,transaction_timestamp() AS observed_at FROM public.fixture_control WHERE singleton=true`)).rows;
    if(control.length!==1 || control[0].network!=='mainnet') fail('fixture source identity required');
    const parameters=[range.from,range.through,MAX_ROWS+1];
    const blocks=(await client.query(`SELECT b.height::text,b.hash,b.previous_block_hash AS previous_hash,b.timestamp::text,
      b.transaction_count::text,b.size::text,b.total_fees::text,b.miner_address FROM public.blocks b
      WHERE b.height BETWEEN $1::bigint AND $2::bigint ORDER BY b.height LIMIT $3`,parameters)).rows;
    const transactions=(await client.query(`SELECT t.txid,t.block_height::text,t.block_hash,t.block_time::text,
      t.is_coinbase,t.fee::text,t.size::text,t.has_sapling,t.has_orchard,t.has_ironwood,t.has_sprout,
      t.value_balance_orchard::text,t.value_balance_ironwood::text
      FROM public.transactions t JOIN public.blocks b ON b.height=t.block_height AND b.hash=t.block_hash
      WHERE b.height BETWEEN $1::bigint AND $2::bigint ORDER BY t.txid LIMIT $3`,parameters)).rows;
    const flows=(await client.query(`SELECT f.txid,f.block_height::text,f.block_time::text,f.flow_type,f.pool,f.amount_zat::text
      FROM public.shielded_flows f JOIN public.transactions t ON t.txid=f.txid AND t.block_height=f.block_height
      JOIN public.blocks b ON b.height=t.block_height AND b.hash=t.block_hash
      WHERE b.height BETWEEN $1::bigint AND $2::bigint ORDER BY f.txid,f.flow_type LIMIT $3`,parameters)).rows;
    const snapshot=validateSnapshot({version:1,network:'mainnet',source:{mode:'fixture_snapshot',id:control[0].id,revision:control[0].revision,observed_at:control[0].observed_at.toISOString()},range,blocks,transactions,flows});
    await client.query('COMMIT');
    return snapshot;
  } catch(error) {
    try {await client.query('ROLLBACK');} catch {discard=true;}
    throw error;
  } finally {client.release(discard);}
}
async function insertRows(client,kind,rows) {
  if(!rows.length) return;
  const fields=FIELDS[kind];
  // Fixed relation/field identifiers only; all contents are bound parameters.
  for(let i=0;i<rows.length;i+=100) {
    const chunk=rows.slice(i,i+100),values=[];
    const tuples=chunk.map(row=>`(${fields.map(k=>{values.push(row[k]);return `$${values.length}`;}).join(',')})`).join(',');
    await client.query(`INSERT INTO analytics_public.${kind} (${fields.join(',')}) VALUES ${tuples}`,values);
  }
}
async function applyCoreSnapshot(pool,input,{expectedGeneration,now=Date.now()}={}) {
  integer(expectedGeneration,{max:9223372036854775806n});
  const snapshot=validateSnapshot(input,now),fingerprint=digest(snapshot);
  const client=await pool.connect();
  let discard=false;
  try {
    await client.query('BEGIN');await client.query(SETTINGS);
    if(!(await client.query(STORE_GUARD)).rows[0].local) fail('disposable local writer required');
    const identity=(await client.query('SELECT schema_version,network,store_kind FROM analytics_meta.identity WHERE singleton=true')).rows[0];
    if(!identity || identity.schema_version!==1 || identity.network!=='mainnet' || identity.store_kind!=='local_core_fixture') fail('store identity mismatch');
    const state=(await client.query('SELECT * FROM analytics_meta.sync_state WHERE singleton=true FOR UPDATE')).rows[0];
    if(!state) fail('missing sync state');
    if(state.digest===fingerprint) {
      await client.query('UPDATE analytics_meta.sync_state SET source_observed_at=GREATEST(source_observed_at,$1::timestamptz) WHERE singleton=true',[snapshot.source.observed_at]);
      await client.query('COMMIT');return {status:'duplicate',generation:state.generation};
    }
    if(state.generation!==expectedGeneration) fail('checkpoint conflict; retry from current generation');
    if(state.generation!=='0') {
      if(state.source_id!==snapshot.source.id || state.covered_from!==snapshot.range.from) fail('source/range identity mismatch');
      if(BigInt(snapshot.source.revision)<=BigInt(state.source_revision)) fail('stale or conflicting source revision');
      if(Date.parse(snapshot.source.observed_at)<state.source_observed_at.getTime()) fail('regressing source observation');
    }
    // Replace the WHOLE bounded coverage window, including removed/reorged
    // records. Old-tip removals and public coverage commit in this transaction.
    await client.query('DELETE FROM analytics_public.blocks');
    for(const kind of Object.keys(FIELDS)) await insertRows(client,kind,snapshot[kind]);
    const generation=(BigInt(state.generation)+1n).toString();
    await client.query(`UPDATE analytics_meta.sync_state SET generation=$1,source_id=$2,source_revision=$3,
      covered_from=$4,covered_through=$5,tip_hash=$6,source_observed_at=$7,published_at=clock_timestamp(),digest=$8
      WHERE singleton=true`,[generation,snapshot.source.id,snapshot.source.revision,snapshot.range.from,snapshot.range.through,
      snapshot.blocks.at(-1).hash,snapshot.source.observed_at,fingerprint]);
    await client.query('COMMIT');
    return {status:'published',generation,covered_from:snapshot.range.from,covered_through:snapshot.range.through};
  } catch(error) {
    try {await client.query('ROLLBACK');} catch {discard=true;}
    throw error;
  } finally {client.release(discard);}
}
module.exports={MAX_BLOCKS,MAX_ROWS,MAX_BYTES,FIELDS,validateSnapshot,readCoreSnapshot,applyCoreSnapshot};
