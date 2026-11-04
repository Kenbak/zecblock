'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {researchReply,researchFacts,researchTemplate,captionTask,checkedInterpretation,columnShapes,caveats}=require('../../v1/lib/ask-research-reply');
const metadata={truncated:false,fingerprint:'a'.repeat(64),retrievedAt:'2026-10-29T00:00:00Z',indexedThrough:'2026-10-29T00:00:00Z',coverage:'verified canonical records',units:'exact decimal strings'};
const research=(sql,columns,rows,extra={})=>({query:{version:3,sql,limit:100},columns:columns.map(([label,type],i)=>({key:'c'+i,label,type})),rows,datasets:['blocks'],...metadata,...extra});
const caption=summary=>async()=>({finding:summary});

// Observed on mainnet staging: last 1,000 blocks payout share. The model
// caption failed number checks and the reply fell back to a bare receipt.
// Only the top four of the real result's rows are known, so these rows cover
// 653 of the 1,000 blocks; share_pct is SQL's share of the whole window.
const payout=research("WITH recent AS (SELECT miner FROM blocks ORDER BY height DESC LIMIT 1000) SELECT miner,count(*) AS blocks,round(100.0*count(*)/sum(count(*)) OVER(),2) AS share_pct FROM recent GROUP BY miner ORDER BY blocks DESC",
 [['miner','text'],['blocks','number'],['share_pct','number']],
 [['t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7','285','28.50'],['t1SqwRAAdSig6dE4EBPLonAait219VmkUjP','172','17.20'],['t1PEp2GJLSdhDfCKqc2J211WKDUS1NfoQNy','145','14.50'],[null,'51','5.10']]);
const payoutTemplate='The first of 4 returned rows is t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7, with 285 blocks and share 28.5%, 1.66× the next row by blocks; the top three rows account for 60.2% of the total by share. Next are t1SqwRAAdSig6dE4EBPLonAait219VmkUjP (172 blocks) and t1PEp2GJLSdhDfCKqc2J211WKDUS1NfoQNy (145 blocks).';

test('payout share regression: a failed caption falls back to a readable fact template, never a bare receipt',async()=>{
 const before=structuredClone(payout);let calls=0;
 for(const summary of ['The leading payout address found 999 blocks.','The leader holds {{row_a_c}} of {{total_blocks}} blocks.','{{row_a_b}} {{row_a_c}} blocks.','The leader holds {{row_a_b}} ZEC.']){
  const reply=await researchReply(payout,{question:'Who received the most payouts in the last 1,000 blocks?'},async()=>{calls++;return {finding:summary};},'en');
  assert.equal(reply.answer,payoutTemplate,summary);assert.doesNotMatch(reply.answer,/Your query returned|table below/);
  assert.deepEqual(reply.research,before);assert.equal(reply.evidenceKey,before.fingerprint);assert.ok(reply.sources.length);
 }
 // One restatement per reply (the fixture repeats itself), then the template.
 assert.equal(calls,8);assert.deepEqual(payout,before);
});

test('payout share regression: a valid caption uses only checked facts and the column-label unit',async()=>{
 let seen;
 const reply=await researchReply(payout,{question:'Who received the most payouts?',history:[]},async(input,task)=>{
  seen=input;assert.equal(task.name,'research_caption');
  // Literal numbers are allowed by the schema and verified after writing.
  assert.equal(task.validator.safeParse({finding:'The leader found 285 blocks.'}).success,true);
  assert.equal(task.validator.safeParse({finding:'Ok.',observations:[]}).success,false);
  assert.equal(task.validator.safeParse({finding:'{{row_a_b}} blocks.',interpretation:'Top {{row_a_a}} may dominate.'}).success,false,'no placeholders in interpretation');
  return task.validator.parse({finding:'{{row_a_a}} leads with {{row_a_b}} blocks, {{ratio_b}} the runner-up, and the top three addresses produced {{top_three_share_c}} of all blocks in the window.',interpretation:'Payouts look concentrated in a handful of addresses, though payout addresses are not proven pool identities, so this may overstate or understate real pool concentration.'});
 },'en');
 assert.equal(reply.answer,'t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7 leads with 285 blocks, 1.66× the runner-up, and the top three addresses produced 60.2% of all blocks in the window. Payouts look concentrated in a handful of addresses, though payout addresses are not proven pool identities, so this may overstate or understate real pool concentration.');
 assert.deepEqual(seen.evidence.facts,{
  row_count:'4',
  row_a_a:'t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7',row_a_b:'285',row_a_c:'28.5%',
  row_b_a:'t1SqwRAAdSig6dE4EBPLonAait219VmkUjP',row_b_b:'172',row_b_c:'17.2%',
  row_c_a:'t1PEp2GJLSdhDfCKqc2J211WKDUS1NfoQNy',row_c_b:'145',row_c_c:'14.5%',
  max_b:'285',max_b_at:'t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7',min_b:'51',min_b_at:'null',
  max_c:'28.5%',max_c_at:'t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7',min_c:'5.1%',min_c_at:'null',
  // 285/172 exact then rounded; gap is 285-172. The top-three share sums
  // SQL's whole-window shares (28.5+17.2+14.5), not 602 of the 653 returned.
  ratio_b:'1.66×',gap_b:'113',top_three_share_c:'60.2%',
 });
 assert.match(seen.evidence.notes.top_three_share_c,/whole total computed in SQL/);
 assert.deepEqual(seen.evidence.caveats,['Block payout addresses are not proven mining pool, operator or company identities.']);
 assert.deepEqual(seen.evidence.columns.map(c=>c.unit),['unlabelled','unlabelled','percent']);
 assert.equal(seen.evidence.sql,payout.query.sql);
 // A percent fact already carries its unit; repeating it is de-duplicated.
 assert.equal((await researchReply(payout,{},caption('The leader holds {{row_a_c}} percent of payouts.'),'en')).answer,'The leader holds 28.5% of payouts.');
});

