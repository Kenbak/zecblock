'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {gradeReply}=require('../../v1/lib/ask-research-eval');
const {cases}=require('../../v1/lib/ask-research-eval-cases');
const {formatChain}=require('../../../../lib/ask/data');
const when='2026-10-28T00:00:00Z';
const fieldType=role=>['date','month','text'].includes(role)?'text':role==='boolean'?'boolean':'number';
function result(rows,roles){return {query:{version:3,sql:'SELECT count(*) FROM blocks',limit:100},columns:roles.map((role,i)=>({key:'c'+i,label:'checked_'+i,type:fieldType(role)})),rows,truncated:false,datasets:['blocks'],fingerprint:'a'.repeat(64),retrievedAt:when,indexedThrough:when,coverage:'fixed operator fixture',units:'exact decimal strings'};}
function grade(item,rows,answer,observed=rows){const candidate=result(observed,item.roles),verification=result([...rows.map(row=>['reference',...row]),...observed.map(row=>['candidate',...row])],['text',...item.roles]);return gradeReply(item,{mode:'ai',answer,research:candidate},verification);}
const summer=cases.find(item=>item.id==='monthly_change_2026_summer');
const summerRows=[['2026-06-01',null,'42369',null,null],['2026-07-01','42369','43287','918','2.17'],['2026-08-01','43287','65548','22261','51.43']];
const summerAnswer='The shielded count rose by 22,261 from 43,287 in Jul 1, 2026 to 65,548 in Aug 1, 2026, a 51.43% increase. Chronologically: Jun 1, 2026 had no preceding in-range baseline and a current count of 42,369; Jul 1, 2026 had a preceding count of 42,369, current count of 43,287, signed change of 918 and percent change of 2.17%; Aug 1, 2026 had a preceding count of 43,287, current count of 65,548, signed change of 22,261 and percent change of 51.43%.';
const swaps=cases.find(item=>item.id==='swap_known_usd_rank');
const swapRows=[['eth','7640','67164165.404122879465','0'],['btc','1452','29377455.307957106106','0'],['sol','7139','21762193.338557663872','0']];
const swapAnswer='Ethereum leads the ranked chains in known reported USD subtotal, at 67,164,165.404122879465, across 7,640 tracked successful inflow swaps; none had missing valuations (0). This is the known-valued subtotal for tracked swaps, not all ZEC exchange volume. Covers indexed successful swaps from supported integrations; broader exchange activity and independent historical completeness are not established.';
const blocks=cases.find(item=>item.id==='bounded_block_transaction_join');
const blockRows=[['3500000','12','11'],['3500001','21','20'],['3500002','2','1'],['3500003','14','13'],['3500004','4','3'],['3500005','1','0'],['3500006','1','0'],['3500007','20','19'],['3500008','2','1'],['3500009','13','12'],['3500010','10','9'],['3500011','9','8'],['3500012','2','1'],['3500013','13','12'],['3500014','1','0'],['3500015','1','0'],['3500016','14','13'],['3500017','7','6'],['3500018','10','9'],['3500019','16','15']];
const blockAnswer='The largest matching observed non-coinbase transaction count is 20, at height 3,500,001; that block’s count including coinbase is 21. The requested twenty rows are shown in the result table in ascending height order, with both counts compared for each block.';

test('correct dated baseline endpoints are associated using the declared baseline row',()=>{
 const good=grade(summer,summerRows,summerAnswer);assert.equal(good.passed,true);assert.deepEqual(good.dimensions,{result:'passed',narrative:'passed',expectedOutcome:'not-applicable'});
 for(const answer of [summerAnswer.split('. Chronologically:')[0]+'.','Shielded transactions increased from 43,287 transactions on July 1, 2026 to 65,548 transactions on August 1, 2026, a change of 22,261 transactions or 51.43%.'])assert.equal(grade(summer,summerRows,answer).passed,true,answer);
 const unspecified={...summer,answerCheck:{...summer.answerCheck,baseRow:undefined}};
 assert.equal(grade(unspecified,summerRows,summerAnswer).passed,false,'baseline dates require an explicit reviewed association');
 assert.equal(grade({...summer,answerCheck:{...summer.answerCheck,baseRow:0}},summerRows,summerAnswer).passed,false);
});

