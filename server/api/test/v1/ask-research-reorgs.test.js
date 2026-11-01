'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {compileResearchSQL,instructionsFor}=require('../../v1/lib/ask-research-sql');
const {catalogueFor,researchCatalogue,isPublished,coreGatedIds}=require('../../../../lib/ask/research-catalogue');
const {coreViews}=require('../../v1/lib/ask-core-catalogue');
const {displaySQL}=require('../../../../lib/ask/sql-display');
const {sqlExamples}=require('../../../../lib/ask/sql-examples');
const deploy=name=>fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics',name),'utf8');
const migration=deploy('reorgs-v1.sql'),rollback=deploy('reorgs-v1-rollback.sql');
const source=deploy('reorgs-source-v1.sql'),sourceRollback=deploy('reorgs-source-v1-rollback.sql');
const ids=['reorgs','orphaned_blocks'];
const preview={preview:true};
const view=name=>new RegExp(`CREATE VIEW analytics_public\\.${name}_query[\\s\\S]*?;\\n`).exec(migration)[0];
// Output column names of the outermost SELECT list: the alias, or the bare column name.
function viewColumns(sql){
 const list=/\n SELECT ([\s\S]*?)\n FROM public\./.exec(sql)[1];
 let depth=0,part='';const parts=[];
 for(const ch of list){if(ch==='(')depth++;if(ch===')')depth--;if(ch===','&&depth===0){parts.push(part);part='';}else part+=ch;}
 parts.push(part);
 return parts.map(p=>{p=p.trim();const alias=/\bAS\s+([a-z_]+)$/i.exec(p);return alias?alias[1]:p.split('.').pop();});
}