test('payout share regression: a rejected interpretation is dropped while the checked finding stays',async()=>{
 const finding='{{row_a_a}} leads with {{row_a_b}} blocks, {{ratio_b}} the runner-up.';
 const expected='t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7 leads with 285 blocks, 1.66× the runner-up.';
 for(const interpretation of [
  'Payouts look concentrated in 3 addresses.', // digit
  'This suggests Foundry controls most of the hashrate.', // unseen entity
  'Payouts are concentrated in a few addresses.', // no hedging
  'This suggests one mining pool controls most payouts.', // contradicts the payout-identity caveat
  'Concentration may make this a good time to buy ZEC.', // financial advice
  'This may reflect activity since September.', // month name
 ]){
  const reply=await researchReply(payout,{question:'Who received the most payouts?'},async()=>({finding,interpretation}),'en');
  assert.equal(reply.answer,expected,interpretation);
 }
 // A failed finding falls back to the template; a valid interpretation is kept.
 const fallback=await researchReply(payout,{question:'Who received the most payouts?'},async()=>({finding:'The leader found 999 blocks.',interpretation:'Payouts look concentrated, though payout addresses are not proven pool identities.'}),'en');
 assert.equal(fallback.answer,payoutTemplate+' Payouts look concentrated, though payout addresses are not proven pool identities.');
});

test('interpretation check: hedged, number-free, no unseen names, caveats respected',()=>{
 const applied=caveats.filter(caveat=>caveat.applies(payout));
 const vocabulary=new Set(['miner','blocks','share','pct','payouts']);
 const check=text=>checkedInterpretation(text,{vocabulary,applied});
 assert.equal(check('This looks like a concentrated payout set.'),'This looks like a concentrated payout set.');
 assert.equal(check('Payouts may cluster. Zcash miners could rotate addresses. A third sentence may be dropped.'),'Payouts may cluster. Zcash miners could rotate addresses.');
 for(const bad of ['Payouts cluster.','Viabtc may lead.','It may be ⅔ of payouts.','The operators may be few.','See https://example.com, it may help.','Payouts may cluster {{row_a_a}}.'])assert.equal(check(bad),null,bad);
 assert.equal(check('The operators behind these addresses are not proven, so concentration may be overstated.'),'The operators behind these addresses are not proven, so concentration may be overstated.');
});

test('top-three share is emitted only for additive non-negative measures, never balances, averages or windows',async()=>{
 const rows=[['orchard','400'],['sapling','300'],['sprout','200'],['ironwood','100']];
 const share=async(sql,label='amount',extra={})=>{const result=research(sql,[['pool','text'],[label,'number']],rows,{datasets:['flows'],...extra});return researchFacts(result,[],'en',await columnShapes(sql,result.columns)).facts.top_three_share_b;};
 assert.equal(await share('SELECT pool,sum(amount) AS amount FROM flows GROUP BY pool ORDER BY 2 DESC'),'90%');
 assert.equal(await share('SELECT pool,count(*) AS amount FROM flows GROUP BY pool ORDER BY 2 DESC'),'90%');
 assert.equal(await share('SELECT pool,round(sum(amount)::numeric/100000000,2) AS amount FROM flows GROUP BY pool ORDER BY 2 DESC'),'90%');
 assert.equal(await share('WITH t AS (SELECT pool,sum(amount) AS total FROM flows GROUP BY pool) SELECT pool,total FROM t ORDER BY total DESC','total'),'90%');
 // Balances (stocks), averages, extremes, windows and unresolved expressions are not additive.
 assert.equal(await share('SELECT date::text AS pool,orchard AS amount FROM daily ORDER BY orchard DESC'),undefined);
 assert.equal(await share('SELECT date::text AS pool,sum(orchard) AS amount FROM daily GROUP BY 1 ORDER BY 2 DESC'),undefined);
 assert.equal(await share('SELECT pool,avg(amount) AS amount FROM flows GROUP BY pool ORDER BY 2 DESC'),undefined);
 assert.equal(await share('SELECT pool,max(amount) AS amount FROM flows GROUP BY pool ORDER BY 2 DESC'),undefined);
 assert.equal(await share('SELECT pool,sum(amount) OVER(PARTITION BY pool) AS amount FROM flows'),undefined);
 assert.equal(await share('SELECT pool,sum(amount)-1 AS amount FROM flows GROUP BY pool'),undefined);
 assert.equal(await share('SELECT pool,100.0*sum(amount)/sum(sum(amount)) OVER() AS amount_pct FROM flows GROUP BY pool','amount_pct'),undefined);
 // Returned rows that are not the whole total never get a computed share:
 // a LIMIT on the groups (outer or inside a CTE), truncation, or unparsed SQL.
 assert.equal(await share('SELECT pool,sum(amount) AS amount FROM flows GROUP BY pool ORDER BY 2 DESC LIMIT 4'),undefined);
 assert.equal(await share('WITH t AS (SELECT pool,sum(amount) AS total FROM flows GROUP BY pool ORDER BY 2 DESC LIMIT 4) SELECT pool,total FROM t','total'),undefined);
 assert.equal(await share('SELECT pool,sum(amount) AS amount FROM flows GROUP BY pool ORDER BY 2 DESC','amount',{truncated:true}),undefined);
 assert.equal(researchFacts(research('x',[['pool','text'],['amount','number']],rows),[],'en').facts.top_three_share_b,undefined,'unknown shape is partial');
 // A LIMIT on the input rows, before grouping, still leaves the whole total.
 assert.equal(await share('WITH recent AS (SELECT pool,amount FROM flows ORDER BY id DESC LIMIT 1000) SELECT pool,sum(amount) AS amount FROM recent GROUP BY pool ORDER BY 2 DESC'),'90%');
 // The ratio still describes any ranked column; three rows have no top-three share.
 const three=research('SELECT pool,sum(amount) AS amount FROM flows GROUP BY pool',[['pool','text'],['amount','number']],rows.slice(0,3),{datasets:['flows']});
 const facts=researchFacts(three,[],'en',{additive:[false,true],shareOfTotal:[],partial:false}).facts;assert.equal(facts.ratio_b,'1.33×');assert.equal(facts.top_three_share_b,undefined);
});

