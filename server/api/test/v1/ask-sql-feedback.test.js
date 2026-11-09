'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events');
const {compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const {policyFeedback,databaseFeedback,sqlFeedbackSchema}=require('../../../../lib/ask/sql-feedback');
const {researchCostBudget,checkResearchCost}=require('../../v1/lib/ask-analytics');
const {askError,classifyFailure,failureExtra}=require('../../v1/lib/ask-errors');
const {createWorker}=require('../../ask-analytics-worker');
const {createAnalyticsClient}=require('../../v1/lib/ask-analytics-client');
const {jobStatusSchema}=require('../../../../lib/ask/research-job-contract');
const {sqlExamples,examplesFor}=require('../../../../lib/ask/sql-examples');

test('readable SQL display recompiles to the identical canonical query',async()=>{
  const {displaySQL}=require('../../../../lib/ask/sql-display');
  const cases=[...sqlExamples.map(example=>example.sql),
    'SELECT b.height, t.fees FROM blocks b JOIN transactions AS t ON t.height=b.height LIMIT 5',
    'WITH blocks_query AS (SELECT 1 AS x) SELECT * FROM blocks_query, blocks',
    'SELECT pg_catalog.height FROM blocks AS pg_catalog',
    'SELECT pg_catalog.count(*) FROM analytics_public.blocks_query',
    'SELECT count(*) FROM blocks AS "blocks"'];
  for(const sql of cases){
    const canonical=await compileResearchSQL({version:3,sql},{extended:true,preview:true});
    const shown=displaySQL(canonical.request.sql);
    assert.doesNotMatch(shown,/analytics_public|pg_catalog\.[a-z_]+\(/,sql);
    assert.equal((await compileResearchSQL({version:3,sql:shown},{extended:true,preview:true})).fingerprint,canonical.fingerprint,sql);
  }
});

test('starter queries pass the research policy for their catalogue',async()=>{
  assert.ok(examplesFor(false).length>=4);assert.ok(examplesFor(false).every(example=>!example.extended));
  assert.equal(new Set(sqlExamples.map(example=>example.id)).size,sqlExamples.length);
  // Examples for unpublished datasets are hidden until the dataset is published.
  assert.ok(examplesFor(true).some(example=>example.id==='supply-now')&&examplesFor(true).some(example=>example.id==='issuance-split'));
  assert.ok(!examplesFor(false).some(example=>example.id==='supply-now'));
  for(const example of sqlExamples){
    const compiled=await compileResearchSQL({version:3,sql:example.sql,limit:100},{extended:example.extended,preview:Boolean(example.datasets)});
    assert.ok(compiled.datasets.length>=1,example.id);
    if(example.datasets)assert.deepEqual(compiled.datasets,example.datasets,example.id);
    if(!example.extended)assert.ok(compiled.datasets.every(id=>['blocks','transactions','flows'].includes(id)),example.id);
  }
});

const env={ASK_RESEARCH_ENABLED:'true',ASK_ANALYTICS_STORE:'logical_public_core',ASK_ANALYTICS_ENABLED:'true',ASK_RESEARCH_EXTENDED:'true',ASK_ANALYTICS_SERVICE_KEY:'fixture-private-worker-key-at-least-thirty-two-characters'};
const rejected=async sql=>{try{await compileResearchSQL({version:3,sql},{extended:true});}catch(error){return policyFeedback(error,sql);}assert.fail('SQL was accepted');};

test('policy and syntax feedback name the rejected construct at its line and column',async()=>{
  assert.deepEqual(await rejected('SELECT height\nFROM blocks\nWHERE pg_sleep(5) IS NULL'),{stage:'policy',message:'Function pg_sleep() is not allowed',hint:'See the supported functions in the data catalogue.',line:3,column:7});
  assert.deepEqual(await rejected('SELECT *\n  FROM pg_authid'),{stage:'policy',message:'Dataset pg_authid is not admitted',hint:'Use a table from the data catalogue.',line:2,column:8});
  assert.deepEqual(await rejected('SELECT x::regclass FROM blocks'),{stage:'policy',message:'Type regclass is not allowed',hint:'Cast to numeric, bigint, integer, text, boolean, date, timestamp, timestamptz or interval.',line:1,column:11});
  assert.deepEqual(await rejected('SELEC 1'),{stage:'syntax',message:'Syntax error at or near "SELEC"',line:1,column:1});
  assert.equal((await rejected('DELETE FROM blocks')).message,'One read-only SELECT is required');
  // Positions follow the trimmed SQL the schema validates.
  assert.deepEqual(await rejected('\n\n  SELECT lower(x) FROM blocks WHERE dblink(1)'),{stage:'policy',message:'Function dblink() is not allowed',hint:'See the supported functions in the data catalogue.',line:1,column:35});
  // Hostile names are reduced to identifier characters before display.
  assert.match((await rejected('SELECT "evil<script>"() FROM blocks')).message,/^Function evilscript\(\) is not allowed$/);
});

test('only allowlisted visitor-caused PostgreSQL errors are forwarded, without server view names',()=>{
  const missing=databaseFeedback({code:'42703',message:'column "fee" does not exist',hint:'Perhaps you meant to reference the column "blocks.fees".'});
  assert.deepEqual(missing,{stage:'database',code:'42703',message:'column "fee" does not exist',hint:'Perhaps you meant to reference the column "blocks.fees".'});
  assert.equal(databaseFeedback({code:'42883',message:'function pg_catalog.left(bigint) does not exist'}).message,'function left(bigint) does not exist');
  assert.equal(databaseFeedback({code:'42P01',message:'relation "analytics_public.blocks_query" does not exist'}).message,'relation "blocks" does not exist');
  assert.equal(databaseFeedback({code:'42702',message:'column reference "my_query" is ambiguous'}).message,'column reference "my_query" is ambiguous');
  assert.equal(databaseFeedback({code:'22012',message:'division by zero\u0007\n'}).message,'division by zero');
  for(const code of ['42501','08006','XX000','55P03','53300','57P01',undefined])assert.equal(databaseFeedback({code,message:'permission denied for table fixture_private.blocks'}),null);
  assert.equal(databaseFeedback({code:'42703',message:''}),null);
  assert.ok(databaseFeedback({code:'42703',message:'x'.repeat(2000)}).message.length<=300);
});

test('planner cost gate rejects estimates above budget before execution and validates configuration',async()=>{
  const compiled=await compileResearchSQL({version:3,sql:'SELECT count(*) FROM blocks a, blocks b'},{extended:true});
  const statements=[];
  const client=cost=>({query:async statement=>{statements.push(statement);return{rows:[{'QUERY PLAN':[{Plan:{'Total Cost':cost}}]}]};}});
  assert.equal(await checkResearchCost(client(1200),compiled,5000),1200);
  assert.equal(statements[0].text,'EXPLAIN (FORMAT JSON) '+compiled.text);assert.deepEqual(statements[0].values,compiled.values);
  await assert.rejects(checkResearchCost(client(9e12),compiled,5e7),error=>{
    assert.equal(error.askKind,'resource');
    assert.equal(error.sqlFeedback.stage,'cost');assert.match(error.sqlFeedback.message,/9,000,000,000,000 cost units, above the 50,000,000/);
    const failure=classifyFailure(error);assert.equal(failure.status,422);assert.deepEqual(failureExtra(failure).sql,error.sqlFeedback);
    return true;
  });
  await assert.rejects(checkResearchCost(client('NaN'),compiled,5e7),error=>error.askKind==='source');
  assert.equal(researchCostBudget({},false),50000000);assert.equal(researchCostBudget({},true),250000000);
  assert.equal(researchCostBudget({ASK_RESEARCH_MAX_COST:'2000000'},false),2000000);
  for(const value of ['0','-1','abc','999'])assert.throws(()=>researchCostBudget({ASK_RESEARCH_MAX_COST:value},false));
});

test('worker and API client carry checked SQL feedback but never raw database errors',async t=>{
  let failure;
  const app=createWorker(env,{redis:{},analytics:{execute:async()=>{throw failure;}},memoryPressure:{assertAvailable:async()=>{}}});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const client=createAnalyticsClient({...env,ASK_ANALYTICS_SERVICE_URL:`http://127.0.0.1:${server.address().port}/`},fetch);
  const query={version:3,sql:'SELECT fee FROM blocks',limit:10};
  failure=Object.assign(askError('query'),{code:'42703',sqlFeedback:databaseFeedback({code:'42703',message:'column "fee" does not exist'})});
  await assert.rejects(client.execute(query),error=>{
    const classified=classifyFailure(error);
    assert.equal(classified.status,400);assert.deepEqual(failureExtra(classified),{code:'ask-query',sql:{stage:'database',code:'42703',message:'column "fee" does not exist'}});
    return true;
  });
  // A forged/invalid feedback object and an unlisted code are reduced to the fixed category.
  failure=Object.assign(askError('query'),{code:'42703',sqlFeedback:{stage:'database',message:'<b>x</b>',extra:'secret'}});
  await assert.rejects(client.execute(query),error=>{assert.equal(error.sqlFeedback,undefined);assert.equal(classifyFailure(error).sql,undefined);return true;});
  failure=Object.assign(new Error('permission denied for table fixture_private.paper_portfolio'),{code:'42501'});
  await assert.rejects(client.execute(query),error=>{assert.equal(error.askKind,'source');assert.equal(error.sqlFeedback,undefined);return true;});
  failure=Object.assign(askError('resource'),{sqlFeedback:{stage:'cost',message:'Too expensive',hint:'Filter first.'}});
  await assert.rejects(client.execute(query),error=>{const c=classifyFailure(error);assert.equal(c.status,422);assert.equal(c.sql.stage,'cost');return true;});
});

test('job status accepts SQL feedback only on failed query/resource jobs',()=>{
  const base={id:'00000000-0000-4000-8000-000000000000',state:'failed',createdAt:'2026-10-29T00:00:00.000Z',startedAt:null,finishedAt:'2026-10-29T00:00:01.000Z',queuePosition:0,maxRunSeconds:30,error:'query',result:null};
  const sql=sqlFeedbackSchema.parse({stage:'database',code:'42703',message:'column "fee" does not exist'});
  assert.ok(jobStatusSchema.safeParse({...base,sql}).success);
  assert.ok(jobStatusSchema.safeParse({...base}).success);
  assert.equal(jobStatusSchema.safeParse({...base,error:'source',sql}).success,false);
  assert.equal(jobStatusSchema.safeParse({...base,sql:{...sql,raw:'x'}}).success,false);
});

// Opt-in real PostgreSQL check: EXPLAIN runs with the bound limit parameter
// inside the read-only transaction, estimates explode for cross products, and
// real error codes/messages match the allowlist.
test('real PostgreSQL cost estimates and error messages',{skip:process.env.ASK_SQL_FEEDBACK_POSTGRES!=='1'},async t=>{
  const {Client}=require('pg');
  const db='ask_sql_feedback_'+process.pid;
  const admin=new Client({host:'/tmp',database:'postgres'});await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const client=new Client({host:'/tmp',database:db});
  // One ordered cleanup: the fixture connection must close before the drop.
  t.after(async()=>{try{await client.end();}catch{/* already closed */}try{await admin.query(`DROP DATABASE IF EXISTS ${db}`);}finally{await admin.end();}});
  await client.connect();
  // Column shapes follow the published catalogue/eval fixture.
  await client.query(`CREATE SCHEMA analytics_public;
    CREATE TABLE analytics_public.transactions_query(txid text PRIMARY KEY,height integer,timestamp bigint,miner text,shielded boolean,orchard boolean,ironwood boolean,sapling boolean,bytes bigint,fees bigint);
    CREATE TABLE analytics_public.flows_query(txid text,height integer,timestamp bigint,direction text,pool text,amount bigint);
    CREATE TABLE analytics_public.daily_query(date date PRIMARY KEY,transactions numeric,shielded_transactions bigint,transparent_transactions bigint,orchard bigint,ironwood bigint,sapling bigint,sprout bigint);
    CREATE TABLE analytics_public.swaps_query(timestamp timestamptz,direction text,chain text,token text,usd numeric);
    CREATE TABLE analytics_public.activity_daily_query(date date PRIMARY KEY,blocks bigint,transactions bigint,shielded_transactions bigint,transparent_transactions bigint,unclassified_transactions bigint,bytes numeric,fees numeric,missing_fees bigint,missing_bytes bigint);
    CREATE TABLE analytics_public.flow_daily_query(date date,pool text,direction text,records bigint,amount numeric,missing_amounts bigint,PRIMARY KEY(date,pool,direction));
    CREATE TABLE analytics_public.blocks_query(height integer PRIMARY KEY,hash text,timestamp bigint,miner text,transactions integer,bytes bigint,fees bigint);
    CREATE TABLE analytics_public.supply_daily_query(date date PRIMARY KEY,height bigint,hash text,timestamp bigint,chain_supply bigint,lockbox bigint,circulating_supply bigint,net_change bigint);
    CREATE TABLE analytics_public.issuance_query(height bigint PRIMARY KEY,hash text,timestamp bigint,subsidy bigint,miner_subsidy bigint,founders bigint,funding_streams bigint,lockbox bigint,lockbox_disbursed bigint,fees bigint);
    INSERT INTO analytics_public.blocks_query SELECT i,md5(i::text),1700000000+i*75,'t1fixture',2,1000,i FROM generate_series(1,200000) i;
    ANALYZE analytics_public.blocks_query;`);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL jit=off");
  const cost=async sql=>{const compiled=await compileResearchSQL({version:3,sql,limit:100},{extended:true,preview:true});try{return await checkResearchCost(client,compiled,5e7);}catch(error){return error;}};
  const small=await cost('SELECT height,fees FROM blocks ORDER BY height DESC LIMIT 10');
  assert.equal(typeof small,'number');assert.ok(small<1000,`indexed latest blocks estimate ${small}`);
  const scan=await cost("SELECT date_trunc('month',to_timestamp(timestamp)) AS month,sum(fees) FROM blocks GROUP BY 1");
  assert.equal(typeof scan,'number');assert.ok(scan<5e7,`full aggregate estimate ${scan}`);
  const cross=await cost('SELECT count(*) FROM blocks a, blocks b, blocks c');
  assert.equal(cross.askKind,'resource');assert.equal(cross.sqlFeedback.stage,'cost');
  for(const [sql,code,message] of [
    ['SELECT fee FROM blocks','42703',/column "fee" does not exist/],
    ['SELECT height/0 FROM blocks','22012',/division by zero/],
    ["SELECT 'abc'::integer FROM blocks",'22P02',/invalid input syntax for type integer/],
    ['SELECT height FROM blocks a JOIN blocks b ON true','42702',/column reference "height" is ambiguous/],
  ]){
    const compiled=await compileResearchSQL({version:3,sql,limit:10});
    await client.query('SAVEPOINT probe');
    const error=await client.query({text:compiled.text,values:compiled.values}).then(()=>null,e=>e);
    await client.query('ROLLBACK TO SAVEPOINT probe');
    assert.equal(error?.code,code,sql);
    const feedback=databaseFeedback(error);assert.match(feedback.message,message);assert.doesNotMatch(JSON.stringify(feedback),/analytics_public|_query\b|pg_catalog/);
  }
  // Every starter query plans (types, columns, functions) within budget.
  for(const example of sqlExamples){
    const estimate=await cost(example.sql);
    assert.equal(typeof estimate,'number',`${example.id}: ${estimate?.sqlFeedback?.message||estimate?.message}`);
  }
  await client.query('ROLLBACK');
});