test('dated endpoint support keeps direction, value, unit, key and denominator checks',()=>{
 const leading=summerAnswer.split('. Chronologically:')[0]+'.';
 for(const answer of [leading.replace('rose','fell'),leading.replace('22,261','22,260'),leading.replace('43,287','43,288'),leading.replace('65,548','65,549'),leading.replace('51.43%','51.42%'),leading.replace('Jul 1, 2026','Jun 1, 2026'),leading.replace('Aug 1, 2026','Jul 1, 2026'),leading.replace('Jul 1, 2026','Aug 1, 2026').replace('to 65,548 in Aug','to 65,548 in Jul'),leading.replace('43,287 in','43,287 USD in'),leading.replace('65,548 in','65,548 ZEC in'),leading.replace('51.43% increase','51.43% of all transactions'),leading.replace('a 51.43% increase','a 51.43% increase in June 2026')]){
  const outcome=grade(summer,summerRows,answer);assert.equal(outcome.passed,false,answer);assert.equal(outcome.dimensions.result,'passed',answer);assert.equal(outcome.dimensions.narrative,'failed',answer);
 }
});

test('only the baseline endpoint mention is exempted from competing-date attribution',()=>{
 const stem='The shielded count rose by 22,261 from 43,287 in July 1, 2026 to 65,548 in August 1, 2026, a 51.43% increase';
 for(const ending of [' in July 2026.',' in June 2026.',' on July 1, 2026.',' on June 1, 2026.']){
  const outcome=grade(summer,summerRows,stem+ending);assert.equal(outcome.passed,false,ending);assert.equal(outcome.dimensions.result,'passed');assert.equal(outcome.dimensions.narrative,'failed');assert.equal(outcome.diagnostics.reason,'change-key-association-unresolved');
 }
 for(const ending of ['.',' in August 2026.',' on August 1, 2026.'])assert.equal(grade(summer,summerRows,stem+ending).passed,true,ending);
 const prefix='In July 2026, the shielded count rose by 22,261 from 43,287 in July 1, 2026 to 65,548 in August 1, 2026, a 51.43% increase.';
 assert.equal(grade(summer,summerRows,prefix).passed,false);
});

test('declared chain names and unit-bearing subtotal subjects accept unchanged valid prose',()=>{
 assert.equal(formatChain('eth'),'Ethereum');assert.ok(swaps.answerCheck.keyAliases[0].eth.includes(formatChain('eth')));
 const good=grade(swaps,swapRows,swapAnswer);assert.equal(good.passed,true);assert.equal(good.dimensions.result,'passed');assert.equal(good.dimensions.narrative,'passed');
 assert.equal(grade(swaps,swapRows,swapAnswer.replace('Ethereum','ETH')).passed,true);
 assert.equal(grade({...swaps,answerCheck:{...swaps.answerCheck,unitInSubject:false}},swapRows,swapAnswer).passed,false,'the currency-in-subject convention is explicitly opted in');
 assert.equal(grade({...swaps,answerCheck:{...swaps.answerCheck,keyAliases:undefined}},swapRows,swapAnswer).passed,false,'no model-created or guessed chain alias');
});

test('chain aliases never waive wrong leader, monetary units, exact amount or contradictory key claims',()=>{
 for(const answer of [swapAnswer.replace('Ethereum','Bitcoin'),swapAnswer.replace('Ethereum','Solana'),swapAnswer.replace('Ethereum','Ether'),swapAnswer.replace('Ethereum leads','Ethereum lost to Bitcoin, which leads'),swapAnswer.replace('67164165.404122879465','67164165.404122879466').replace('67,164,165.404122879465','67,164,165.404122879466'),swapAnswer.replace('at 67,164,165.404122879465,','at 67,164,165.404122879465 ZEC,'),swapAnswer.replace('at 67,164,165.404122879465,','at 67,164,165.404122879465 BTC,'),swapAnswer.replace('at 67,164,165.404122879465,','at 67,164,165.404122879465 EUR,'),swapAnswer.replace('known reported USD subtotal','known reported ZEC subtotal'),swapAnswer.replace('leads','has the lowest value'),swapAnswer.replace('67,164,165.404122879465','6,7164,165.404122879465')]){
  const outcome=grade(swaps,swapRows,answer);assert.equal(outcome.passed,false,answer);assert.equal(outcome.dimensions.result,'passed');
 }
});

test('punctuation commas and formatted heights preserve the non-coinbase count association',()=>{
 const good=grade(blocks,blockRows,blockAnswer);assert.equal(good.passed,true);assert.equal(good.dimensions.result,'passed');assert.equal(good.dimensions.narrative,'passed');
 assert.equal(grade(blocks,blockRows,blockAnswer.replace('3,500,001','3500001')).passed,true);
});