test('a SQL share of the whole total is preferred, even when a LIMIT keeps only the top groups',async()=>{
 const sql='SELECT miner,count(*) AS blocks,round(100.0*count(*)/sum(count(*)) OVER(),2) AS share_pct FROM blocks GROUP BY miner ORDER BY blocks DESC LIMIT 4';
 const limited={...payout,query:{...payout.query,sql}};
 const shapes=await columnShapes(sql,limited.columns);
 assert.deepEqual(shapes,{additive:[false,true,false],shareOfTotal:[false,false,true],partial:true});
 const {facts}=researchFacts(limited,[],'en',shapes);
 assert.equal(facts.top_three_share_c,'60.2%');assert.equal(facts.top_three_share_b,undefined,'602 of 653 returned blocks would overstate concentration');
 // A percent column that is not a share of one total (e.g. per-row rates) is never summed.
 const rates={...limited,rows:limited.rows.map(row=>[row[0],row[1],'80'])};
 assert.equal(researchFacts(rates,[],'en',shapes).facts.top_three_share_c,undefined);
});

test('monthly fees time series: exact first-to-last change, percent change and largest step',async()=>{
 const sql="SELECT date_trunc('month',date)::date AS month,sum(fees) AS fees FROM activity_daily WHERE date>=DATE '2026-04-01' GROUP BY 1 ORDER BY 1";
 const result=research(sql,[['month','text'],['fees','number']],[['2026-04-01','61234500'],['2026-05-01','64410020'],['2026-06-01','70122375'],['2026-07-01','98877410'],['2026-08-01','93210001'],['2026-09-01','101554200']],{datasets:['activity_daily']});
 let seen;
 const reply=await researchReply(result,{question:'How did monthly fees change?'},async input=>{seen=input.evidence;return {finding:'Monthly fees {{direction_b}} from {{first_b}} in {{first_at}} to {{last_b}} in {{last_at}} ({{change_pct_b}}), with the largest jump of {{step_b}} arriving in {{step_b_to}}.',interpretation:'The jump suggests heavier usage rather than a one-off spike, since the higher level looks like it held afterwards.'};},'en');
 assert.equal(reply.answer,'Monthly fees increased from 61,234,500 zatoshis in April 2026 to 101,554,200 zatoshis in September 2026 (+65.8%), with the largest jump of +28,755,035 zatoshis arriving in July 2026. The jump suggests heavier usage rather than a one-off spike, since the higher level looks like it held afterwards.');
 assert.equal(seen.facts.change_b,'+40,319,700 zatoshis');assert.equal(seen.facts.step_b_from,'June 2026');
 assert.match(seen.notes.change_pct_b,/rounded/);assert.equal(seen.facts.ratio_b,undefined,'a time series is not a ranking');
 assert.deepEqual(seen.caveats,['Shielded component flags show which pools a transaction touches, not private amounts.']);
 // 65.8% is the change fact, so a literal copy is verified; an invented figure is not.
 assert.equal((await researchReply(result,{},async()=>({finding:'Fees rose 65.8%.'}),'en')).answer,'Fees rose 65.8%.');
 const fallback=await researchReply(result,{},async()=>({finding:'Fees rose 71.2%.'}),'en');
 assert.equal(fallback.answer,'Across 6 returned periods from April 2026 to September 2026, fees increased from 61,234,500 zatoshis to 101,554,200 zatoshis (+40,319,700 zatoshis, +65.8%). The largest single step was +28,755,035 zatoshis, from June 2026 to July 2026.');
 // Descending order reads chronologically; exact decimals do not drift.
 const drift=research('SELECT day,rate_pct',[['day','text'],['rate_pct','number']],[['2026-01-03','0.3'],['2026-01-02','0.2'],['2026-01-01','0.1']]);
 const facts=researchFacts(drift,[],'en').facts;
 assert.equal(facts.change_b,'+0.2 percentage points');assert.equal(facts.step_b,undefined,'tied steps name no single period');assert.equal(facts.change_pct_b,undefined,'no percent change of a percentage');
 assert.equal(facts.first_at,'Jan 1, 2026');
});