test('reorg datasets stay unpublished until the host rollout is verified',async()=>{
 const {cases,pendingCases}=require('../../v1/lib/ask-research-eval-cases');
 for(const id of ids){
  assert.equal(isPublished(id),false,id);assert.equal(isPublished(id,preview),true,id);
  assert.ok(!catalogueFor(true).some(d=>d.id===id));assert.ok(catalogueFor(true,preview).some(d=>d.id===id));
  await assert.rejects(compileResearchSQL({version:3,sql:`SELECT * FROM ${id}`,limit:1},{extended:true}),/not admitted/);
  assert.deepEqual((await compileResearchSQL({version:3,sql:`SELECT * FROM ${id}`,limit:1},{extended:true,...preview})).datasets,[id]);
  assert.ok(!coreGatedIds.includes(id),id);
 }
 assert.doesNotMatch(instructionsFor(true),/read reorgs|read orphaned_blocks/);
 assert.match(instructionsFor(true,preview),/read reorgs \(one row per detected reorg/);
 assert.match(instructionsFor(true,preview),/never report earlier absence as zero/);
 assert.match(instructionsFor(true,preview),/exclude canonical_now rows/);
 assert.deepEqual(pendingCases.map(c=>c.id).sort(),['orphan_rate_by_miner_2026_10','reorgs_2026_10']);
 assert.ok(!cases.some(c=>(c.requires||[]).some(id=>ids.includes(id))));
});

test('catalogue columns are exactly the view columns and semantics are stated',()=>{
 for(const id of ids){
  const entry=researchCatalogue.find(d=>d.id===id);
  assert.deepEqual(viewColumns(view(id)),entry.columns.split(', '),id);
  assert.ok(coreViews.includes(id+'_query'),id);
 }
 const text=id=>researchCatalogue.find(d=>d.id===id).description;
 for(const re of [/from 2026-07-17/,/no row is not proof that no reorg happened/,/not when the competing blocks were mined/,/reported_orphans/])assert.match(text('reorgs'),re);
 for(const re of [/canonical_now is true when a later reorg restored/,/orphaned blocks divided by canonical blocks plus orphaned blocks/,/not verified pool identities/])assert.match(text('orphaned_blocks'),re);
});

test('examples compile in preview; orphan rates exclude restored blocks',async()=>{
 const examples=sqlExamples.filter(e=>(e.datasets||[]).some(id=>ids.includes(id)));
 assert.deepEqual(examples.map(e=>e.id),['reorgs-weekly','orphan-rate-by-miner']);
 for(const example of examples){
  const compiled=await compileResearchSQL({version:3,sql:example.sql,limit:50},{extended:true,...preview});
  assert.deepEqual(compiled.datasets.slice().sort(),example.datasets.slice().sort(),example.id);
  assert.equal(displaySQL(compiled.request.sql).includes('analytics_public'),false);
 }
 assert.match(examples[1].sql,/AND NOT canonical_now/);
 for(const sql of ['WITH reorgs AS (SELECT 1) SELECT * FROM reorgs','SELECT * FROM public.fork_events','SELECT * FROM public.orphaned_blocks'])
  await assert.rejects(compileResearchSQL({version:3,sql,limit:1},{extended:true,...preview}));
});

test('migrations are guarded, additive and ordered destination before source',()=>{
 assert.match(migration,/^\\set ON_ERROR_STOP on\n/);assert.match(migration,/COMMIT;\n$/);
 assert.match(migration,/current_database\(\)<>'ask_analytics' OR pg_is_in_recovery\(\)/);
 assert.match(migration,/to_regclass\('analytics_public\.block_timing_query'\) IS NULL/);
 assert.doesNotMatch(migration,/\bDROP\b|\bDELETE FROM\b|\bTRUNCATE\b|\bUPDATE\b|\bALTER (?:TABLE|SUBSCRIPTION|PUBLICATION)\b/);
 assert.deepEqual(migration.match(/GRANT [^;]+;/g),['GRANT SELECT ON public.fork_events,public.orphaned_blocks TO ask_public_view_owner;','GRANT SELECT ON analytics_public.reorgs_query,analytics_public.orphaned_blocks_query TO ask_public_reader;']);
 for(const table of ['fork_events','orphaned_blocks']){
  const destination=new RegExp(`CREATE TABLE public\\.${table}\\((.*?)\\);`).exec(migration)[1].split(',').map(c=>c.trim().split(' ')[0]);
  const published=new RegExp(`public\\.${table}\\(([^)]*)\\)`).exec(/ADD TABLE ([^;]*);/.exec(source)[1])[1].split(',');
  assert.deepEqual(destination,published,table);
  assert.deepEqual(new RegExp(`GRANT SELECT\\(([^)]*)\\) ON public\\.${table} `).exec(source)[1].split(','),published,table);
 }
 // Free text, reporter, raw/header/coinbase hex, metadata and roots stay private.
 assert.doesNotMatch(/ADD TABLE[^;]*;/.exec(source)[0]+source.match(/GRANT [^;]+;/g).join(''),/description|source,|reported_by|raw_hex|coinbase|header_hex|metadata|root|difficulty|consensus_valid|resolved_at|first_indexed|previous_block_hash/);
 assert.match(source,/current_setting\('TimeZone'\)<>'Europe\/Berlin'/);
 assert.match(source,/Apply reorgs-v1\.sql on the analytics store FIRST/);
 assert.match(sourceRollback,/DROP TABLE public\.fork_events,public\.orphaned_blocks;/);
 assert.match(rollback,/EXISTS\(SELECT FROM pg_subscription_rel WHERE srrelid IN\('public\.fork_events'::regclass,'public\.orphaned_blocks'::regclass\)\)/);
 const admission=fs.readFileSync(path.join(__dirname,'../../scripts/ask-core-admission.js'),'utf8');
 assert.match(admission,/WHEN 'reorgs' THEN ARRAY\['public\.fork_events'\] WHEN 'orphaned_blocks' THEN ARRAY\['public\.orphaned_blocks'\]/);
 assert.match(admission,/'block_timing','reorgs','orphaned_blocks'\)/);
});