test('the coinbase-inclusive count, wrong block and wrong units remain failed findings',()=>{
 for(const answer of [blockAnswer.replace('count is 20,','count is 21,'),blockAnswer.replace('3,500,001','3,500,002'),blockAnswer.replace('count is 20,','count is 20 USD,'),blockAnswer.replace('count is 20,','count is 20 bytes,'),blockAnswer.replace('count is 20,','count is 20 records,'),blockAnswer.replace('count is 20,','count is 20%,'),blockAnswer.replace('largest','smallest'),blockAnswer.replace('20, at','20, or in fact 21, at')])assert.equal(grade(blocks,blockRows,answer).passed,false,answer);
});

test('ordinary punctuation after exact decimals is distinct from malformed digit grouping',()=>{
 const item={id:'fixed_unit_fixture',kind:'research',roles:['usd'],minRows:1,maxRows:1,resultCheck:{keyColumns:[],ordered:false},answerCheck:{type:'value',row:0,column:0,subject:'known USD subtotal',unit:'USD',unitInSubject:true}};
 for(const answer of ['The known USD subtotal is 12,345.67, with other observations reported separately.','The known USD subtotal was 12,345.67 USD, with other observations reported separately.'])assert.equal(grade(item,[['12345.67']],answer).passed,true,answer);
 for(const answer of ['The known USD subtotal is 12,345.6701, with other observations reported separately.','The known USD subtotal is 1,2345.67, with other observations reported separately.','The known USD subtotal is 12,345.67 ZEC, with other observations reported separately.'])assert.equal(grade(item,[['12345.67']],answer).passed,false,answer);
});

test('the independently observed annual model error remains a failed finding',()=>{
 const item=cases.find(value=>value.id==='annual_2025'),fixture=require('../fixtures/ask-monthly-change-2025.json'),rows=fixture.rows.map(row=>[row[0],row[1],row[2],row[4],row[5]]);
 const wrong='Shielded counts peaked in 2025-11-01 00:00:00 at 63,100 transactions, while transparent counts peaked that month at 410,477; the shielded share was 13.32%. The three-month rolling average of shielded transactions reached 52,099 in 2025-12-01 00:00:00. The largest absolute month-to-month change was a decrease of 23,078 shielded transactions in 2025-12-01 00:00:00 versus 63,100 the previous month.';
 const outcome=grade(item,rows,wrong);assert.equal(outcome.passed,false);assert.equal(outcome.dimensions.result,'passed');assert.equal(outcome.dimensions.narrative,'failed');
});


const flowItem=cases.find(item=>item.id==='flow_pool_direction_totals');
// Fixed DOM-observed cells for a finding-only control. They do not certify the
// original SQL's rounded amounts against the independent full-precision oracle.
const flowRows=[['ironwood','shield','52523','451317.22','0'],['ironwood','deshield','48429','346280.28','0'],['sapling','shield','3145','45802.27','0'],['sapling','deshield','2252','55579.24','0'],['orchard','deshield','1162','7416.24','0'],['mixed','deshield','287','6595.63','0'],['mixed','shield','9','245.15','0']];
const flowAnswer='Ironwood shielding had the most public boundary records, at 52,523, with 451,317.22 ZEC in total. Ironwood deshielding followed with 48,429 records and 346,280.28 ZEC; both directions report 0 missing amounts. Flow-history completeness is unverified.';
const independent=cases.find(item=>item.id==='independent_flow_swap_baselines');
const independentRows=[['2026-09-03','29917.948929150000','6016271.548450247945','18908.5375539657140000','2149912.052704096097','949','0','0'],['2026-09-16','9866.9332726800000000','3779378.368955595656','7015.9067292700000000','2781554.359519001036','864','0','0'],['2026-09-17','36813.406369060000','9584743.672472445365','7050.5243050857142857','2850886.158448825219','1126','0','0'],['2026-09-18','16011.1569258300000000','7264447.920965382576','11067.1606311542857143','3501171.971176248520','1330','0','0'],['2026-09-19','17711.8134635600000000','6171150.096531739602','12049.7862627900000000','4211373.414958780399','1200','0','0'],['2026-09-29','17513.8120922200000000','10364642.325895396767','11404.5570541842857143','4373857.810737065650','903','0','0'],['2026-09-30','22619.592866320000','11887622.483949866099','12320.2102722542860000','5113287.997284926199','812','0','0']];
const independentAnswer='The qualifying day with the greatest public deshielding was Sep 17, 2026: 36,813.40636906 ZEC deshielded and 9,584,743.672472445365 USD in tracked outflows, above preceding seven-observation averages of 7,050.5243050857142857 ZEC and 2,850,886.158448825219 USD. It had 1,126 outflow swaps, with 0 missing flow amounts and 0 missing USD values; this concurrence does not establish causation.';

