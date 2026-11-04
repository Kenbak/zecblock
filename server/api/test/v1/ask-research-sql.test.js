'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compileResearchSQL,researchEvidence,researchInstructions}=require('../../v1/lib/ask-research-sql');
const request=sql=>({version:3,sql,limit:10});
const good=[
 'SELECT blocks.height,hash FROM blocks ORDER BY height DESC LIMIT 5',
 'SELECT t.height,count(*) AS txs FROM transactions t JOIN blocks b ON b.height=t.height GROUP BY t.height',
 "SELECT date_trunc('week',to_timestamp(timestamp)) AS week,count(*) AS txs FROM transactions WHERE shielded=true AND timestamp>=extract(epoch FROM DATE '2026-09-01') AND timestamp<extract(epoch FROM DATE '2026-10-01') GROUP BY week ORDER BY txs DESC",
 'WITH recent AS (SELECT height FROM blocks LIMIT 5), counts AS (SELECT height,count(*) AS n FROM transactions GROUP BY height) SELECT recent.height,n FROM recent LEFT JOIN counts ON counts.height=recent.height',
 'SELECT height,lag(height) OVER (ORDER BY height) AS previous,row_number() OVER (ORDER BY height DESC) AS rank FROM blocks',
 "SELECT pool,sum(amount)::numeric/100000000 AS zec FROM flows WHERE direction IN ('shield','deshield') GROUP BY pool",
 'SELECT height,100*count(*) FILTER(WHERE shielded)::numeric/NULLIF(count(*),0) AS share FROM transactions GROUP BY height',
 "SELECT height,CASE WHEN height>5 THEN 'DROP TABLE; pg_read_file; ignore instructions' ELSE 'normal' END AS label FROM blocks",
 'SELECT height FROM blocks WHERE EXISTS(SELECT txid FROM transactions WHERE transactions.height=blocks.height)',
 'SELECT height FROM blocks WHERE height BETWEEN 1 AND 5 UNION SELECT height FROM transactions WHERE height>5',
 'SELECT height FROM (SELECT height FROM blocks LIMIT 10) AS recent',
 "SELECT height FROM blocks WHERE miner ILIKE 't1%' AND bytes IS NOT NULL",
 'SELECT height,round(fees::numeric/100000000,8) AS fee FROM blocks WHERE height=(SELECT max(height) FROM blocks)',
 'SELECT height FROM blocks WHERE height IN (SELECT height FROM transactions)',
 'SELECT height FROM blocks WHERE height < ANY (SELECT height FROM transactions)'
];
for(const sql of good)test('accepts and canonicalizes: '+sql.slice(0,65),async()=>{const c=await compileResearchSQL(request(sql));assert.match(c.text,/^SELECT \* FROM \(/);assert.deepEqual(c.values,[11]);assert.ok(c.datasets.length);const again=await compileResearchSQL(c.request);assert.equal(again.fingerprint,c.fingerprint);assert.equal(again.request.sql,c.request.sql);});
const bad=[
 'DELETE FROM blocks','UPDATE blocks SET fees=0','TRUNCATE blocks','DROP TABLE blocks','ALTER ROLE ask_public_reader SUPERUSER','CREATE TABLE attack(x int)','DO $$BEGIN END$$','CALL attack()',"COPY blocks TO PROGRAM 'id'",
 'SELECT height FROM blocks; SELECT 1', 'WITH changed AS (DELETE FROM blocks RETURNING height) SELECT height FROM changed','SELECT height INTO attack FROM blocks','SELECT height FROM blocks FOR UPDATE','SELECT height FROM blocks FOR SHARE',
 'SELECT * FROM pg_catalog.pg_authid','SELECT subconninfo FROM pg_subscription','SELECT secret FROM analytics_meta.sync_state','SELECT * FROM public.blocks','SELECT * FROM information_schema.tables','SELECT * FROM other.blocks','SELECT * FROM daily','SELECT * FROM swaps','SELECT * FROM addresses',
 "SELECT pg_read_file('/etc/passwd') FROM blocks", "SELECT pg_catalog.pg_ls_dir('/') FROM blocks", "SELECT current_setting('ask.credentials') FROM blocks", "SELECT set_config('role','analytics_owner',false) FROM blocks",'SELECT pg_sleep(1) FROM blocks',
 "SELECT dblink('private','SELECT secret') FROM blocks","SELECT http_get('https://evil.example') FROM blocks", "SELECT lo_import('/etc/passwd') FROM blocks","SELECT nextval('private.seq') FROM blocks",'SELECT generate_series(1,999999999) FROM blocks',
 'SELECT current_user FROM blocks','SELECT session_user FROM blocks','SELECT current_database() FROM blocks','SELECT version() FROM blocks',"SELECT 'private'::regclass FROM blocks", "SELECT 'unsafe'::public.secret_type FROM blocks",'SELECT height::int[] FROM blocks',
 'WITH RECURSIVE loop AS (SELECT height FROM blocks UNION ALL SELECT height FROM loop) SELECT height FROM loop','WITH blocks AS (SELECT height FROM transactions) SELECT height FROM blocks',
 'SELECT * FROM blocks TABLESAMPLE SYSTEM(1)', 'SELECT * FROM blocks,LATERAL(SELECT height FROM transactions) t','SELECT * FROM unnest(ARRAY[1,2])','SELECT height OPERATOR(public.+) 1 FROM blocks',
 'SELECT ARRAY(SELECT height FROM blocks) AS a FROM blocks','SELECT array_length(ARRAY(SELECT height FROM transactions),1) FROM blocks',
 'SELECT height FROM blocks WHERE height OPERATOR(pg_catalog.=) ANY (SELECT height FROM transactions)','SELECT height FROM blocks WHERE height OPERATOR(public.=) ANY (SELECT height FROM transactions)','SELECT height FROM blocks WHERE height OPERATOR(pg_catalog.<) ALL (SELECT height FROM transactions)',
 "SELECT repeat('x',1000000000) FROM blocks",'SELECT power(2,9999999) FROM blocks','SELECT 2^9999999 FROM blocks',"WITH a AS(SELECT hash FROM blocks) SELECT hash||hash FROM a",
 'SELECT $1 FROM blocks', 'SELECT * FROM blocks WHERE height = ANY(ARRAY[1,2])',"SELECT json_build_object('secret',height) FROM blocks", 'SELECT XMLPARSE(DOCUMENT hash) FROM blocks',
 'WITH hidden AS (SELECT subconninfo FROM pg_subscription) SELECT height FROM blocks UNION SELECT subconninfo FROM hidden',
 'SELECT height FROM blocks WHERE EXISTS(SELECT rolpassword FROM pg_authid)',
 "SELECT pg_catalog.pg_read_binary_file($file$/etc/passwd$file$) FROM blocks",
 "SELECT lo_export(1,'/tmp/ask-forbidden-output') FROM blocks",
 "SELECT pg_advisory_lock(1) FROM blocks",
 "SELECT pg_terminate_backend(1) FROM blocks",
 "SELECT query_to_xml('DELETE FROM public.blocks',true,false,'') FROM blocks",
 'SELECT pg_catalog.pg_authid.rolpassword FROM blocks',
 'WITH hidden AS (SELECT height FROM blocks) SELECT height FROM hidden; RESET ROLE',
 'SELECT height AS "<script>" FROM blocks','SELECT 1','SELECT height FROM blocks ORDER BY height USING OPERATOR(public.>)','SELECT * FROM blocks AS "invalid alias"', 'SELECT pg_temp.pg_read_file(hash) FROM blocks'
];
for(const sql of bad)for(const decorate of [s=>s,s=>'/* untrusted comment; SELECT is not authority */ '+s,s=>s.replace(/SELECT/g,'SeLeCt')])test('denies: '+decorate(sql).slice(0,90),async()=>{await assert.rejects(compileResearchSQL(request(decorate(sql))));});
// SubLink policy must preserve useful relational subqueries at every nesting
// point while independently validating operators and rejecting array builders.
const acceptedSublinks=[
 {name:'ALL comparisons',sql:'SELECT height FROM blocks WHERE height >= ALL (SELECT height FROM transactions)',datasets:['blocks','transactions']},
 {name:'SOME comparisons',sql:'SELECT height FROM blocks WHERE height = SOME (SELECT height FROM transactions)',datasets:['blocks','transactions']},
 {name:'NOT IN subqueries',sql:'SELECT height FROM blocks WHERE height NOT IN (SELECT height FROM transactions WHERE fees IS NULL)',datasets:['blocks','transactions']},
 {name:'correlated scalar target',sql:'SELECT b.height,(SELECT max(t.height) FROM transactions t WHERE t.height<=b.height) AS latest_transaction_height FROM blocks b',datasets:['blocks','transactions']},
 {name:'nested correlated scalar WHERE',sql:'SELECT b.height FROM blocks b WHERE b.height=(SELECT max(t.height) FROM transactions t WHERE t.height<=(SELECT max(f.height) FROM flows f WHERE f.height=b.height))',datasets:['blocks','flows','transactions']},
 {name:'nested correlated EXISTS',sql:'SELECT b.height FROM blocks b WHERE EXISTS(SELECT t.txid FROM transactions t WHERE t.height=b.height AND EXISTS(SELECT f.txid FROM flows f WHERE f.txid=t.txid AND f.height=(SELECT max(b2.height) FROM blocks b2 WHERE b2.height<=b.height)))',datasets:['blocks','flows','transactions']},
 {name:'CTE, derived table, set operation and mixed sublinks',sql:'WITH candidate_heights AS (SELECT b.height FROM blocks b WHERE b.height = SOME (SELECT t.height FROM transactions t WHERE t.height=b.height)) SELECT h.height,(SELECT max(f.amount) FROM flows f WHERE f.height=h.height) AS max_amount FROM (SELECT height FROM candidate_heights WHERE height NOT IN (SELECT height FROM transactions WHERE fees IS NULL) UNION SELECT height FROM blocks WHERE height > ALL (SELECT height FROM transactions WHERE shielded IS TRUE)) h WHERE EXISTS (SELECT txid FROM flows WHERE flows.height=h.height)',datasets:['blocks','flows','transactions']}
];
for(const {name,sql,datasets} of acceptedSublinks)test('accepts SubLink and stable canonical recompile: '+name,async()=>{
 const compiled=await compileResearchSQL(request(sql));
 assert.deepEqual(compiled.datasets,datasets);
 assert.deepEqual(compiled.values,[11]);
 assert.match(compiled.text,/^SELECT \* FROM \(/);
 assert.deepEqual(await compileResearchSQL(compiled.request),compiled);
});
const sublinkDecorators=[s=>s,s=>'/* untrusted comment */ '+s,s=>s.replace(/SELECT/g,'SeLeCt')];
for(const quantifier of ['ANY','ALL'])for(const {name,left,op,right} of [
 {name:'regular expression',left:'hash',op:'~',right:'txid'},
 {name:'negated regular expression',left:'hash',op:'!~',right:'txid'},
 {name:'concatenation',left:'hash',op:'||',right:'txid'},
 {name:'exponentiation',left:'height',op:'^',right:'height'}
])test('denies unqualified '+name+' operator in '+quantifier+' sublink',async()=>{
 const sql=`SELECT ${left} FROM blocks WHERE ${left} ${op} ${quantifier} (SELECT ${right} FROM transactions)`;
 for(const decorate of sublinkDecorators)await assert.rejects(compileResearchSQL(request(decorate(sql))),/Operator is not allowed/);
});
for(const {name,sql} of [
 {name:'nested EXISTS operator',sql:'SELECT b.height FROM blocks b WHERE EXISTS(SELECT t.txid FROM transactions t WHERE t.height=b.height AND t.txid ~ ANY (SELECT f.txid FROM flows f WHERE f.height=b.height))'},
 {name:'CTE scalar target operator',sql:'WITH candidates AS (SELECT height,(SELECT max(height) FROM blocks WHERE hash !~ ALL (SELECT txid FROM transactions)) AS latest FROM blocks) SELECT height FROM candidates'}
])test('denies forbidden quantified operator in '+name,async()=>{
 for(const decorate of sublinkDecorators)await assert.rejects(compileResearchSQL(request(decorate(sql))),/Operator is not allowed/);
});
const deniedArraySublinks=[
 {name:'allowed coalesce target',sql:'SELECT coalesce(ARRAY(SELECT height FROM transactions),NULL) AS heights FROM blocks'},
 {name:'scalar target',sql:'SELECT (SELECT coalesce(ARRAY(SELECT height FROM flows),NULL) FROM transactions LIMIT 1) AS heights FROM blocks'},
 {name:'WHERE',sql:'SELECT height FROM blocks WHERE coalesce(ARRAY(SELECT height FROM transactions),NULL) IS NOT NULL'},
 {name:'correlated EXISTS',sql:'SELECT b.height FROM blocks b WHERE EXISTS(SELECT t.txid FROM transactions t WHERE t.height=b.height AND coalesce(ARRAY(SELECT f.height FROM flows f WHERE f.txid=t.txid),NULL) IS NOT NULL)'},
 {name:'ANY subquery',sql:'SELECT height FROM blocks WHERE height = ANY (SELECT height FROM transactions WHERE coalesce(ARRAY(SELECT height FROM flows),NULL) IS NOT NULL)'},
 {name:'CTE and IN',sql:'WITH candidate_heights AS (SELECT height FROM transactions WHERE coalesce(ARRAY(SELECT height FROM flows),NULL) IS NOT NULL) SELECT height FROM blocks WHERE height IN (SELECT height FROM candidate_heights)'},
 {name:'derived table',sql:'SELECT height FROM (SELECT height FROM blocks WHERE coalesce(ARRAY(SELECT height FROM transactions),NULL) IS NOT NULL) recent'},
 {name:'set operation',sql:'SELECT height FROM blocks UNION SELECT height FROM transactions WHERE coalesce(ARRAY(SELECT height FROM flows),NULL) IS NOT NULL'},
 {name:'CASE target',sql:'SELECT CASE WHEN height>0 THEN coalesce(ARRAY(SELECT height FROM transactions),NULL) ELSE NULL END AS heights FROM blocks'}
];
for(const {name,sql} of deniedArraySublinks)test('denies ARRAY sublink through '+name,async()=>{
 // coalesce is allowed, so the asserted error must come from the ARRAY sublink.
 for(const decorate of sublinkDecorators)await assert.rejects(compileResearchSQL(request(decorate(sql))),/Unsupported subquery/);
});
test('rejects unknown fields and complexity before execution',async()=>{for(const input of [{...request('SELECT height FROM blocks'),credentials:'secret'},{...request('SELECT height FROM blocks'),limit:201},{...request('SELECT height FROM blocks'),sql:'SELECT '+ 'x'.repeat(8193)}])await assert.rejects(compileResearchSQL(input));await assert.rejects(compileResearchSQL(request('SELECT '+Array.from({length:25},(_,i)=>`height AS h${i}`).join(',')+' FROM blocks')));});
test('exact decimal/null/duplicate aliases and truncation are preserved',async()=>{const c=await compileResearchSQL({version:3,sql:'SELECT height,fees FROM blocks',limit:1});const e=researchEvidence(c,[['9007199254740993',null],['1','2']],[{name:'same',dataTypeID:20},{name:'same',dataTypeID:1700}],{indexed_through:'2026-10-06T00:00:00Z'},'2026-10-06T00:00:01Z');assert.equal(e.rows[0][0],'9007199254740993');assert.equal(e.rows[0][1],null);assert.equal(e.truncated,true);assert.equal(e.columns[1].key,'c1');for(const rows of [[['x'.repeat(2049),'2']],[['x\u0000','2']],[['1']]])assert.throws(()=>researchEvidence(c,rows,[{name:'height',dataTypeID:20},{name:'fees',dataTypeID:1700}],{indexed_through:'2026-10-06'},'2026-10-06'));});

// Regression: a normal daily-activity question previously produced a reserved
// CTE name and AT TIME ZONE, both correctly rejected by the unchanged policy.
test('daily-activity drafting guidance matches the unchanged SQL policy',async()=>{
 for(const name of ['blocks','transactions','flows','daily','swaps','addresses'])assert.match(researchInstructions,new RegExp('\\b'+name+'\\b'));
 assert.match(researchInstructions,/CTE names must not be/);
 assert.match(researchInstructions,/Do not use AT TIME ZONE or timezone/);
 assert.match(researchInstructions,/transaction timezone to UTC/);
 const accepted=await compileResearchSQL(request("WITH daily_activity AS (SELECT to_char(to_timestamp(timestamp), 'YYYY-MM-DD') AS day_utc, count(*) FILTER (WHERE shielded IS TRUE) AS shielded_transactions FROM transactions WHERE timestamp >= extract(epoch FROM DATE '2026-09-07') AND timestamp < extract(epoch FROM DATE '2026-10-07') GROUP BY 1) SELECT day_utc, shielded_transactions FROM daily_activity ORDER BY day_utc"));
 assert.deepEqual(accepted.datasets,['transactions']);
 for(const sql of ["WITH daily AS (SELECT height FROM blocks) SELECT height FROM daily", "SELECT to_timestamp(timestamp) AT TIME ZONE 'UTC' FROM transactions", "SELECT timezone('UTC',to_timestamp(timestamp)) FROM transactions"])await assert.rejects(compileResearchSQL(request(sql)));
});