test('reorg views: Berlin detection times, stored orphan counts and restored hashes',{skip:process.env.ASK_EVAL_TEST_POSTGRES!=='1',timeout:60000},async t=>{
 const {execFileSync}=require('node:child_process'),{Client}=require('pg');
 const bin=process.env.ASK_LOGICAL_PG_BIN;assert.ok(bin&&path.isAbsolute(bin));
 const command=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],env:{PATH:bin+':/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'}});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-reorgs-')),data=path.join(root,'data'),socket=path.join(root,'socket');
 fs.mkdirSync(socket,{mode:0o700});let started=false,client;
 t.after(async()=>{try{await client?.end();}catch{/* cluster stop below */}if(started)command('pg_ctl',['-D',data,'-m','immediate','-w','stop']);fs.rmSync(root,{recursive:true,force:true});});
 command('initdb',['-D',data,'-U','fixture','-A','trust','--no-locale','--encoding=UTF8']);
 fs.appendFileSync(path.join(data,'postgresql.conf'),`\nlisten_addresses=''\nunix_socket_directories='${socket}'\nshared_buffers='16MB'\nfsync=off\n`);
 started=true;command('pg_ctl',['-D',data,'-l',path.join(root,'log'),'-w','start']);
 client=new Client({host:socket,user:'fixture',database:'postgres'});await client.connect();
 await client.query(`SET TIME ZONE 'UTC';CREATE SCHEMA analytics_public;
  CREATE TABLE public.blocks(height bigint PRIMARY KEY,hash text);
  CREATE TABLE public.fork_events(id integer PRIMARY KEY,fork_height bigint,depth integer,orphaned_count integer,detected_at timestamp);
  CREATE TABLE public.orphaned_blocks(id integer PRIMARY KEY,height bigint,hash text,canonical_hash text,timestamp bigint,transaction_count integer,size integer,miner_address text,fork_event_id integer,detected_at timestamp);
  CREATE VIEW analytics_public.coverage AS SELECT true AS ready,0::bigint AS covered_from,4000000::bigint AS covered_through;
  CREATE TABLE analytics_public.dataset_coverage(dataset text PRIMARY KEY,ready boolean);
  INSERT INTO analytics_public.dataset_coverage VALUES('reorgs',true),('orphaned_blocks',true);`);
 await client.query(view('reorgs')+view('orphaned_blocks'));
 // Berlin summer time (UTC+2) before 2026-10-25, winter time (UTC+1) after.
 await client.query(`INSERT INTO public.blocks VALUES(3500000,'win'),(3536784,'restored');
  INSERT INTO public.fork_events VALUES(1,3500000,1,1,'2026-09-01 12:00:00'),(2,3536784,2,3,'2026-10-31 08:01:40'),(3,4100000,1,1,'2026-10-31 09:00:00');
  INSERT INTO public.orphaned_blocks VALUES(10,3500000,'lost','win',1788000000,3,900,'t1a',1,'2026-09-01 12:00:00'),
   (11,3536784,'restored','other',1793430000,5,1200,'t1b',2,'2026-10-31 08:01:40'),
   (12,3536785,'lost2','other2',1793430075,2,800,'t1b',2,'2026-10-31 08:01:40')`);
 assert.deepEqual((await client.query('SELECT reorg_id,fork_height::int,depth,reported_orphans,orphans::int,detected_at::text FROM analytics_public.reorgs_query ORDER BY reorg_id')).rows,[
  {reorg_id:1,fork_height:3500000,depth:1,reported_orphans:1,orphans:1,detected_at:String(Date.UTC(2026,8,1,10)/1000)},
  {reorg_id:2,fork_height:3536784,depth:2,reported_orphans:3,orphans:2,detected_at:'1793430100'}]);
 assert.deepEqual((await client.query('SELECT hash,miner,reorg_id,detected_at::text,canonical_now FROM analytics_public.orphaned_blocks_query ORDER BY height')).rows,[
  {hash:'lost',miner:'t1a',reorg_id:1,detected_at:String(Date.UTC(2026,8,1,10)/1000),canonical_now:false},
  {hash:'restored',miner:'t1b',reorg_id:2,detected_at:'1793430100',canonical_now:true},
  {hash:'lost2',miner:'t1b',reorg_id:2,detected_at:'1793430100',canonical_now:false}]);
 await client.query("UPDATE analytics_public.dataset_coverage SET ready=false");
 for(const name of ids)assert.equal((await client.query(`SELECT count(*)::int AS n FROM analytics_public.${name}_query`)).rows[0].n,0,name);
});