test('a greatest public deshielding leader retains its correct mixed-metric wording',()=>{
 const good=grade(independent,independentRows,independentAnswer);assert.equal(good.passed,true);assert.equal(good.dimensions.result,'passed');assert.equal(good.dimensions.narrative,'passed');
 const together='The qualifying day with the greatest public deshielding was Sep 17, 2026: 36,813.40636906 ZEC, with 9,584,743.672472445365 USD in tracked outflows.';
 const mixed=grade(independent,independentRows,together);assert.equal(mixed.passed,false);assert.equal(mixed.dimensions.result,'passed');assert.equal(mixed.diagnostics.stage,'narrative-manual-review','mixed units in one unsplit finding remain conservatively unverified');
 for(const wrong of [together.replace('36,813.40636906 ZEC','36,813.40636906 USD'),together.replace('36,813.40636906 ZEC','36,813.40636906 records'),together.replace('36,813.40636906 ZEC','9,584,743.672472445365 ZEC'),together.replace('Sep 17','Sep 16'),together.replace('greatest','smallest'),together.replace('9,584,743.672472445365 USD','9,584,743.672472445365 ZEC'),together.replace('9,584,743.672472445365 USD','7,050.5243050857142857 ZEC'),together.replace('9,584,743.672472445365 USD','2,850,886.158448825219 USD'),together.replace('in tracked outflows','in treasury assets')])assert.equal(grade(independent,independentRows,wrong).passed,false,wrong);
});

test('simple count findings pass while mixed-measure clauses remain manually reviewed',()=>{
 const finding=grade(flowItem,flowRows,flowAnswer);assert.equal(finding.passed,false);assert.equal(finding.dimensions.result,'passed');assert.equal(finding.dimensions.narrative,'failed');assert.equal(finding.diagnostics.stage,'narrative-manual-review');
 assert.equal(grade(flowItem,flowRows,'Ironwood shielding had the most public boundary records, at 52,523.').passed,true);
 for(const wrong of [flowAnswer.replace('52,523,','52,523 ZEC,'),flowAnswer.replace('52,523,','52,523 USD,'),flowAnswer.replace('52,523,','451,317.22,'),flowAnswer.replace('52,523,','52,524,'),flowAnswer.replace('Ironwood shielding had','Orchard shielding had'),flowAnswer.replace('Ironwood shielding had','Ironwood deshielding had'),flowAnswer.replace('451,317.22 ZEC','451,317.22 records'),flowAnswer.replace('451,317.22 ZEC','346,280.28 ZEC'),flowAnswer.replace('451,317.22 ZEC in total','451,317.22 ZEC in fees')])assert.equal(grade(flowItem,flowRows,wrong).passed,false,wrong);
});

test('accepting a count finding cannot waive a result-cell precision mismatch',()=>{
 const observed=structuredClone(flowRows);observed[0][3]='451317.22000001';
 const mismatch=grade(flowItem,flowRows,'Ironwood shielding had the most public boundary records, at 52,523.',observed);assert.equal(mismatch.passed,false);assert.equal(mismatch.dimensions.result,'failed');assert.equal(mismatch.dimensions.narrative,'passed');assert.ok(mismatch.checks.includes('measures-or-window-mismatch'));
});

test('USD named subjects reject punctuation-hidden denomination changes',()=>{
 for(const suffix of [', EUR.',', in EUR.',', as ZEC.',', records.',', %.']){
  const answer='Ethereum leads the known reported USD subtotal, at 67,164,165.404122879465'+suffix;
  assert.equal(grade(swaps,swapRows,answer).passed,false,suffix);
 }
 assert.equal(grade(swaps,swapRows,'Ethereum leads the known reported USD subtotal, at 67,164,165.404122879465.').passed,true);
});


test('unresolved mixed-measure tails cannot hide negation, unavailability or denomination changes',()=>{
 const stem='Ironwood shielding had the most public boundary records, at 52,523, with 451,317.22 ZEC in total';
 for(const ending of [', but that total is unavailable.',', but not 451,317.22 ZEC in total.',', in EUR.',', but the total was 0 ZEC.']){
  const outcome=grade(flowItem,flowRows,stem+ending);assert.equal(outcome.passed,false,ending);assert.equal(outcome.dimensions.result,'passed');assert.equal(outcome.dimensions.narrative,'failed');assert.equal(outcome.diagnostics.stage,'narrative-manual-review');
 }
});