test('null counts are facts, and series skip incomplete columns',()=>{
 const result=research('SELECT day,n',[['day','text'],['n','number'],['m','number']],[['2026-01-01','1',null],['2026-01-02',null,'4'],['2026-01-03','3','5']]);
 const {facts}=researchFacts(result,[],'en');
 assert.equal(facts.nulls_b,'1');assert.equal(facts.nulls_c,'1');assert.equal(facts.change_b,undefined);assert.equal(facts.first_at,'Jan 1, 2026');
});

test('facts preserve NULL, skip NULL in extrema and never name a tied extreme',async()=>{
 const result=research('SELECT pool,amount FROM flows',[['pool','text'],['amount','number']],[[null,'10'],['orchard',null],['sapling','10'],['ironwood','3']]);
 const {facts}=researchFacts(result,[],'en');
 assert.equal(facts.row_a_a,'null');assert.equal(facts.row_b_b,'unavailable');
 assert.equal(facts.max_b,'10');assert.equal(facts.max_b_at,undefined,'tied maximum has no single row');
 assert.equal(facts.min_b,'3');assert.equal(facts.min_b_at,'ironwood');
 assert.equal(researchFacts(research('SELECT 1 AS n',[['n','number']],[['1']]),[],'en').facts.max_a,undefined,'one value has no range');
});

test('monetary units need SQL lineage; aliases alone never relabel zatoshis',async()=>{
 const one=(sql,label,value)=>research(sql,[[label,'number']],[[value]]);
 const fact=async result=>{let facts;await researchReply(result,{},async input=>{facts=input.evidence.facts;return {finding:'x'};},'en');return facts.row_a_a;};
 assert.equal(await fact(one('SELECT avg(fees) AS average_fee FROM blocks','average_fee','225510.400')),'225,510.4 zatoshis');
 assert.equal(await fact(one('SELECT avg(fees)::numeric/100000000 AS fee_zec FROM blocks','fee_zec','0.002255104')),'0.002255104 ZEC');
 assert.equal(await fact(one('SELECT avg(fees) AS fee_zec FROM blocks','fee_zec','225510.4')),'225,510.4','contradicting alias stays unlabelled');
 assert.equal(await fact(one('SELECT sqrt(avg(fees)) AS fee_zec FROM blocks','fee_zec','474.9')),'474.9','unproven lineage stays unlabelled');
 assert.equal(await fact(one('SELECT count(*) AS n_usd FROM blocks','n_usd','4')),'4');
});

