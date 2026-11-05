'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {draftDiagnostics,compileResearchDraft}=require('../../v1/lib/ask-research-plan-quality');
const {compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const base="WITH observed_days AS(SELECT date,shielded_transactions FROM activity_daily WHERE date>=DATE '2026-08-02' AND date<DATE '2026-10-01'), rolling_counts AS(SELECT date,count(*) OVER(ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS prior_days FROM observed_days FILTER_HERE) SELECT * FROM rolling_counts WHERE prior_days=30";
const broken=base.replace('FILTER_HERE',"WHERE date>=DATE '2026-09-01' AND date<DATE '2026-10-01'");const fixed=base.replace('FILTER_HERE','');
test('a required full baseline cannot fit after same-level output filtering',async()=>{
 assert.match((await draftDiagnostics(broken))[0],/lookback dates/);assert.deepEqual(await draftDiagnostics(fixed),[]);
 assert.deepEqual(await draftDiagnostics(broken.replace('WHERE prior_days=30','')),[],'partial windows are valid when a full count is not required');
 assert.ok(!(await draftDiagnostics(broken.replace('activity_daily','transactions'))).some(issue=>/lookback dates/.test(issue)),'unknown one-row-per-date lineage is not guessed');
});
test('published direction checks resolve direct dataset aliases without inspecting unrelated text',async()=>{
 for(const sql of ["SELECT * FROM swaps WHERE direction='out'","SELECT * FROM swaps s WHERE s.direction='in'","SELECT * FROM flow_daily WHERE direction='outflow'"])assert.match((await draftDiagnostics(sql))[0],/published direction/);
 for(const sql of ["SELECT * FROM swaps WHERE direction='outflow'","SELECT * FROM flows WHERE direction='deshield'","SELECT 'out' AS note FROM swaps","SELECT * FROM blocks WHERE miner='out'"])assert.deepEqual(await draftDiagnostics(sql),[]);
 await compileResearchSQL({version:3,sql:"SELECT * FROM swaps WHERE direction='out'",limit:100},{extended:true});
});
test('one model repair precedes execution and retains every security check',async()=>{
 let calls=0;const query=await compileResearchDraft(broken,{question:'Thirty preceding days'},async(input,task)=>{calls++;assert.equal(task.name,'research_sql');assert.equal(input.sql,broken);return {sql:fixed};},{extended:true});
 assert.equal(calls,1);assert.match(query.sql,/activity_daily_query/);
 calls=0;await assert.rejects(compileResearchDraft("SELECT * FROM swaps WHERE direction='out'",{question:'Outflow'},async()=>{calls++;return {sql:"SELECT * FROM swaps WHERE direction='out'"};},{extended:true}),e=>e.askKind==='answer');assert.equal(calls,1);
 await assert.rejects(compileResearchDraft("SELECT * FROM swaps WHERE direction='out'",{},async()=>({sql:'DELETE FROM swaps'}),{extended:true}));
 await assert.rejects(compileResearchDraft('DELETE FROM swaps',{},async()=>assert.fail('Unsafe SQL never gets a repair call'),{extended:true}));
});
test('height-derived UTC clocks get one repair while actual clocks and unresolved aliases remain valid',async()=>{
 const failedSQL="WITH \nmonthly_activity AS (SELECT\n  pg_catalog.date_trunc('month', pg_catalog.to_timestamp(height * 60)) AS month,\n  pg_catalog.count(CASE \n    WHEN shielded THEN 1 \n  END) AS shielded_transactions,\n  pg_catalog.count(CASE \n    WHEN NOT (shielded) THEN 1 \n  END) AS transparent_transactions\nFROM analytics_public.transactions_query AS transactions\nWHERE\n  height IN (SELECT height\nFROM analytics_public.blocks_query AS blocks\nWHERE\n  \"timestamp\" >= EXTRACT(EPOCH FROM '2025-01-01'::date)\n  AND \"timestamp\" < EXTRACT(EPOCH FROM '2026-01-01'::date))\nGROUP BY\n  month),\n  shielded_shares AS (SELECT\n    month,\n    shielded_transactions,\n    transparent_transactions,\n    (shielded_transactions * 100.0) / (NULLIF (shielded_transactions + transparent_transactions, 0)) AS shielded_share\n  FROM monthly_activity),\n  rolling_avg AS (SELECT\n    month,\n    shielded_transactions,\n    shielded_share,\n    pg_catalog.avg(shielded_transactions) OVER (\n      ORDER BY month\n      ROWS BETWEEN 2 PRECEDING AND CURRENT ROW\n    ) AS rolling_avg_shielded\n  FROM shielded_shares)\nSELECT *\nFROM rolling_avg\nORDER BY\n  month";
 const question='Use SQL research. Compare monthly shielded and transparent transaction counts during 2025, show the shielded share and a three-month rolling average of shielded transactions. Explain the biggest change.';
 const repairedSQL="WITH monthly_activity AS(SELECT date_trunc('month',date::timestamp)::date AS month,sum(shielded_transactions) AS shielded_transactions,sum(transparent_transactions) AS transparent_transactions FROM activity_daily WHERE date>=DATE '2025-01-01' AND date<DATE '2026-01-01' GROUP BY 1) SELECT month,shielded_transactions,transparent_transactions,100*shielded_transactions::numeric/nullif(shielded_transactions+transparent_transactions,0) AS shielded_share,avg(shielded_transactions) OVER(ORDER BY month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS rolling_avg_shielded FROM monthly_activity ORDER BY month";
 assert.match((await draftDiagnostics(failedSQL))[0],/Block height is not Unix time/);
 // This is a draft-quality signal, not a change to direct SQL/security policy.
 await compileResearchSQL({version:3,sql:failedSQL,limit:100},{extended:true});
 let calls=0;
 const query=await compileResearchDraft(failedSQL,{question},async(input)=>{calls++;assert.equal(input.question,question);assert.equal(input.sql,failedSQL);assert.match(input.diagnostics[0],/height.*Unix time/);return {sql:repairedSQL};},{extended:true});
 assert.equal(calls,1);assert.match(query.sql,/activity_daily_query/);assert.match(query.sql,/2 PRECEDING/);assert.match(query.sql,/transparent_transactions/);
 await assert.rejects(compileResearchDraft(failedSQL,{question},async()=>({sql:failedSQL}),{extended:true}),error=>error.askKind==='answer');
 for(const sql of ['SELECT to_timestamp(height*60) FROM transactions',"SELECT date_trunc('month',to_timestamp(b.height::numeric*75)) FROM blocks b",'SELECT to_timestamp(60*f.height) FROM flows f'])assert.match((await draftDiagnostics(sql))[0],/Block height is not Unix time/);
 for(const sql of [repairedSQL,"SELECT date_trunc('month',to_timestamp(t.timestamp)),count(*) FILTER(WHERE t.shielded) FROM transactions t WHERE t.timestamp>=1735689600 AND t.timestamp<1767225600 GROUP BY 1","SELECT b.height,(SELECT max(to_timestamp(t.timestamp)) FROM transactions t WHERE t.height=b.height) AS latest FROM blocks b","WITH custom_clock AS(SELECT timestamp AS height FROM transactions) SELECT to_timestamp(height*1) FROM custom_clock","SELECT to_timestamp(c.height) FROM (SELECT timestamp AS height FROM transactions) c","SELECT height*60 AS estimated_elapsed FROM transactions","SELECT to_timestamp(timestamp+height*0) FROM transactions"]){assert.deepEqual(await draftDiagnostics(sql),[],sql);}
 const {instructionsFor}=require('../../v1/lib/ask-research-sql');assert.match(instructionsFor(true),/height is a block sequence number/);assert.match(instructionsFor(true),/monthly shielded\/transparent counts/);assert.match(instructionsFor(true),/Raw transactions remain appropriate/);
});

test('summary-compatible AI count history gets one repair only when extended summaries are enabled',async()=>{
 const rawSQL="WITH \nmonthly_activity AS (SELECT\n  pg_catalog.date_trunc('month', pg_catalog.to_timestamp(\"timestamp\")) AS month,\n  pg_catalog.count(*) FILTER (WHERE shielded) AS shielded_transactions,\n  pg_catalog.count(*) FILTER (WHERE NOT (shielded)) AS transparent_transactions\nFROM analytics_public.transactions_query AS transactions\nWHERE\n  \"timestamp\" >= EXTRACT(EPOCH FROM '2025-01-01'::date)\n  AND \"timestamp\" < EXTRACT(EPOCH FROM '2026-01-01'::date)\nGROUP BY\n  month\nORDER BY\n  month),\n  rolling_avg AS (SELECT\n    month,\n    shielded_transactions,\n    transparent_transactions,\n    pg_catalog.avg(shielded_transactions) OVER (\n      ORDER BY month\n      ROWS BETWEEN 2 PRECEDING AND CURRENT ROW\n    ) AS three_month_avg\n  FROM monthly_activity)\nSELECT\n  month,\n  shielded_transactions,\n  transparent_transactions,\n  pg_catalog.round((COALESCE(shielded_transactions::numeric / (NULLIF (shielded_transactions + transparent_transactions, 0)), 0)) * 100, 2) AS shielded_share,\n  three_month_avg\nFROM rolling_avg";
 const question='Compare monthly shielded and transparent transaction counts during 2025, show the shielded share and a three-month rolling average. Explain the biggest change.';
 const repairedSQL="WITH monthly_activity AS(SELECT date_trunc('month',date::timestamp)::date AS month,sum(shielded_transactions) AS shielded_transactions,sum(transparent_transactions) AS transparent_transactions FROM activity_daily WHERE date>=DATE '2025-01-01' AND date<DATE '2026-01-01' GROUP BY 1) SELECT month,shielded_transactions,transparent_transactions,100*shielded_transactions::numeric/nullif(shielded_transactions+transparent_transactions,0) AS shielded_share,avg(shielded_transactions) OVER(ORDER BY month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS three_month_avg FROM monthly_activity ORDER BY month";
 assert.deepEqual(await draftDiagnostics(rawSQL),[]);
 assert.match((await draftDiagnostics(rawSQL,{extended:true}))[0],/exactly represented by activity_daily/);
 await compileResearchSQL({version:3,sql:rawSQL,limit:100},{extended:true});
 await compileResearchDraft(rawSQL,{question},()=>assert.fail('Unavailable summaries must not trigger a repair'));
 let calls=0;
 const query=await compileResearchDraft(rawSQL,{question},async(input)=>{calls++;assert.equal(input.question,question);assert.equal(input.sql,rawSQL);assert.match(input.diagnostics[0],/Transparent means shielded IS FALSE/);assert.match(input.diagnostics[0],/share denominator/);return {sql:repairedSQL};},{extended:true});
 assert.equal(calls,1);assert.match(query.sql,/activity_daily_query/);assert.match(query.sql,/2025-01-01/);assert.match(query.sql,/2026-01-01/);assert.match(query.sql,/transparent_transactions/);assert.match(query.sql,/2 PRECEDING/);
 calls=0;await assert.rejects(compileResearchDraft(rawSQL,{question},async()=>{calls++;return {sql:rawSQL};},{extended:true}),e=>e.askKind==='answer');assert.equal(calls,1);
 const raw=(shielded='count(*) FILTER(WHERE t.shielded)',transparent='count(*) FILTER(WHERE NOT t.shielded)',extra='',where='')=>`SELECT date_trunc('month',to_timestamp(t.timestamp)) AS month,${shielded} AS shielded_transactions,${transparent} AS transparent_transactions${extra} FROM transactions t WHERE t.timestamp>=extract(epoch FROM DATE '2025-01-01') AND t.timestamp<extract(epoch FROM DATE '2026-01-01')${where} GROUP BY 1`;
 for(const sql of [raw(),raw('count(*) FILTER(WHERE t.shielded IS TRUE)','count(*) FILTER(WHERE t.shielded IS FALSE)',',count(*) FILTER(WHERE t.shielded IS NULL) AS unknown_count,count(*) AS total_count'),raw('count(CASE WHEN t.shielded THEN 1 END)','count(CASE WHEN NOT t.shielded THEN 1 END)'),raw('count(*) FILTER(WHERE t.shielded=true)','count(*) FILTER(WHERE t.shielded=false)')])assert.match((await draftDiagnostics(sql,{extended:true}))[0],/exactly represented by activity_daily/);
 // These questions need raw detail, partial-day data or classifications that
 // cannot be substituted with explicit-true/false daily counts unchanged.
 for(const sql of [raw(undefined,undefined,''," AND t.fees>1000"),raw(undefined,undefined,'',' AND t.bytes>200'),raw(undefined,undefined,''," AND t.txid='abc'"),raw(undefined,undefined,''," AND t.miner='miner'"),raw(undefined,undefined,'',' AND t.orchard IS TRUE'),raw('count(fees) FILTER(WHERE t.shielded)'),raw(undefined,'count(*) FILTER(WHERE t.shielded IS NOT TRUE)'),raw(undefined,'count(*) FILTER(WHERE NOT coalesce(t.shielded,false))'),raw('count(CASE WHEN t.shielded THEN 1 ELSE 0 END)'),raw(undefined,undefined,',avg(t.fees) AS mean_fee'),raw(undefined,undefined,',sum(t.bytes) AS total_bytes'),raw().replace('transactions t','transactions t JOIN flows f ON f.txid=t.txid'),raw().replace("DATE '2025-01-01'", "TIMESTAMPTZ '2025-01-01 12:00:00+00'"),raw().replace("DATE '2026-01-01'","DATE '2999-01-01'"),"WITH raw_records AS(SELECT * FROM transactions) "+raw().replace('FROM transactions t','FROM raw_records t'),"WITH transactions_query AS(SELECT * FROM transactions WHERE fees>1000) "+raw().replace('FROM transactions t','FROM transactions_query t')])assert.deepEqual(await draftDiagnostics(sql,{extended:true}),[],sql);
 const {benchmarks}=require('../../v1/lib/ask-research-benchmarks');for(const benchmark of benchmarks)assert.deepEqual(await draftDiagnostics(benchmark.sql,{extended:true}),[],benchmark.id);
});

test('empty English research gets an honest receipt without spending on a fabricated explanation',async()=>{
 const {researchReply}=require('../../v1/lib/ask-research-reply');const result={query:{version:3,sql:'SELECT height FROM blocks',limit:100},columns:[{key:'c0',label:'height',type:'number'}],rows:[],truncated:false,datasets:['blocks'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-08T00:00:00Z',indexedThrough:'2026-10-07T00:00:00Z',coverage:'verified canonical records',units:'exact'};
 const reply=await researchReply(result,{},()=>assert.fail('No paid empty-result narrative'),'en',()=>assert.fail());assert.match(reply.answer,/does not establish zero activity/);assert.match(reply.answer,/Edit query/);
});

test('research captions keep two complete sentences without treating decimal points as boundaries',()=>{
 const {checkedCaption}=require('../../v1/lib/ask-research-reply');
 const facts={row_a_a:'3 Sept 2026',row_a_b:'944.58%'},numeric=new Set(['row_a_b']);
 assert.equal(checkedCaption('The peak was {{row_a_b}} above baseline. The result card shows a',facts,numeric),'The peak was 944.58% above baseline.');
 assert.equal(checkedCaption('The peak was {{row_a_b}}',facts,numeric),null);
 assert.equal(checkedCaption('A complete finding of {{row_a_b}}.',facts,numeric),'A complete finding of 944.58%.');
 assert.equal(checkedCaption('A finding with no cited fact.',facts,numeric),null);
 assert.equal(checkedCaption('観測値は{{row_a_b}}でした。 表は',facts,numeric,'ja'),'観測値は944.58%でした。');
 assert.equal(checkedCaption('A finding of {{row_a_b}}. Its meaning. An unrelated third sentence.',facts,numeric),'A finding of 944.58%. Its meaning.');
 // Literal calendar words are dates without a fact: the whole caption fails.
 assert.equal(checkedCaption('Seven dates met both conditions. On Sep of the returned dates, flows rose.',facts,numeric),null);
 assert.equal(checkedCaption('On {{row_a_a}}, flows rose.',facts,numeric),'On 3 Sept 2026, flows rose.');
});

test('swap time filters must not compare timestamptz to numeric Unix bounds',async()=>{
 for(const bound of ["EXTRACT(EPOCH FROM DATE '2026-09-01')::bigint",'1788220800','1788220800.5'])assert.match((await draftDiagnostics('SELECT * FROM swaps s WHERE s.timestamp>='+bound))[0],/UTC timestamptz/);
 assert.deepEqual(await draftDiagnostics("SELECT * FROM swaps WHERE timestamp>=TIMESTAMPTZ '2026-09-01 00:00:00+00'"),[]);
 assert.deepEqual(await draftDiagnostics('SELECT * FROM flows WHERE timestamp>=1788220800'),[]);
});

test('daily joins reject a resolved text/date mismatch, not a valid cast or unrelated output',async()=>{
 const brokenJoin="WITH swap_totals AS(SELECT to_char(timestamp,'YYYY-MM-DD') AS date,sum(usd) AS amount FROM swaps GROUP BY 1), flow_totals AS(SELECT date,sum(amount) AS amount FROM flow_daily GROUP BY date) SELECT f.date FROM flow_totals f JOIN swap_totals s ON f.date=s.date";
 assert.match((await draftDiagnostics(brokenJoin))[0],/matching DATE types/);
 assert.deepEqual(await draftDiagnostics(brokenJoin.replace("to_char(timestamp,'YYYY-MM-DD')",'timestamp::date')),[]);
 assert.deepEqual(await draftDiagnostics("SELECT to_char(timestamp,'YYYY-MM-DD') AS date FROM swaps"),[]);
 assert.match((await draftDiagnostics("SELECT * FROM flow_daily WHERE pool='all'"))[0],/no synthetic all pool/);
 assert.deepEqual(await draftDiagnostics("SELECT * FROM flow_daily WHERE pool='orchard'"),[]);
});

// Observed live: a drafted avg(fees) AS average_fee_zec published zatoshis as ZEC.
test('ZEC-labelled draft columns must convert zatoshis in their own expression',async()=>{
 for(const sql of ['SELECT avg(fees) AS average_fee_zec FROM blocks','WITH x AS (SELECT avg(fees) AS a_zec FROM blocks) SELECT a_zec FROM x','SELECT (SELECT max(fees) FROM blocks) AS max_zec FROM blocks'])assert.match((await draftDiagnostics(sql))[0],/labelled ZEC must convert zatoshis/);
 for(const sql of ['SELECT avg(fees)/100000000 AS average_fee_zec FROM blocks','SELECT round(sum(fees)::numeric/100000000,8) AS fees_zec FROM blocks','WITH x AS (SELECT avg(fees)/100000000 AS a_zec FROM blocks) SELECT a_zec FROM x','WITH x AS (SELECT height,fees::numeric/100000000 AS fee_zec FROM blocks) SELECT avg(fee_zec) OVER (ORDER BY height) AS avg_fee_zec FROM x','SELECT max(fees) AS largest_fee FROM blocks'])assert.deepEqual(await draftDiagnostics(sql),[]);
 const {benchmarks}=require('../../v1/lib/ask-research-benchmarks');
 for(const benchmark of benchmarks){const compiled=await compileResearchSQL({version:3,sql:benchmark.sql,limit:100},{extended:true});assert.deepEqual(await draftDiagnostics(compiled.request.sql),[],benchmark.id);}
});

test('unit diagnostics preserve counts, USD asset labels and complete expression conversions',async()=>{
 const {researchUnitsFor}=require('../../v1/lib/ask-research-plan-quality');
 const cases=[
  ['SELECT count(*) AS zec_transactions,count(fees) AS fee_count_zec FROM transactions',['count','count']],
  ["SELECT sum(usd) AS zec_outflow_usd FROM swaps WHERE direction='outflow'",['usd']],
  ['SELECT 0.00000001*avg(b.fees) AS average_fee_zec FROM blocks b',['zec']],
  ['SELECT avg(b.fees)*0.00000001 AS average_fee_2026 FROM blocks b',['zec']],
  ['WITH converted(fee) AS(SELECT fees::numeric/100000000 FROM blocks) SELECT avg(c.fee) AS avg_fee_2026 FROM converted c',['zec']],
  ['SELECT avg(c.fee) AS average_fee FROM (SELECT fees::numeric/100000000 AS fee FROM blocks) c',['zec']],
  ['SELECT b.height,(SELECT max(t.fees)::numeric/100000000 FROM transactions t WHERE t.height=b.height) AS fee FROM blocks b',['count','zec']],
  ['WITH public_totals AS(SELECT sum(amount)::numeric/100000000 AS volume FROM flows),swap_totals AS(SELECT sum(usd) AS volume FROM swaps) SELECT p.volume,s.volume FROM public_totals p CROSS JOIN swap_totals s',['zec','usd']],
  ['SELECT fees::numeric/100000000 AS fee FROM blocks UNION ALL SELECT fees::numeric/100000000 AS fee FROM transactions',['zec']],
  ['SELECT 100*sum(fees)/nullif(sum(fees),0) AS fee_share FROM blocks',['scalar']],
  ['SELECT CASE WHEN fees IS NULL THEN NULL ELSE fees::numeric/100000000 END AS fee_zec FROM blocks',['zec']],
  ['SELECT coalesce(avg(fees)::numeric/100000000,0) AS fee_zec FROM blocks',['zec']],
  ['SELECT sum(fees)+sum(fees)/100000000 AS fee_zec FROM blocks',['unknown']],
  ['SELECT sqrt(avg(fees)) AS fee_zec FROM blocks',['unknown']],
  ['SELECT lag(fees::numeric/100000000,1,fees) OVER(ORDER BY height) AS fee_zec FROM blocks',['unknown']],
  ['SELECT lead(fees::numeric/100000000,1,0) OVER(ORDER BY height) AS fee_zec FROM blocks',['zec']],
  ['SELECT fees AS fee_zec FROM blocks b JOIN transactions t ON t.height=b.height',['unknown']]
 ];
 for(const [sql,expected]of cases){
  const compiled=await compileResearchSQL({version:3,sql,limit:100},{extended:true});
  assert.deepEqual((await researchUnitsFor(compiled.request.sql)).columns.map(c=>c.unit),expected,sql);
  assert.deepEqual(await draftDiagnostics(compiled.request.sql),[],sql);
 }
 // A conversion in FILTER or OVER does not convert the aggregate's measure.
 for(const sql of ['SELECT sum(fees) FILTER(WHERE height/100000000>0) AS fee_zec FROM blocks','SELECT sum(fees) OVER(PARTITION BY height/100000000) AS fee_zec FROM blocks'])assert.match((await draftDiagnostics(sql))[0],/labelled ZEC must convert zatoshis/);
});

// Numerical oracle in one disposable PG16 cluster, never a configured DB URL.
test('isolated PG16 reviewed baselines and pool windows preserve dates and missing measures',{skip:process.env.ASK_PLAN_TEST_POSTGRES!=='1'},async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process'),{Pool,types}=require('pg');
 const bin=process.env.ASK_LOGICAL_PG_BIN;
 assert.ok(bin&&path.isAbsolute(bin),'Explicit local PG16 binary directory required');
 const command=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
 assert.match(command('postgres',['--version']),/^postgres \(PostgreSQL\) 16\./);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-plan-fixture-')),data=path.join(root,'data'),socket=path.join(root,'socket');
 fs.chmodSync(root,0o700);fs.mkdirSync(socket,{mode:0o700});let active=false,pool;
 t.after(async()=>{await pool?.end();if(active){command('pg_ctl',['-D',data,'-m','fast','-w','stop']);active=false;}if(!active)fs.rmSync(root,{recursive:true,force:true});});
 command('initdb',['-D',data,'-U','ask_plan_fixture','-A','trust','--no-locale','--encoding=UTF8']);
 fs.appendFileSync(path.join(data,'postgresql.conf'),"\nlisten_addresses=''\nunix_socket_directories='"+socket+"'\nshared_buffers='16MB'\nlog_min_messages=warning\n");
 command('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-w','start']);active=true;
 pool=new Pool({host:socket,port:5432,user:'ask_plan_fixture',database:'postgres',max:1,ssl:false,types:{getTypeParser:(oid,format)=>oid===1082?value=>value:types.getTypeParser(oid,format)}});
 await pool.query(`SET TIME ZONE 'UTC';CREATE SCHEMA analytics_public;
 CREATE TABLE analytics_public.activity_daily_query(date date PRIMARY KEY,shielded_transactions bigint,transactions bigint);
 INSERT INTO analytics_public.activity_daily_query SELECT DATE '2026-08-02'+i,CASE WHEN DATE '2026-08-02'+i=DATE '2026-09-01' THEN 1000 ELSE 100 END,2000 FROM generate_series(0,59) i;
 CREATE TABLE analytics_public.flow_daily_query(date date,pool text,direction text,amount numeric,missing_amounts bigint);
 INSERT INTO analytics_public.flow_daily_query SELECT DATE '2026-08-25'+i,p,'deshield',CASE WHEN DATE '2026-08-25'+i=DATE '2026-09-02' AND p='orchard' THEN NULL ELSE CASE WHEN p='orchard' THEN 6000000000 ELSE 4000000000 END*CASE WHEN DATE '2026-08-25'+i IN(DATE '2026-09-03',DATE '2026-09-17',DATE '2026-09-30') THEN 2 ELSE 1 END END,CASE WHEN DATE '2026-08-25'+i=DATE '2026-09-02' AND p='orchard' THEN 1 ELSE 0 END FROM generate_series(0,36) i CROSS JOIN(VALUES('orchard'),('ironwood')) pools(p);
 CREATE TABLE analytics_public.swaps_query(timestamp timestamptz,direction text,usd numeric);
 INSERT INTO analytics_public.swaps_query SELECT (DATE '2026-08-25'+i)::timestamptz,'outflow',CASE WHEN DATE '2026-08-25'+i IN(DATE '2026-09-01',DATE '2026-09-26') THEN NULL WHEN DATE '2026-08-25'+i IN(DATE '2026-09-03',DATE '2026-09-17',DATE '2026-09-30') THEN 2000 ELSE 1000 END FROM generate_series(0,36) i;
 INSERT INTO analytics_public.swaps_query VALUES ('2026-09-17','inflow',999999);
 CREATE TABLE analytics_public.daily_query(date date PRIMARY KEY,orchard numeric,ironwood numeric);
 INSERT INTO analytics_public.daily_query SELECT DATE '2025-12-25'+i,(1000-10*i)::numeric*100000000,(100+12*i)::numeric*100000000 FROM generate_series(0,16) i;`);
 const {benchmarks}=require('../../v1/lib/ask-research-benchmarks');
 const run=async id=>{const c=await compileResearchSQL({version:3,sql:benchmarks.find(x=>x.id===id).sql,limit:100},{extended:true});return(await pool.query(c.text,c.values)).rows;};
 await t.test('known monetary averages exclude null observations but retain genuine zero observations',async()=>{
  const {rows}=await pool.query(`SELECT avg(fees)::text AS known_average,avg(coalesce(fees,0))::text AS zero_filled_average,coalesce(avg(fees),0)::text AS aggregate_default,count(fees)::text AS known,count(*) FILTER(WHERE fees IS NULL)::text AS missing,count(*) FILTER(WHERE fees=0)::text AS zeros FROM(VALUES(100::numeric),(NULL::numeric),(0::numeric)) observations(fees)`);
  assert.equal(Number(rows[0].known_average),50);assert.match(rows[0].zero_filled_average,/^33\.333/);assert.equal(Number(rows[0].aggregate_default),50);
  assert.equal(rows[0].known,'2');assert.equal(rows[0].missing,'1');assert.equal(rows[0].zeros,'1');
 });
 await t.test('September output keeps August lookback and ranks the known spike',async()=>{
  const rows=await run('shielded_30d_baseline');assert.equal(rows.length,10);assert.equal(rows[0].date,'2026-09-01');assert.equal(rows[0].shielded_transactions,'1000');assert.equal(rows[0].preceding_30_day_average,'100.00');assert.equal(rows[0].percentage_above_baseline,'900.00');assert.equal(rows[0].shielded_transaction_share_percent,'50.00');
 });
 await t.test('both baselines exclude missing values, combine pools and ignore inflows',async()=>{
  const rows=await run('independent_flow_swap_baselines');assert.equal(rows.length,1);assert.equal(rows[0].date,'2026-09-17');assert.equal(Number(rows[0].deshield_zec),200);assert.equal(Number(rows[0].preceding_7d_avg_deshield_zec),100);assert.equal(Number(rows[0].outflow_usd),2000);assert.equal(Number(rows[0].preceding_7d_avg_outflow_usd),1000);assert.equal(rows[0].swap_count,'1');assert.equal(rows[0].missing_amounts,'0');assert.equal(rows[0].missing_usd,'0');
 });
 await t.test('seven-day stock deltas include the previous-year starting observations',async()=>{
  const rows=await run('orchard_7d_decreases');assert.equal(rows.length,5);assert.equal(rows[0].starting_observation_date,'2025-12-25');assert.equal(rows[0].ending_observation_date,'2026-01-01');assert.equal(Number(rows[0].orchard_change_zec),-70);assert.equal(Number(rows[0].ironwood_change_zec),84);assert.equal(Number(rows[0].combined_balance_change_zec),14);
 });
});

test('locale-formatted date facts keep all their punctuation inside a complete research finding',async()=>{
 const {researchReply}=require('../../v1/lib/ask-research-reply');
 const result={query:{version:3,sql:'SELECT date,shielded_transactions FROM activity_daily',limit:100},columns:[{key:'c0',label:'date',type:'text'},{key:'c1',label:'shielded_transactions',type:'number'}],rows:[['2026-09-03','22283']],truncated:false,datasets:['activity_daily'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-12T00:00:00Z',indexedThrough:'2026-10-12T00:00:00Z',coverage:'verified canonical records',units:'exact'};
 for(const locale of ['de','fr']){
  const reply=await researchReply(result,{question:'Activity'},async()=>({finding:'Datum {{row_a_a}}: {{row_a_b}} transactions. Completed finding.'}),locale,()=>({instruction:''}));
  const date=new Date('2026-09-03T00:00:00Z').toLocaleDateString(locale,{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'});
  assert.ok(reply.answer.includes(date));assert.ok(reply.answer.includes('22,283'));assert.ok(reply.answer.endsWith('Completed finding.'));
 }
});


const zeroFilledFeeDraft='WITH latest_blocks AS (SELECT height,hash,fees FROM analytics_public.blocks_query AS blocks ORDER BY height DESC LIMIT 100) SELECT count(CASE WHEN fees IS NOT NULL THEN 1 END) AS known_fees_count,count(CASE WHEN fees IS NULL THEN 1 END) AS missing_fees_count,avg(COALESCE(fees,0))::numeric/100000000 AS average_known_fee_zec FROM latest_blocks';
test('AI averages diagnose zero-filled monetary observations through numeric casts and resolved sources',async()=>{
 const statements=[
  zeroFilledFeeDraft,
  'SELECT avg(coalesce(fees,0)) AS measured_fee FROM blocks',
  'SELECT avg(coalesce(t.fees,0))::numeric/100000000 AS average_fee_zec FROM transactions t',
  'SELECT round(avg((coalesce(fees::numeric,0::numeric))::numeric)/100000000,8) AS fee_zec FROM blocks',
  "SELECT avg(coalesce(fees,'0'::numeric)) AS fee FROM blocks",
  'SELECT avg(coalesce(fees,-0.0::numeric)) AS fee FROM blocks',
  'SELECT avg(coalesce(f.amount,0)) AS amount FROM flows f',
  'SELECT avg(coalesce(orchard,0)) AS orchard FROM daily',
  'SELECT avg(coalesce(s.usd,0)) AS valuation FROM swaps s',
  'WITH converted AS(SELECT fees::numeric/100000000 AS fee FROM blocks) SELECT avg(coalesce(c.fee,0)) AS fee_zec FROM converted c',
  'SELECT (SELECT avg(coalesce(t.fees,0)) FROM transactions t WHERE t.height=b.height) AS fee FROM blocks b',
  'SELECT avg(coalesce(b.fees,0)) FROM blocks b JOIN transactions t ON t.height=b.height WHERE t.fees IS NOT NULL',
  'SELECT avg(coalesce(fees,0)) FROM blocks WHERE fees IS NOT NULL OR height>100',
 ];
 for(const sql of statements){
  const compiled=await compileResearchSQL({version:3,sql,limit:100},{extended:true});
  assert.ok((await draftDiagnostics(compiled.request.sql,{extended:true})).some(issue=>/AVG\(COALESCE/.test(issue)),sql);
 }
});
test('the monetary-average guard leaves ordinary averages, unknown lineage and proven local nonnull observations unchanged',async()=>{
 const statements=[
  'SELECT avg(fees)::numeric/100000000 AS fee_zec FROM blocks',
  'SELECT coalesce(avg(fees),0) AS fee FROM blocks',
  'SELECT avg(coalesce(transactions,0)) AS transaction_count FROM activity_daily',
  'WITH counts AS(SELECT transactions AS fees FROM activity_daily) SELECT avg(coalesce(fees,0)) AS mean_count FROM counts',
  'WITH transformed AS(SELECT sqrt(fees) AS fee FROM blocks) SELECT avg(coalesce(fee,0)) FROM transformed',
  'SELECT avg(coalesce(fees,1)) FROM blocks',
  'SELECT avg(coalesce(fees,1e-999)) FROM blocks',
  'SELECT avg(coalesce(fees,0)) FROM blocks WHERE fees IS NOT NULL',
  'SELECT avg(coalesce(b.fees::numeric,0)) FROM blocks b WHERE height>100 AND b.fees::numeric IS NOT NULL',
  'SELECT avg(coalesce(fees,0)) FILTER(WHERE fees IS NOT NULL) FROM blocks',
  'SELECT avg(fees) OVER(PARTITION BY coalesce(fees,0)) FROM blocks',
  'SELECT avg(fees) FILTER(WHERE coalesce(fees,0)>0) FROM blocks',
 ];
 for(const sql of statements){
  const compiled=await compileResearchSQL({version:3,sql,limit:100},{extended:true});
  assert.deepEqual(await draftDiagnostics(compiled.request.sql,{extended:true}),[],sql);
 }
 // Ambiguous or absent fields must not become monetary merely from a name.
 for(const sql of ['SELECT avg(coalesce(fees,0)) FROM blocks b JOIN transactions t ON t.height=b.height','SELECT avg(coalesce(fees,0)) FROM unavailable_source'])assert.deepEqual(await draftDiagnostics(sql),[],sql);
 const {benchmarks}=require('../../v1/lib/ask-research-benchmarks');
 for(const benchmark of benchmarks){const compiled=await compileResearchSQL({version:3,sql:benchmark.sql,limit:100},{extended:true});assert.deepEqual(await draftDiagnostics(compiled.request.sql,{extended:true}),[],benchmark.id);}
});
test('zero-filled monetary draft gets one bounded repair while direct SQL remains admitted unchanged',async()=>{
 const question='For the latest 100 blocks, show known and missing fees and the average known fee in ZEC.';
 const fixedSQL=zeroFilledFeeDraft.replace('avg(COALESCE(fees,0))','avg(fees)');
 const direct=await compileResearchSQL({version:3,sql:zeroFilledFeeDraft,limit:100},{extended:true});
 assert.match(direct.request.sql,/COALESCE/i,'quality guidance never rewrites or rejects direct user SQL');
 let calls=0;
 const query=await compileResearchDraft(zeroFilledFeeDraft,{question},async(input,task)=>{
  calls++;assert.equal(input.question,question);assert.equal(input.sql,zeroFilledFeeDraft);assert.equal(task.name,'research_sql');
  assert.ok(input.diagnostics.some(issue=>/AVG ignores NULL and retains genuine zeros/.test(issue)));
  return {sql:fixedSQL};
 },{extended:true});
 assert.equal(calls,1);assert.doesNotMatch(query.sql,/COALESCE/i);assert.match(query.sql,/100/);assert.match(query.sql,/known_fees_count/);assert.match(query.sql,/missing_fees_count/);assert.match(query.sql,/average_known_fee_zec/);
 calls=0;
 await assert.rejects(compileResearchDraft(zeroFilledFeeDraft,{question},async()=>{calls++;return {sql:zeroFilledFeeDraft};},{extended:true}),error=>error.askKind==='answer');assert.equal(calls,1);
 calls=0;
 await assert.rejects(compileResearchDraft(zeroFilledFeeDraft,{question},async()=>{calls++;return {sql:null};},{extended:true}),error=>error.askKind==='answer');assert.equal(calls,1);
});