test('dates: strict UTC-midnight wires become readable; a month-labelled first-day column names the month',async()=>{
 const day='2026-01-31',formatted=new Date(day+'T00:00:00Z').toLocaleDateString('en',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'});
 for(const wire of [day,day+' 00:00:00',day+'T00:00:00Z',day+' 00:00:00+00:00'])assert.equal(researchFacts(research('SELECT d',[['d','text'],['n','number']],[[wire,'1']]),[],'en').facts.row_a_a,formatted,wire);
 for(const wire of [day+' 00:00:01',day+'T01:00:00Z','2026-02-30','2026-13-01 00:00:00',day+' sample label'])assert.equal(researchFacts(research('SELECT d',[['d','text'],['n','number']],[[wire,'1']]),[],'en').facts.row_a_a,wire,wire);
 const monthly=research('SELECT month',[['month','text'],['n','number']],[['2025-09-01','1'],['2025-10-01 00:00:00+00','2']]);
 assert.equal(researchFacts(monthly,[],'en').facts.row_b_a,'October 2025');
 assert.equal(researchFacts(monthly,[],'fr').facts.row_a_a,'septembre 2025');
 // A month label over a non-first day is an observation date, not a month.
 assert.match(researchFacts({...monthly,rows:[['2025-09-03','1']]},[],'en').facts.row_a_a,/3/);
 assert.match(researchFacts({...monthly,columns:[{key:'c0',label:'day',type:'text'},monthly.columns[1]]},[],'en').facts.row_a_a,/Sep 1, 2025/);
});

test('findings reject unsupported numbers, calendar names, tables and invented placeholders after one restatement',async()=>{
 const result=research('SELECT date,shielded_transactions FROM activity_daily ORDER BY date',[['date','text'],['shielded_transactions','number']],[['2025-09-01','17451'],['2025-10-01','53175']]);
 const template=researchTemplate(result,researchFacts(result,[],'en'));
 assert.equal(template,'Across 2 returned periods from Sep 1, 2025 to Oct 1, 2025, shielded transactions increased from 17,451 to 53,175 (+35,724, +204.7%).');
 for(const summary of ['March had the most shielded transactions at {{max_b}}.','Shielded transactions grew by 36,000.','Shielded transactions grew by 35,724 ZEC.','The leader was t{{row_a_a}} at {{max_b}}.','The peak was in Q three of two thousand twenty-five at {{max_b}}.','The peak was {{max_b}} on Oct ₂₉.','The peak was {{max_b}} in October October.','The peak was {{max_b}} in October , early on.','The peak 以 was {{max_b}}.','Date | Count\n{{row_a_a}} | {{row_a_b}}','The peak was {{row_z_b}}.','The peak was {{max_b}}','No figure is cited here.']){
  let calls=0;
  const reply=await researchReply(result,{question:'Explain'},async()=>{calls++;return {finding:summary};},'en');
  assert.equal(calls,2);assert.equal(reply.answer,template,summary);
 }
 assert.equal((await researchReply(result,{},caption('The peak of {{max_b}} came on {{max_b_at}}.'),'en')).answer,'The peak of 53,175 came on Oct 1, 2025.');
 assert.equal((await researchReply(result,{},caption('The peak came in Oct {{max_b_at}} at {{max_b}}.'),'en')).answer,template,'a word doubled by its fact');
 // A month the result itself contains may be named; its day and year still come from facts.
 assert.equal((await researchReply(result,{},caption('October had the most shielded transactions at {{max_b}}.'),'en')).answer,'October had the most shielded transactions at 53,175.');
 assert.equal((await researchReply(result,{},caption('Shielded transactions reached ≈≈{{max_b}}, approximately ≈{{max_b}} in October.'),'en')).answer,'Shielded transactions reached ≈53,175, approximately 53,175 in October.');
});

test('template covers single rows, unlabelled numeric results and truncation',()=>{
 const single=research('SELECT count(*) AS total FROM transactions',[['total','number']],[['542746']]);
 assert.equal(researchTemplate(single,researchFacts(single,[],'en')),'The result has total 542,746.');
 const heights=research('SELECT height FROM blocks',[['height','number']],[['100'],['101']],{truncated:true});
 assert.equal(researchTemplate(heights,researchFacts(heights,[],'en')),'The first of 2 returned rows (truncated at the query limit) has height 100. Across all returned rows, height ranges from 100 to 101.');
 const labels=research('SELECT pool FROM flows',[['pool','text']],[['orchard'],['sapling']]);
 assert.equal(researchTemplate(labels,researchFacts(labels,[],'en')),'The first of 2 returned rows is orchard. It is followed by sapling.');
});

test('evidence stays bounded for wide and long results',async()=>{
 const wide=research('SELECT *',Array.from({length:24},(_,i)=>['measure_'+i,'text']),Array.from({length:200},()=>Array(24).fill('x'.repeat(2048))));
 let size=0;await researchReply(wide,{},async input=>{size=Buffer.byteLength(JSON.stringify(input.evidence));return {finding:'{{row_a_a}}.'};},'en');
 assert.ok(size<12000,String(size));
 assert.deepEqual(Object.keys(captionTask(researchFacts(wide,[],'en').facts).schema.properties),['finding','interpretation']);
});

test('empty results and a wholly wrong requested year never call the model',async()=>{
 const empty=await researchReply(research('SELECT height FROM blocks',[['height','number']],[]),{},()=>assert.fail('no paid caption'),'fr');
 assert.match(empty.answer,/does not establish zero activity/);
 const months=research("SELECT date_trunc('month',date) AS month,sum(transactions) FROM activity_daily GROUP BY 1",[['month','text'],['n','number']],[['2020-01-01','1']]);
 await assert.rejects(researchReply(months,{question:'Monthly counts during 2025'},()=>assert.fail('wrong year'),'en'),e=>e.askKind==='answer');
});

test('prose rounds long ZEC amounts with ≈ while plain values stay exact', async () => {
  const { researchReply } = require('../../v1/lib/ask-research-reply');
  const { compileResearchSQL } = require('../../v1/lib/ask-research-sql');
  const compiled = await compileResearchSQL({ version: 3, sql: "SELECT date_trunc('week', to_timestamp(timestamp)) AS week, sum(amount)::numeric / 100000000 AS shielded_zec, count(*) AS records FROM flows WHERE direction = 'shield' GROUP BY 1 ORDER BY 2 DESC", limit: 100 });
  const result = { query: compiled.request, columns: [{ key: 'c0', label: 'week', type: 'text' }, { key: 'c1', label: 'shielded_zec', type: 'number' }, { key: 'c2', label: 'records', type: 'number' }], rows: [['2026-08-17 00:00:00+00', '397255.85355764', '4365'], ['2026-08-24 00:00:00+00', '0.61701300000000000000', '7']], truncated: false, datasets: ['flows'], fingerprint: compiled.fingerprint, retrievedAt: '2026-10-29T00:00:00Z', indexedThrough: '2026-10-29T00:00:00Z', coverage: 'source-defined coverage', units: 'zatoshis' };
  const reply = await researchReply(result, { question: 'Which week shielded the most?' }, async () => ({ finding: 'The top week shielded {{row_a_b}} across {{row_a_c}} records; the next shielded {{row_b_b}}.' }), 'en');
  assert.equal(reply.answer.split('\n')[0], 'The top week shielded ≈397,255.85 ZEC across 4,365 records; the next shielded 0.617013 ZEC.');
});

test('earlier-versus-later comparisons read as plain from-to changes over the queried windows', async () => {
  const { parse } = require('pgsql-parser');
  const { windowFacts, checkedCaption } = require('../../v1/lib/ask-research-reply');
  const labels = ['previous_orchard_share_percent','previous_orchard_transactions','previous_transactions','recent_orchard_share_percent','recent_orchard_transactions','recent_transactions','share_change_percentage_points'];
  const sql = "SELECT 1 FROM transactions WHERE timestamp >= EXTRACT(EPOCH FROM '2026-10-15'::date)::bigint AND timestamp < EXTRACT(EPOCH FROM '2026-10-22'::date)::bigint OR timestamp >= EXTRACT(EPOCH FROM '2026-10-22'::date)::bigint AND timestamp < EXTRACT(EPOCH FROM '2026-10-29'::date)::bigint";
  const result = { query: { version: 3, sql, limit: 100 }, columns: labels.map((label, i) => ({ key: 'c' + i, label, type: 'number' })), rows: [['1.15','526','45876','0.46','343','74339','-0.69']], truncated: false, datasets: ['transactions'], fingerprint: 'a'.repeat(64), retrievedAt: '2026-10-29T13:00:00.000Z', indexedThrough: '2026-10-29T13:00:00.000Z', coverage: 'verified canonical records', units: 'x' };
  const evidence = researchFacts(result, [], 'en', {});
  Object.assign(evidence.facts, windowFacts(await parse(sql), 'en').facts);
  assert.equal(evidence.facts.row_a_g, '-0.69 percentage points');
  assert.equal(evidence.facts.shift_d, '-0.69 percentage points');
  assert.equal(evidence.facts.size_pct_e, '34.8%');
  assert.deepEqual([evidence.facts.earlier_window, evidence.facts.later_window, evidence.facts.window_length], ['Oct 15 – Oct 21, 2026', 'Oct 22 – Oct 28, 2026', '7 days']);
  assert.equal(researchTemplate(result, evidence), 'Orchard share fell from 1.15% (Oct 15 – Oct 21, 2026) to 0.46% (Oct 22 – Oct 28, 2026), down 0.69 percentage points. Over the same periods, orchard transactions fell from 526 to 343, down 34.8%.');
  const numeric = new Set(Object.keys(evidence.facts).filter(id => /\d/.test(evidence.facts[id]) && !/–/.test(evidence.facts[id])));
  // The natural model phrasing that previously failed the unit check now passes.
  assert.equal(checkedCaption("Orchard's share fell by {{size_d}} between {{earlier_window}} and {{later_window}}.", evidence.facts, numeric), "Orchard's share fell by 0.69 percentage points between Oct 15 – Oct 21, 2026 and Oct 22 – Oct 28, 2026.");
  assert.equal(checkedCaption("Orchard's share moved {{row_a_g}}.", evidence.facts, numeric), "Orchard's share moved -0.69 percentage points.");
  assert.equal(checkedCaption("Orchard's share fell {{shift_d}} percent.", evidence.facts, numeric), null);
  // Inclusive or open-ended date filters give no window fact rather than a guess.
  assert.deepEqual(windowFacts(await parse("SELECT 1 FROM t WHERE d <= '2026-10-29' AND d >= '2026-10-01'"), 'en').facts, {});
});

test('two rows labelled previous and last period compare as periods, not as a ranking', async () => {
  const { parse } = require('pgsql-parser');
  const { windowFacts, checkedCaption } = require('../../v1/lib/ask-research-reply');
  // Staging 2026-10-29: the template said "1.62× the next row", the ratio of all transactions, beside the share.
  const sql = "WITH period_totals AS (SELECT CASE WHEN timestamp >= CAST(EXTRACT(EPOCH FROM '2026-10-22'::date) AS bigint) THEN 'last_7_days' ELSE 'previous_7_days' END AS period, count(*) FILTER (WHERE orchard) AS orchard_transactions, count(*) AS all_transactions FROM transactions WHERE timestamp >= CAST(EXTRACT(EPOCH FROM '2026-10-15'::date) AS bigint) AND timestamp < CAST(EXTRACT(EPOCH FROM '2026-10-29'::date) AS bigint) GROUP BY 1) SELECT period, orchard_transactions, all_transactions, round(100.0 * orchard_transactions / NULLIF(all_transactions, 0), 2) AS orchard_share_percent FROM period_totals ORDER BY period";
  const columns = [{ key: 'c0', label: 'period', type: 'text' }, ...['orchard_transactions', 'all_transactions', 'orchard_share_percent'].map((label, i) => ({ key: 'c' + (i + 1), label, type: 'number' }))];
  const result = { query: { version: 3, sql, limit: 100 }, columns, rows: [['last_7_days', '343', '74339', '0.46'], ['previous_7_days', '526', '45876', '1.15']], truncated: false, datasets: ['transactions'], fingerprint: 'a'.repeat(64), retrievedAt: '2026-10-29T13:00:00.000Z', indexedThrough: '2026-10-29T13:00:00.000Z', coverage: 'verified canonical records', units: 'x' };
  const evidence = researchFacts(result, [], 'en', {});
  Object.assign(evidence.facts, windowFacts(await parse(sql), 'en').facts);
  assert.equal(evidence.facts.ratio_c, undefined);
  assert.equal(evidence.facts.shift_d, '-0.69 percentage points');
  assert.equal(evidence.facts.size_pct_c, '62%');
  assert.equal(researchTemplate(result, evidence), 'Orchard share fell from 1.15% (Oct 15 – Oct 21, 2026) to 0.46% (Oct 22 – Oct 28, 2026), down 0.69 percentage points. Over the same periods, orchard transactions fell from 526 to 343, down 34.8%.');
  const reasons = [];
  assert.equal(checkedCaption('Orchard share fell over the last 7 days.', evidence.facts, new Set(), 'en', reason => reasons.push(reason)), null);
  assert.equal(checkedCaption('Orchard share fell over the last {{row_count}} weeks in 7 days.', evidence.facts, new Set(['row_count']), 'en', reason => reasons.push(reason)), null);
  assert.deepEqual(reasons, ['no_fact', 'unchecked_number']);
});

test('the caption call proposes a chart that is checked against the result; a malformed proposal keeps the finding',async()=>{
 const daily=research("SELECT date, round(orchard::numeric/100000000,2) AS orchard_zec, round(sapling::numeric/100000000,2) AS sapling_zec FROM daily WHERE date >= DATE '2026-10-01' ORDER BY date",
  [['date','text'],['orchard_zec','number'],['sapling_zec','number']],[['2026-10-01','377567.18','5000.00'],['2026-10-02','377450.63','5001.00'],['2026-10-03','377352.25','5002.00']],{datasets:['daily']});
 let task;
 const chosen=await researchReply(daily,{question:'How did Orchard change?'},async(input,t)=>{task=t;return {finding:'Orchard ended at {{last_b}}.',interpretation:'',chart:{view:'line',value:'b',extra:['c'],stacked:true,highlight:'change'}};},'en');
 assert.deepEqual(Object.keys(task.schema.properties),['finding','interpretation','chart']);
 assert.deepEqual(task.schema.properties.chart.properties.value.enum,['b','c']);
 // Lines are never stacked; the label column is chosen by the server.
 assert.deepEqual(chosen.chart,{view:'line',x:0,y:1,series:[2],highlight:'change'});
 for(const chart of [{view:'pie',value:'b',extra:[],stacked:false,highlight:'none'},{view:'bar',value:'a',extra:[],stacked:false,highlight:'none'},'draw it nicely',undefined]){
  const reply=await researchReply(daily,{question:'How did Orchard change?'},async()=>({finding:'Orchard ended at {{last_b}}.',interpretation:'',chart}),'en');
  assert.match(reply.answer,/^Orchard ended at /);assert.deepEqual(reply.chart,{view:'area',x:0,y:1,highlight:'latest'});
 }
});

test('a window that crosses a year names both years; a direction word drops its matching sign and rejects a contradicting one',async()=>{
 const {windowFacts,checkedCaption}=require('../../v1/lib/ask-research-reply');
 const {parse}=require('pgsql-parser');
 const facts=sql=>parse(sql).then(tree=>windowFacts(tree,'en').facts.window);
 assert.equal(await facts("SELECT 1 FROM blocks WHERE day >= DATE '2025-10-01' AND day < DATE '2026-10-01'"),'Oct 1, 2025 – Sep 30, 2026');
 assert.equal(await facts("SELECT 1 FROM blocks WHERE day >= DATE '2026-10-22' AND day < DATE '2026-10-29'"),'Oct 22 – Oct 28, 2026');
 const values={change_c:'≈-56.1 ZEC',change_b:'+173,330'},numeric=new Set(Object.keys(values));
 assert.equal(checkedCaption('Fees decreased by {{change_c}} while transactions increased by {{change_b}}.',values,numeric),'Fees decreased by ≈56.1 ZEC while transactions increased by 173,330.');
 let reason;assert.equal(checkedCaption('Fees rose by {{change_c}}.',values,numeric,'en',r=>{reason=r;}),null);assert.equal(reason,'signed_direction');
 assert.equal(checkedCaption('Fees changed by {{change_c}}.',values,numeric),'Fees changed by ≈-56.1 ZEC.');
});

test('a fact ID the model wrote without braces renders its checked value; a stray combining mark before it is dropped',()=>{
 const {renderExplanation}=require('../../v1/lib/ask-explanation');
 const facts={start_date:'Sep 29, 2026',end_date:'Oct 29, 2026'};
 // Observed on production: "over the ◌̷start_date to 2026-10-29 observation window".
 assert.equal(renderExplanation({summary:'Orchard fell over the ̷start_date to {{end_date}} observation window.',observations:[],limitation:''},facts).summary,'Orchard fell over the Sep 29, 2026 to Oct 29, 2026 observation window.');
 assert.throws(()=>renderExplanation({summary:'Orchard was 343 ZEC.',observations:[],limitation:''},facts),/Unvalidated/);
});

test('a latest period still running past the indexed data is named to date and left out of extremes and changes',async()=>{
 const {windowFacts}=require('../../v1/lib/ask-research-reply');
 const {parse}=require('pgsql-parser');
 // Observed on production 2026-10-29: Nov 2025 – Oct 2026 with October incomplete
 // read "transactions decreased by 55.9%" and "Nov 1, 2025 – Oct 31, 2026".
 const sql="SELECT date_trunc('month', block_time) AS month, count(*) AS transactions FROM transactions WHERE block_time >= DATE '2025-11-01' AND block_time < DATE '2026-11-01' GROUP BY 1 ORDER BY 1";
 const monthly=research(sql,[['month','text'],['transactions','number']],[['2025-11-01 00:00:00+00','473577'],['2026-09-01 00:00:00+00','363162'],['2026-10-01 00:00:00+00','208680']],{datasets:['transactions'],indexedThrough:'2026-10-29T22:55:02Z'});
 const {facts,notes}=researchFacts(monthly,[],'en');
 assert.equal(facts.partial_at,'October 2026');assert.equal(facts.partial_through,'Oct 29, 2026');assert.match(notes.partial_at,/incomplete/);
 assert.equal(facts.last_at,'September 2026');assert.equal(facts.min_b,'363,162');assert.equal(facts.min_b_at,'September 2026');
 assert.equal(facts.change_pct_b,'-23.3%');
 const windows=windowFacts(await parse(sql),'en','2026-10-29T22:55:02Z').facts;
 assert.equal(windows.window,'Nov 1, 2025 – Oct 29, 2026 (to date)');assert.equal(windows.window_length,undefined);
 // Complete periods are untouched.
 const done=researchFacts({...monthly,indexedThrough:'2026-11-01T00:00:00Z'},[],'en').facts;
 assert.equal(done.partial_at,undefined);assert.equal(done.last_at,'October 2026');
});

test('coverage that ends exactly at midnight ends on the day before',async()=>{
 const {windowFacts}=require('../../v1/lib/ask-research-reply');
 const {parse}=require('pgsql-parser');
 // activity_daily reports source_through 2026-10-29T00:00Z: complete through Oct 28.
 const sql="SELECT date_trunc('month', date) AS month, sum(transactions) AS transactions FROM activity_daily WHERE date >= DATE '2025-11-01' AND date < DATE '2026-11-01' GROUP BY 1 ORDER BY 1";
 const monthly=research(sql,[['month','text'],['transactions','number']],[['2025-11-01','473577'],['2026-09-01','363162'],['2026-10-01','208680']],{datasets:['activity_daily'],indexedThrough:'2026-10-29T00:00:00Z'});
 assert.equal(researchFacts(monthly,[],'en').facts.partial_through,'Oct 28, 2026');
 assert.equal(windowFacts(await parse(sql),'en','2026-10-29T00:00:00Z').facts.window,'Nov 1, 2025 – Oct 28, 2026 (to date)');
 assert.equal(windowFacts(await parse(sql),'en','2026-10-29T22:55:02Z').facts.window,'Nov 1, 2025 – Oct 29, 2026 (to date)');
});

test('free-written findings: every number is verified against the evidence after writing',async()=>{
 const result=research('SELECT miner,count(*) AS blocks,round(sum(fees)::numeric/100000000,8) AS fees_zec FROM blocks GROUP BY 1 ORDER BY 2 DESC',[['miner','text'],['blocks','number'],['fees_zec','number']],[['t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7','285','0.00026773555385216982'],['t1SqwRAAdSig6dE4EBPLonAait219VmkUjP','172','0.0003']]);
 const ok=async summary=>(await researchReply(result,{question:'Who mined the most blocks in the last 1,000 blocks?'},caption(summary),'en')).answer;
 // Copied values, display rounding, identifiers from the result and numbers from the question pass.
 assert.equal(await ok('t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7 mined 285 blocks, ahead of 172.'),'t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7 mined 285 blocks, ahead of 172.');
 assert.equal(await ok('The leader mined 285 of the last 1,000 blocks.'),'The leader mined 285 of the last 1,000 blocks.');
 assert.equal(await ok('The leader mined 285 blocks, {{ratio_b}} the runner-up.'),'The leader mined 285 blocks, 1.66× the runner-up.');
 // 113 is the server's gap fact (285 - 172), so it is verified too.
 assert.equal(await ok('The leader mined 113 more blocks than the runner-up.'),'The leader mined 113 more blocks than the runner-up.');
 // An invented figure, a self-computed difference or an unseen identifier does not.
 for(const summary of ['The leader mined 300 blocks.','Together the top two mined 457 blocks.','t1Fake00000000000000000000000000000 mined 285 blocks.','The leader mined 285 blocks worth 285 ZEC.'])
  assert.match(await ok(summary),/^The first of 2 returned rows is t1MKn34K/,summary);
 // A failed finding is restated once with the reason and the figure; a corrected one is used.
 const seen=[];
 const reply=await researchReply(result,{question:'Who mined the most?'},async input=>{seen.push(input.rejectedFinding||null);return {finding:seen.length===1?'The leader mined 300 blocks.':'The leader mined 285 blocks.'};},'en');
 assert.equal(reply.answer,'The leader mined 285 blocks.');
 assert.deepEqual(seen[1],{text:'The leader mined 300 blocks.',reason:'unsupported_number',unsupportedFigure:'300'});
});
