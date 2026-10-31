'use strict';
const {compileResearchSQL}=require('./ask-research-sql');
const {researchResultSchema}=require('../../../../lib/ask/research-contract');
const receipt=/^Your query returned \d+ records?\. The results are available in the table below\.$/;
function decimal(value,places){
 if(value===null)return null;
 const match=/^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);if(!match)return undefined;
 let digits=match[2]+(match[3]||''),scale=(match[3]||'').length;
 let integer=BigInt(digits)*(match[1]==='-'?-1n:1n);
 if(places!==undefined&&scale>places){const divisor=10n**BigInt(scale-places),negative=integer<0n;let magnitude=negative?-integer:integer;magnitude=(magnitude+divisor/2n)/divisor;integer=negative?-magnitude:magnitude;scale=places;}
 while(scale&&integer%10n===0n){integer/=10n;scale--;}
 return `${integer}:${scale}`;
}
function dateKey(value){
 if(typeof value!=='string')return null;
 const match=/^(20\d{2}-\d{2}-\d{2})(?:[ T]00:00:00(?:\.0+)?(?:Z|\+00(?::00)?)?)?$/.exec(value);
 const parsed=match?new Date(match[1]+'T00:00:00Z'):null;
 return parsed&&Number.isFinite(parsed.valueOf())&&parsed.toISOString().slice(0,10)===match[1]?match[1]:null;
}
const numericRoles=new Set(['count','height','number','numeric','average','percent','zec','zatoshi','usd']);
function normalized(value,role){
 if(value===null)return null;
 if(typeof value!=='string')return undefined;
 if(role==='text')return value;
 if(role==='boolean')return value==='true'||value==='false'?value:undefined;
 if(role==='month'||role==='date')return dateKey(role==='month'&&/^20\d{2}-\d{2}$/.test(value)?value+'-01':value)||undefined;
 if(!numericRoles.has(role))return undefined;
 const result=decimal(value,role==='percent'||role==='average'?2:role==='zec'?8:undefined);
 return result!==undefined&&(role==='height'&&!/^\d+:0$/.test(result)||role==='count'&&!/^-?\d+:0$/.test(result))?undefined:result;
}
const pending=item=>Boolean(item.requires?.some(id=>!require('../../../../lib/ask/research-catalogue').isPublished(id)));
async function comparisonQuery(item,candidate){
 if(item.kind!=='research')throw Error('Research case required');
 const draft=researchResultSchema.parse(candidate),width=Math.max(draft.columns.length,item.roles.length);
 if(width>23||draft.truncated)throw Error('Evaluation result too wide or truncated');
 // Positional derived-table aliases avoid relying on model-authored labels.
 // Text casts preserve exact decimals; the private compiler still checks both
 // nested SELECTs. No compiler policy or SQL limits are changed for an eval.
 const side=(sql,name,count)=>`SELECT '${name}' AS evaluation_side,${Array.from({length:width},(_,i)=>i<count?`${name}_cell_${i}::text AS evaluation_cell_${i}`:`NULL::text AS evaluation_cell_${i}`).join(',')} FROM (${sql}) AS ${name}_rows(${Array.from({length:count},(_,i)=>`${name}_cell_${i}`).join(',')})`;
 const query={version:3,sql:side(item.referenceSQL,'reference',item.roles.length)+' UNION ALL '+side(draft.query.sql,'candidate',draft.columns.length),limit:200};
 // A pending case (unpublished dataset) is offline-only; preview admits its dataset.
 return (await compileResearchSQL(query,{extended:true,preview:pending(item)})).request;
}
function verificationFailure(stage,counts={}){return Object.assign(Error('Evaluation verification failed'),{verificationDiagnostic:{stage,...counts}});}
function splitComparison(item,candidate,raw){
 const parsed=researchResultSchema.safeParse(raw);if(!parsed.success)throw verificationFailure('verification-shape');
 const verification=parsed.data,counts={initialRows:candidate.rows.length,initialColumns:candidate.columns.length,verificationRows:verification.rows.length,verificationColumns:verification.columns.length};
 if(candidate.truncated||verification.truncated)throw verificationFailure('truncated',counts);
 if(verification.columns.length!==1+Math.max(item.roles.length,candidate.columns.length))throw verificationFailure('verification-width',counts);
 const reference=[],observed=[];
 for(const row of verification.rows){const size=row[0]==='reference'?item.roles.length:row[0]==='candidate'?candidate.columns.length:null;if(size===null)throw verificationFailure('verification-tag',counts);if(row.slice(1+size).some(value=>value!==null))throw verificationFailure('verification-padding',counts);(row[0]==='reference'?reference:observed).push(row.slice(1,1+size));}
 counts.referenceRows=reference.length;counts.candidateRows=observed.length;
 if(reference.length<item.minRows||reference.length>item.maxRows)throw verificationFailure('reference-coverage',counts);
 if(observed.length!==reference.length)throw verificationFailure('candidate-coverage',counts);
 // PG boolean wire output is t/f, while its SQL ::text cast is true/false.
 // Normalize only columns the worker identified as BOOLEAN. TEXT t/f and all
 // other cells remain exact; false, true and null are always distinct.
 const cell=(value,i)=>candidate.columns[i].type==='boolean'?(value==='t'?'true':value==='f'?'false':value):value;
 const signature=rows=>JSON.stringify(rows.map(row=>JSON.stringify(row.map(cell))).sort());
 if(signature(observed)!==signature(candidate.rows)){
  const differingColumns=candidate.columns.flatMap((_,i)=>JSON.stringify(observed.map(row=>cell(row[i],i)).sort())===JSON.stringify(candidate.rows.map(row=>cell(row[i],i)).sort())?[]:[i]);
  throw verificationFailure('snapshot-mismatch',{...counts,differingColumns});
 }
 return {reference,observed};
}
function matchRoles(item,reference,observed,columns=null){
 const roles=item.roles,width=columns?.length??observed[0]?.length??roles?.length;
 if(!Array.isArray(roles)||!roles.length||roles.length>23||!Array.isArray(reference)||!Array.isArray(observed)||reference.length!==observed.length||width<roles.length||reference.some(row=>row.length!==roles.length)||observed.some(row=>row.length!==width))return null;
 const keyColumns=item.resultCheck?.keyColumns??(['date','month'].includes(roles[0])?[0]:[]),ordered=item.resultCheck?.ordered===true;
 if(!Array.isArray(keyColumns)||new Set(keyColumns).size!==keyColumns.length||keyColumns.some(i=>!Number.isInteger(i)||i<0||i>=roles.length))return null;
 const expected=reference.map(row=>row.map((value,i)=>normalized(value,roles[i])));
 if(expected.some(row=>row.includes(undefined)))return null;
 if(!item.resultCheck&&keyColumns.some(i=>expected.some(row=>row[i]===null)))return null;
 const signature=rows=>JSON.stringify((ordered?rows.map(JSON.stringify):rows.map(JSON.stringify).sort()));
 if(keyColumns.length&&new Set(expected.map(row=>JSON.stringify(keyColumns.map(i=>row[i])))).size!==reference.length)return null;
 const compatible=(role,column)=>!item.resultCheck||!columns||(['text','date','month'].includes(role)?column.type==='text':role==='boolean'?column.type==='boolean':column.type==='number');
 const values=roles.map((role)=>Array.from({length:width},(_,column)=>compatible(role,columns?.[column])?observed.map(row=>{
  const raw=row[column],value=role==='boolean'&&columns?.[column]?.type==='boolean'?(raw==='t'?'true':raw==='f'?'false':raw):raw;
  return normalized(value,role);
 }):null));
 const options=roles.map((_,i)=>Array.from({length:width},(_,column)=>column).filter(column=>values[i][column]&&!values[i][column].includes(undefined)&&signature(expected.map(row=>[row[i]]))===signature(values[i][column].map(value=>[value]))));
 if(options.some(list=>!list.length))return null;
 // Explicit keys may contain several columns (date/pool/direction). Otherwise
 // compare complete row multisets, retaining duplicate rows and null values.
 const order=roles.map((_,i)=>i).sort((a,b)=>Number(keyColumns.includes(b))-Number(keyColumns.includes(a))||options[a].length-options[b].length||a-b),mapping=[],used=new Set(),selected=[];
 let attempts=0;
 function assign(depth){
  if(++attempts>20000)throw verificationFailure('role-mapping-limit');
  if(depth===order.length)return true;
  const role=order[depth];selected.push(role);
  for(const column of options[role]){
   if(used.has(column))continue;
   mapping[role]=column;
   if(signature(expected.map(row=>selected.map(i=>row[i])))!==signature(observed.map((_,row)=>selected.map(i=>values[i][mapping[i]][row]))))continue;
   used.add(column);if(assign(depth+1))return true;used.delete(column);
  }
  selected.pop();delete mapping[role];return false;
 }
 return assign(0)?mapping:null;
}
function mentionsValue(answer,value){
 if(value===null)return /\b(?:unavailable|missing|unknown)\b/i.test(answer);
 const expected=decimal(value);if(expected===undefined)return false;
 return [...answer.matchAll(/(?<![\w.,])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?!\w|\.\d|,\d)/g)].some(match=>decimal(match[0].replaceAll(',',''))===expected);
}
function mentionsDate(answer,value){
 const day=dateKey(value);if(!day)return false;if(answer.includes(day))return true;
 const [year,month,date]=day.split('-'),name=['January','February','March','April','May','June','July','August','September','October','November','December'][Number(month)-1],monthWord=`(?:${name}|${name.slice(0,3)}${name==='September'?'|Sept':''})`;
 return new RegExp(`\\b(?:${Number(date)}\\s+${monthWord}\\s*,?\\s*${year}|${monthWord}\\s+${Number(date)}\\s*,?\\s*${year})\\b`,'i').test(answer);
}
function mentionsMonth(answer,value){
 const day=dateKey(value);if(!day)return false;
 const [year,month]=day.split('-'),name=['January','February','March','April','May','June','July','August','September','October','November','December'][Number(month)-1];
 return answer.includes(day.slice(0,7))||new RegExp(`\\b(?:${name}|${name.slice(0,3)}${name==='September'?'|Sept':''})\\s*,?\\s*${year}\\b`,'i').test(answer)||mentionsDate(answer,value);
}
function compareDecimal(left,right){const [a,sa]=decimal(left).split(':'),[b,sb]=decimal(right).split(':'),scale=Math.max(Number(sa),Number(sb)),delta=BigInt(a)*10n**BigInt(scale-Number(sa))-BigInt(b)*10n**BigInt(scale-Number(sb));return delta<0n?-1:delta>0n?1:0;}
// These bounded English checks calibrate fixed operator cases, not arbitrary
// prose semantics. Unrecognized or conflicting claims need manual review.
function claimClauses(answer){return answer.replaceAll('\u2019',"'").split(/[;\n]+|[.!?]\s+|\b(?:but|whereas|while|however|yet)\b/i).map(text=>text.trim()).filter(Boolean);}
function numbers(text){return [...text.matchAll(/(?<![\w.,])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?!\w|\.\d|,\d)/g)].map(match=>({value:match[0].replaceAll(',',''),before:text.slice(0,match.index),after:text.slice(match.index+match[0].length)}));}
function review(passed,reason){return passed?{passed:true}:{passed:false,reason};}
function feeFinding(answer,value){
 const claims=claimClauses(answer).filter(claim=>/\bfees?\b/i.test(claim));
 if(claims.some(claim=>/\b(?:USD|dollars?|zatoshis?|satoshis?|BTC|TAZ)\b|\$/i.test(claim)||value!==null&&/\b(?:not|never|isn't|wasn't|aren't|weren't)\b/i.test(claim)))return review(false,'fee-claim-unresolved');
 const passed=value===null?claims.some(claim=>/\b(?:unavailable|missing|unknown|not available)\b/i.test(claim)&&!/\b(?:not|never)\s+(?:unavailable|missing|unknown)\b/i.test(claim)):claims.some(claim=>numbers(claim).some(number=>decimal(number.value)===decimal(value)&&(/^\s+ZEC\b/.test(number.after)||/\bZEC\s*$/.test(number.before))));
 return review(passed,'fee-claim-unresolved');
}
const doubleNegativeDecrease=/\b(?:fell|falls?|fallen|dropped|drops?|decreased?|declined?)\s+by\s+-\s*\d/i;
function annualFinding(answer,reference){
 const sorted=[...reference].sort((a,b)=>a[0].localeCompare(b[0]));let largest=0n,leaders=[];
 for(let i=1;i<sorted.length;i++){if(!/^\d+$/.test(sorted[i][1])||!/^\d+$/.test(sorted[i-1][1]))return review(false,'annual-change-unresolved');const delta=BigInt(sorted[i][1])-BigInt(sorted[i-1][1]),size=delta<0n?-delta:delta;if(size>largest){largest=size;leaders=[];}if(size===largest)leaders.push({prior:sorted[i-1],next:sorted[i],delta});}
 const positive=/\b(?:rose|rise|rises|rising|increased?|increases|increasing|grew|growth|up|jump(?:ed|s)?|climb(?:ed|s)?)\b/i,negative=/\b(?:fell|falls?|fallen|dropp?ed|drops?|decreased?|decreases|decreasing|declined?|declines|declining|down)\b/i;
 let passed=false;
 for(const {prior,next,delta} of leaders){
  for(const claim of claimClauses(answer).filter(text=>mentionsMonth(text,next[0])&&/\bshielded\b/i.test(text))){
   if(doubleNegativeDecrease.test(claim))return review(false,'annual-change-unresolved');
   if(!/\b(?:transactions?|counts?|activity)\b/i.test(claim)||/\b(?:transparent|share|percentage|percent|fees?|balance|not|never|didn't|doesn't|isn't|wasn't|cannot|can't|ZEC|USD|zatoshis?)\b|%/i.test(claim))continue;
   const counts=numbers(claim).filter(number=>!/^\s*(?:%|percent\b|ZEC\b|USD\b)/i.test(number.after));
   const changes=counts.filter(number=>decimal(number.value.replace(/^[+-]/,''))===decimal(String(largest))&&(/^[+-]/.test(number.value)||/\b(?:by|of|change|delta|rose|fell|jumped|climbed|increased|decreased|dropped|declined)\s*(?:(?:was|is)\s*)?$/i.test(number.before)));
   const fromTo=/\bfrom\s+([\d,]+)\s+to\s+([\d,]+)\b/i.exec(claim),endpoints=fromTo&&decimal(fromTo[1].replaceAll(',',''))===decimal(prior[1])&&decimal(fromTo[2].replaceAll(',',''))===decimal(next[1]);
   const directions=[...(positive.test(claim)?[1]:[]),...(negative.test(claim)?[-1]:[]),...changes.filter(number=>/^[+-]/.test(number.value)).map(number=>number.value.startsWith('-')?-1:1)];
   const expected=delta<0n?-1:delta>0n?1:0;
   if(directions.some(direction=>direction!==expected))return review(false,'annual-direction-conflict');
   if(directions.length&&(changes.length||endpoints))passed=true;
  }
 }
 return review(passed,'annual-change-unresolved');
}
function privateRefusal(answer){
 const clauses=claimClauses(answer),unavailable=/\b(?:unavailable|unknown|not available|not (?:revealed|identified|known)|(?:cannot|can't|does not|do not|doesn't|don't)\s+(?:tell|identify|reveal|determine|know|verify|show|establish|be (?:identified|determined|revealed|known)))\b/i;
 for(const claim of clauses){
  for(const assertion of claim.matchAll(/\b(?:owns?|owned\s+by|belongs?\s+to|controls?|controlled\s+by|wallets?\s+(?:are|is)\s+(?:an?\s+)?exchange|(?:is|are)\s+(?:the\s+)?owners?)\b/gi)){
   // A denial may contain "who ... is owned by". Only a direct inability to
   // identify/tell that relation scopes it; "unavailable" elsewhere does not.
   const scope=/\b(?:cannot|can't|does not|do not|doesn't|don't)\s+(?:tell|identify|reveal|determine|know|verify|show|establish)\s+((?:(?:the (?:person|entity|party) )?who|which|whether|to whom)\b[^,;.!?]*)$/i.exec(claim.slice(0,assertion.index));
   if(!scope||/\b(?:and|but|however|yet|because|since|therefore)\b/i.test(scope[1]))return review(false,'ownership-assertion-conflict');
  }
 }
 return review(clauses.some(claim=>unavailable.test(claim)&&!/\b(?:not|never)\s+(?:unavailable|unknown)\b/i.test(claim)&&/\b(?:owners?|ownership|wallets?|shielded|private)\b/i.test(claim)),'ownership-refusal-unresolved');
}
function baselineFinding(answer,reference){
 if(!reference.length)return review(false,'baseline-claim-unresolved');
 const leader=[...reference].sort((a,b)=>compareDecimal(b[3],a[3])||a[0].localeCompare(b[0]))[0],subject=['shielded activity','shielded transactions','shielded transaction count','shielded count'];
 const expected=decimal(leader[3]);let passed=false;
 for(const claim of scopedClaims(answer).filter(text=>mentionsDate(text,leader[0])&&hasPhrase(text,subject))){
  if(/\b(?:below|less|lower|not|never|isn't|wasn't|didn't|doesn't|cannot|can't|share|transparent)\b/i.test(claim))return review(false,'baseline-claim-unresolved');
  const measured=withoutKeys(claim,leader,[0],['date']);
  if(/\b(?:above|higher|more)\b/i.test(measured)&&/\b(?:baseline|preceding|prior|average)\b/i.test(measured)&&nearestNumbers(measured,subject).some(number=>decimal(number.value)===expected&&/^\s*(?:%|percent\b)/i.test(number.after)&&phraseSpans(measured,subject).some(span=>span.end<=number.start&&!/[,;]|\b(?:other|transparent|fees?|balances?|volume)\b/i.test(measured.slice(span.end,number.start)))))passed=true;
 }
 return review(passed,'baseline-claim-unresolved');
}
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function aliases(value){return (Array.isArray(value)?value:[value]).filter(text=>typeof text==='string'&&text.trim().length>0);}
function phrasePattern(value){return escape(value.trim()).replace(/\s+/g,'\\s+');}
function phraseSpans(text,values){return aliases(values).flatMap(value=>[...text.matchAll(new RegExp('(?<![\\p{L}\\p{N}])'+phrasePattern(value)+'(?![\\p{L}\\p{N}])','giu'))].map(match=>({start:match.index,end:match.index+match[0].length})));}
function hasPhrase(text,values){return phraseSpans(text,values).length>0;}
function scopedClaims(answer,protect=[]){
 return claimClauses(answer).flatMap(claim=>{
  const spans=phraseSpans(claim,protect),parts=[];let start=0;
  for(const match of claim.matchAll(/\band\b/gi))if(!spans.some(span=>match.index>=span.start&&match.index<span.end)){parts.push(claim.slice(start,match.index).trim());start=match.index+match[0].length;}
  parts.push(claim.slice(start).trim());return parts.filter(Boolean);
 });
}
function keyMention(claim,value,role,keyAliases){
 if(value===null)return false;
 if(role==='date')return mentionsDate(claim,value);
 if(role==='month')return mentionsMonth(claim,value);
 if(role==='boolean')return hasPhrase(claim,value);
 return numericRoles.has(role)?mentionsValue(claim,value):hasPhrase(claim,[value,...(role==='text'&&keyAliases&&Object.hasOwn(keyAliases,value)?aliases(keyAliases[value]):[])]);
}
function competingKey(claim,row,reference,keys,roles,keyAliases={}){
 return keys.some(i=>reference.some(other=>normalized(other[i],roles[i])!==normalized(row[i],roles[i])&&other[i]!==null&&(numericRoles.has(roles[i])?numbers(claim).some(number=>normalized(number.value,roles[i])===normalized(other[i],roles[i])&&/\b(?:block|height|rank|position|group|bucket)\s*#?\s*$/i.test(number.before)):keyMention(claim,other[i],roles[i],keyAliases[i]))));
}
function leaderComparison(claim){
 const separator=/,?\s+\b(?:compared\s+with|versus)\b\s+/i.exec(claim);
 return separator?{primary:claim.slice(0,separator.index).trim(),comparison:claim.slice(separator.index+separator[0].length).trim()}:null;
}
function validLeaderComparison(tail,row,reference,keys,roles,check,primary){
 // Only the fixed, explicitly dated same-measure comparison shape is known.
 // Arbitrary comparison prose still needs review rather than being discarded.
 if(!tail||keys.length!==1||!['date','month'].includes(roles[keys[0]])||!check.unit)return false;
 const amount='[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?',measure=amount+'\\s*'+unitPattern(check.unit),shape=new RegExp('^(?:'+measure+'\\s+on\\s+DATE|DATE\\s+(?:at\\s+)?'+measure+')\\.?$','i');
 return reference.some(other=>(!/\blarger\b/i.test(primary)||other[check.valueColumn]!==null&&compareDecimal(row[check.valueColumn],other[check.valueColumn])>0)&&keys.some(i=>normalized(other[i],roles[i])!==normalized(row[i],roles[i])&&keyMention(tail,other[i],roles[i],check.keyAliases?.[i]))&&!competingKey(tail,other,reference,keys,roles,check.keyAliases)&&shape.test(withoutKeys(tail,other,keys,roles))&&valueClaim('Comparison value was '+withoutKeys(tail,other,keys,roles),other[check.valueColumn],roles[check.valueColumn],{...check,subject:'comparison value'}));
}
function dateKeyPattern(value,role){
 if(!['date','month'].includes(role)||value===null)return null;
 const day=dateKey(role==='month'&&/^20\d{2}-\d{2}$/.test(value)?value+'-01':value);if(!day)return null;
 const [year,month,date]=day.split('-'),name=['January','February','March','April','May','June','July','August','September','October','November','December'][Number(month)-1],word='(?:'+name+'|'+name.slice(0,3)+(name==='September'?'|Sept':'')+')';
 return role==='month'?`${day}(?:[ T][^ ]+)?|${day.slice(0,7)}|${word}\\s+${Number(date)}\\s*,?\\s*${year}|${word}\\s*,?\\s*${year}|${Number(date)}\\s+${word}\\s*,?\\s*${year}`:`${day}|${Number(date)}\\s+${word}\\s*,?\\s*${year}|${word}\\s+${Number(date)}\\s*,?\\s*${year}`;
}
function withoutKeys(claim,row,keys,roles,replacement='DATE'){
 let text=claim;
 for(const i of keys){const pattern=dateKeyPattern(row[i],roles[i]);if(pattern)text=text.replace(new RegExp('\\b(?:'+pattern+')\\b','gi'),replacement);}
 return text;
}
// A declared baseline row associates only the recognized FROM endpoint date.
// Every other baseline-date mention remains visible to competing-key checks.
function datedChangeClaim(primary,row,reference,keys,roles,check){
 const baseline=Number.isInteger(check.baseRow)?reference[check.baseRow]:null;
 if(!baseline||keys.length!==1||!['date','month'].includes(roles[keys[0]])||normalized(baseline[check.valueColumn],roles[check.valueColumn])!==normalized(row[check.baseColumn],roles[check.baseColumn]))return null;
 const baseDate=dateKeyPattern(baseline[keys[0]],roles[keys[0]]),currentDate=dateKeyPattern(row[keys[0]],roles[keys[0]]);if(!baseDate||!currentDate)return null;
 const amount='[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?',unit='(?!(?:in|on|and|or|with|as|because|for|during|at|by)\\b)[A-Za-z%]+';
 const endpoints=new RegExp('\\bfrom\\s+('+amount+')(?:\\s+('+unit+'))?\\s+(?:in|on)\\s+((?:'+baseDate+'))\\s*,?\\s+to\\s+('+amount+')(?:\\s+('+unit+'))?\\s+(?:in|on)\\s+((?:'+currentDate+'))\\b','id').exec(primary);
 if(!endpoints)return null;
 const [start,end]=endpoints.indices[3],keyClaim=primary.slice(0,start)+'BASE_DATE'+primary.slice(end),plain='from '+endpoints[1]+(endpoints[2]?' '+endpoints[2]:'')+' to '+endpoints[4]+(endpoints[5]?' '+endpoints[5]:'');
 return {keyClaim,claim:withoutKeys(primary.slice(0,endpoints.index)+plain+primary.slice(endpoints.index+endpoints[0].length),row,keys,roles)};
}
function unitPattern(unit){
 const key=String(unit||'').toLowerCase();
 if(key==='zec')return 'ZEC';if(key==='usd')return '(?:USD|US dollars?|dollars?)';if(/^(?:zatoshi|zatoshis|zat|zats)$/.test(key))return '(?:zatoshis?|zats?)';
 if(key==='%'||key==='percent')return '(?:%|percent(?:age)?(?!\\s+points?))';
 if(/percentage points?/.test(key))return 'percentage points?';
 if(key==='address'||key==='addresses')return 'address(?:es)?';
 return escape(key.replace(/s$/,''))+'s?';
}
function attachedUnit(number,unit){
 if(!unit)return true;
 const pattern=unitPattern(unit),suffix=new RegExp('^\\s*'+pattern+'(?![\\p{L}\\p{N}_])','iu'),prefix=new RegExp('(?:^|\\s)'+pattern+'\\s*$','iu');
 return suffix.test(number.after)||prefix.test(number.before)||String(unit).toLowerCase()==='usd'&&/\$\s*$/.test(number.before);
}
function implicitCountUnit(claim,number,role,check){
 // A fixed count subject may name its own unit. Recognize only an immediate
 // value assertion and an optional key location, never arbitrary bare figures.
 const unit=String(check.unit||'').toLowerCase();
 if(role!=='count'||!['transaction','transactions','record','records','block','blocks','swap','swaps','amount','amounts','observation','observations','row','rows','address','addresses','event','events','input','inputs','output','outputs'].includes(unit))return false;
 const named=new RegExp('(?<![\\p{L}\\p{N}])'+unitPattern(unit)+'(?![\\p{L}\\p{N}])','iu'),subjects=aliases(check.subject).filter(subject=>named.test(subject));
 const bound=phraseSpans(claim,subjects).some(span=>span.end<=number.before.length&&/^\s*(?:,?\s*(?:is|was|are|were|equals?|at)|:|=)\s*$/i.test(number.before.slice(span.end)));
 return bound&&/^[\s,.]*(?:(?:at\s+(?:height|block|rank|position|group|bucket)\s*#?\s*(?:\d{1,3}(?:,\d{3})+|\d+)|(?:on|in)\s+DATE)[\s,.]*)?$/i.test(number.after);
}
// Opt-in reviewed contracts may name a currency in the measured subject.
// This does not make an arbitrary bare numeric value or asset name a unit.
function subjectCurrencyUnit(claim,number,role,check){
 if(check.unitInSubject!==true||role!=='usd'||String(check.unit).toUpperCase()!=='USD')return false;
 const denomination=/^[\s,;:()]*?(?:(?:in|as)\s+)?(USD|US dollars?|dollars?|EUR|euros?|GBP|pounds?|BTC|bitcoins?|ETH|ether|ZEC|TAZ|zatoshis?|zats?|records?|transactions?|swaps?|bytes?|percent(?:age)?|%)(?![\p{L}\p{N}_])/iu.exec(number.after)?.[1];
 if(denomination&&!new RegExp('^(?:'+unitPattern(check.unit)+')$','i').test(denomination))return false;
 const following=/^\s+([\p{L}%]+)/u.exec(number.after)?.[1];
 if(following&&!/^(?:USD|across|with|for|from|in|on|of|and)$/i.test(following))return false;
 return phraseSpans(claim,aliases(check.subject).filter(subject=>/\bUSD\b/.test(subject))).some(span=>span.end<=number.before.length&&/^\s*(?:,?\s*(?:is|was|are|were|equals?|at)|:|=)\s*$/i.test(number.before.slice(span.end)));
}
function nearestNumbers(claim,subject){
 const found=numbers(claim).map(number=>({...number,start:number.before.length,end:claim.length-number.after.length})),selected=[];
 for(const span of phraseSpans(claim,subject)){
  const after=found.find(number=>number.start>=span.end),before=found.filter(number=>number.end<=span.start).at(-1);
  if(after&&after.start-span.end<=100)selected.push(after);
  else if(before&&span.start-before.end<=40)selected.push(before);
 }
 return selected;
}
const negatedClaim=/\b(?:not|never|isn't|wasn't|aren't|weren't|didn't|doesn't|cannot|can't)\b/i;
const unavailableClaim=/\b(?:unavailable|unknown|not available|not (?:revealed|identified|known)|(?:cannot|can't|does not|do not|doesn't|don't)\s+(?:answer|tell|identify|reveal|determine|know|verify|show|establish|access|provide|predict|be (?:identified|determined|revealed|known)))\b/i;
function denominatorClaim(claim,number,denominator){
 if(!denominator)return true;
 const after=number.after.replace(new RegExp('^\\s*'+unitPattern('%'),'i'),'').trim(),relation=/^(?:of|out of|relative to|against)\s+(?:the\s+)?(.+)$/i.exec(after);
 if(relation)return aliases(denominator).some(value=>new RegExp('^'+phrasePattern(value)+'(?![\\p{L}\\p{N}])','iu').test(relation[1]));
 return aliases(denominator).some(value=>new RegExp('\\b(?:of|out of|relative to|against)\\s+(?:the\\s+)?'+phrasePattern(value)+'(?![\\p{L}\\p{N}])','iu').test(number.before));
}
function changeDenominatorClaim(claim,number,denominator){
 if(denominator)return denominatorClaim(claim,number,denominator);
 const after=number.after.replace(new RegExp('^\\s*'+unitPattern('%'),'i'),'').trim();
 if(!/^(?:of|out of|relative to|against)\b/i.test(after))return true;
 // A relative change uses its starting value even when the fixed case leaves
 // that ordinary baseline implicit. An explicit different denominator conflicts.
 return denominatorClaim(claim,number,['baseline','baseline value','baseline count','starting value','starting count','initial value','initial count','previous value','previous count','prior value','prior count']);
}
function valueClaim(claim,value,role,check){
 if(!hasPhrase(claim,check.subject))return false;
 if(value===null)return unavailableClaim.test(claim)&&!/\b(?:not|never)\s+(?:unavailable|unknown)\b/i.test(claim)&&!nearestNumbers(claim,check.subject).length;
 if(negatedClaim.test(claim)||unavailableClaim.test(claim))return false;
 if(role==='text'||role==='boolean')return phraseSpans(claim,check.subject).some(span=>new RegExp('^\\s*(?:is|was|are|were|equals?|reads?|:|=)\\s+(?:the\\s+)?'+phrasePattern(value)+'(?![\\p{L}\\p{N}])','iu').test(claim.slice(span.end)));
 if(check.unit&&numbers(claim).some(number=>attachedUnit(number,check.unit)&&normalized(number.value,role)!==normalized(value,role)))return false;
 const expectedUnit=String(check.unit||'').toLowerCase();
 if(['zec','usd','zatoshi','zatoshis','zat','zats','%','percent'].includes(expectedUnit)&&numbers(claim).some(number=>['ZEC','USD','zatoshi','%'].some(unit=>attachedUnit(number,unit)&&!attachedUnit(number,check.unit))))return false;
 return nearestNumbers(claim,check.subject).some(number=>normalized(number.value,role)===normalized(value,role)&&(attachedUnit(number,check.unit)||implicitCountUnit(claim,number,role,check)||subjectCurrencyUnit(claim,number,role,check))&&denominatorClaim(claim,number,check.denominator));
}
// Reviewed English canary contracts. Unrecognized associations require manual
// review; lexical checks do not prove arbitrary prose or SQL semantics.
function genericFinding(item,answer,reference){
 const check=item.answerCheck;
 if(!check||!['value','leader','change','unavailable','empty'].includes(check.type))return review(false,'finding-contract-unresolved');
 if(check.type==='empty'||!reference.length&&item.minRows===0){
  const noRows=/\bno\s+(?:matching\s+|returned\s+|qualifying\s+)?(?:rows|records|results|blocks|transactions|observations)\b/i.test(answer)&&/\b(?:return(?:ed)?|match(?:ing)?|query|filter)\b/i.test(answer);
  const falseZero=/\b(?:means|proves|establishes|there (?:was|is))\s+(?:zero|no)\s+activity\b/i.test(answer)||numbers(answer).length>0;
  return review(reference.length===0&&noRows&&!falseZero,'empty-claim-unresolved');
 }
 if(!reference.length)return review(false,'finding-reference-empty');
 if(!aliases(check.subject).length)return review(false,'finding-contract-unresolved');
 const keys=check.keyColumns??(['leader','change'].includes(check.type)?item.resultCheck?.keyColumns||[]:[]),protect=[...aliases(check.subject),...aliases(check.denominator),...reference.flatMap(row=>keys.map(i=>row[i]).filter(value=>typeof value==='string'))],claims=scopedClaims(answer,protect);
 let rows,passed=false;
 if(check.type==='leader'){
  if(!['max','min'].includes(check.direction)||!numericRoles.has(item.roles[check.valueColumn])||reference.some(row=>decimal(row[check.valueColumn])===undefined))return review(false,'leader-reference-unresolved');
  const available=reference.filter(row=>row[check.valueColumn]!==null);
  if(!available.length)return review(claims.some(claim=>valueClaim(claim,null,item.roles[check.valueColumn],check)),'leader-unavailable-unresolved');
  const sorted=[...available].sort((a,b)=>compareDecimal(a[check.valueColumn],b[check.valueColumn])*(check.direction==='max'?-1:1));
  rows=sorted.filter(row=>compareDecimal(row[check.valueColumn],sorted[0][check.valueColumn])===0);
 }else rows=reference[check.row??0]?[reference[check.row??0]]:[];
 for(const row of rows)for(const original of claims){
  const comparison=check.type==='leader'?leaderComparison(original):null,primary=comparison?.primary??original;
  if(!keys.every(i=>keyMention(primary,row[i],item.roles[i],check.keyAliases?.[i])))continue;
  const dated=check.type==='change'?datedChangeClaim(primary,row,reference,keys,item.roles,check):null;
  if(['leader','change'].includes(check.type)&&competingKey(dated?.keyClaim??primary,row,reference,keys,item.roles,check.keyAliases))return review(false,check.type+'-key-association-unresolved');
  if(comparison&&!validLeaderComparison(comparison.comparison,row,reference,keys,item.roles,check,primary))return review(false,'leader-comparison-unresolved');
  const claim=dated?.claim??withoutKeys(primary,row,keys,item.roles);
  if(check.type==='leader'){
   if(rows.length>1&&/\b(?:alone|unique(?:ly)?|sole|only)\b/i.test(claim))return review(false,'leader-tie-conflict');
   const maximum=/\b(?:highest|largest|greatest|leads?|leading|top|most|maximum)\b/i.test(claim)||comparison&&/\blarger\b/i.test(claim),minimum=/\b(?:lowest|smallest|least|minimum)\b/i.test(claim);
   if(check.direction==='max'&&minimum||check.direction==='min'&&maximum)return review(false,'leader-direction-conflict');
   if(!(check.direction==='max'?maximum:minimum))continue;
  }
  if(check.type==='change'){
   if(!hasPhrase(claim,check.subject)||negatedClaim.test(claim))continue;
   if(doubleNegativeDecrease.test(claim))return review(false,'change-direction-unresolved');
   const base=row[check.baseColumn],value=row[check.valueColumn],delta=row[check.deltaColumn];
   if([base,value,delta].some(v=>v===null||decimal(v)===undefined))continue;
   const direction=compareDecimal(value,base),positive=/\b(?:rose|increased?|grew|growth|up|jumped|climbed)\b/i.test(claim),negative=/\b(?:fell|decreased?|declined?|down|dropped)\b/i.test(claim),unchanged=/\b(?:unchanged|no change|same)\b/i.test(claim);
   if(direction>0&&negative||direction<0&&positive||direction===0&&(positive||negative)||direction!==0&&unchanged)return review(false,'change-direction-conflict');
   const amount='[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?',unit='(?!(?:in|on|and|or|with|as|because|for|during|at|by)\\b)[A-Za-z%]+';
   const endpoints=new RegExp('\\bfrom\\s+('+amount+')(?:\\s+('+unit+'))?\\s+to\\s+('+amount+')(?:\\s+('+unit+'))?','i').exec(claim);
   if(/\bfrom\s+[+-]?\d/i.test(claim)&&!endpoints)return review(false,'change-endpoint-unresolved');
   if(endpoints&&[endpoints[2],endpoints[4]].some(unit=>unit&&(!check.unit||!attachedUnit({before:'',after:' '+unit},check.unit))))return review(false,'change-unit-conflict');
   const endpointMatch=endpoints&&decimal(endpoints[1].replaceAll(',',''))===decimal(base)&&decimal(endpoints[3].replaceAll(',',''))===decimal(value);
   if(endpoints&&!endpointMatch)return review(false,'change-endpoint-conflict');
   const statedChanges=numbers(claim).filter(number=>!/^(?:\s*%|\s*percent\b)/i.test(number.after)&&(/^[+-]/.test(number.value)||/\b(?:by|delta|change)\s*(?:(?:of|is|was)\s*)?$/i.test(number.before)));
   if(statedChanges.some(number=>decimal(number.value.replace(/^[+-]/,''))!==decimal(delta.replace(/^[+-]/,''))||/^[+-]/.test(number.value)&&compareDecimal(number.value,'0')!==direction))return review(false,'change-delta-conflict');
   const change=numbers(claim).some(number=>decimal(number.value.replace(/^[+-]/,''))===decimal(delta.replace(/^[+-]/,''))&&attachedUnit(number,check.unit)&&(/^[+-]/.test(number.value)||/\b(?:by|delta|change)\s*(?:(?:of|is|was)\s*)?$/i.test(number.before))&&(!/^[+-]/.test(number.value)||compareDecimal(number.value,'0')===direction));
   const statedDirection=(direction>0?positive:direction<0?negative:unchanged)||statedChanges.some(number=>/^[+-]/.test(number.value)&&compareDecimal(number.value,'0')===direction);
   if(!(endpointMatch||change&&statedDirection))continue;
   if(check.percentColumn!==undefined){
    const percent=row[check.percentColumn];
    if(percent===null){if(!unavailableClaim.test(claim))continue;}
    else if(!numbers(claim).some(number=>normalized(number.value,'percent')===normalized(percent,'percent')&&attachedUnit(number,'%')&&changeDenominatorClaim(claim,number,check.denominator)))continue;
   }
   passed=true;continue;
  }
  const column=check.type==='leader'?check.valueColumn:check.column;
  if(!Number.isInteger(column)||column<0||column>=item.roles.length)return review(false,'finding-contract-unresolved');
  if(check.type==='unavailable'&&row[column]!==null)return review(false,'unavailable-reference-conflict');
  if(valueClaim(claim,row[column],item.roles[column],check))passed=true;
  else if(hasPhrase(claim,check.subject)&&(nearestNumbers(claim,check.subject).length||negatedClaim.test(claim)||unavailableClaim.test(claim)||['text','boolean'].includes(item.roles[column])&&/\b(?:is|was|are|were|equals?|reads?)\b/i.test(claim)))return review(false,check.type+'-claim-conflict');
 }
 return review(passed,check.type+'-claim-unresolved');
}
function expectedOutcomeReview(item,answer){
 const check=item.answerCheck;
 if(item.kind==='clarify'){
  const groups=check?.type==='clarify'?check.requiredGroups:[['measure','metric','transaction','fee','volume'],['baseline','comparison','compare','window']];
  return review(Array.isArray(groups)&&groups.length>0&&/\?|\b(?:which|choose|tell me)\b/i.test(answer)&&groups.every(group=>aliases(group).some(word=>new RegExp('\\b'+phrasePattern(word)+'s?\\b','i').test(answer))),'clarification-unresolved');
 }
 if(check?.type!=='refusal')return privateRefusal(answer);
 const ownership=privateRefusal(answer);if(ownership.reason==='ownership-assertion-conflict')return ownership;
 const claims=scopedClaims(answer,aliases(check.subject));
 if(check.reason==='write-operation-forbidden'){
  const denied=/\b(?:cannot|can't|will not|won't|do not|does not)\b[^.!?;]*\b(?:write|delete|modify|update|drop|remove|execute)\b/i;
  if(claims.some(claim=>/\b(?:deleted|removed|updated|modified|dropped|wrote)\b/i.test(claim)&&!denied.test(claim)||/\b(?:can|will)\s+(?:delete|write|modify|update|drop|remove)\b/i.test(claim)))return review(false,'refusal-assertion-conflict');
  return review(claims.some(claim=>denied.test(claim)||/\bread[ -]only\b/i.test(claim)),'refusal-unresolved');
 }
 const relevant=claims.filter(claim=>hasPhrase(claim,check.subject));
 if(relevant.some(claim=>!unavailableClaim.test(claim)&&(/\b(?:is|are|was|were|owns?|controls?|belongs?)\b/i.test(claim)||numbers(claim).length)))return review(false,'refusal-assertion-conflict');
 return review(relevant.some(claim=>unavailableClaim.test(claim)&&!/\b(?:not|never)\s+(?:unavailable|unknown)\b/i.test(claim)),'refusal-unresolved');
}
function findingReview(item,answer,reference){
 if(receipt.test(answer.trim())||answer.length<20||answer.includes('{{'))return {passed:false};
 if(item.answerCheck)return genericFinding(item,answer,reference);
 if(item.finding==='fee')return feeFinding(answer,reference[0][3]);
 if(item.finding==='baseline')return baselineFinding(answer,reference);
 if(item.finding==='annual_change')return annualFinding(answer,reference);
 return {passed:false};
}
function usefulFinding(item,answer,reference){return findingReview(item,answer,reference).passed;}
function gradeReply(item,reply,verification=null){
 const answer=typeof reply?.answer==='string'?reply.answer:'',checks=[],dimensions={result:item.kind==='research'?'not-checked':'not-applicable',narrative:'not-checked',expectedOutcome:item.kind==='research'?'not-applicable':'not-checked'};
 if(reply?.mode!=='ai')checks.push('ai-path-required');
 if(item.kind!=='research'){
  const unexpected=!!(reply?.job||reply?.research||reply?.analytics||reply?.transfers||reply?.blocks||reply?.transactions||reply?.spec);
  if(unexpected)checks.push('unexpected-data-query');
  const outcome=expectedOutcomeReview(item,answer);dimensions.narrative=outcome.passed?'passed':'failed';dimensions.expectedOutcome=!unexpected&&outcome.passed?'passed':'failed';
  if(item.kind==='clarify'&&!outcome.passed)checks.push('clarification-not-useful');
  if(item.kind==='unavailable'&&!outcome.passed){checks.push('private-facts-not-refused','narrative-manual-review');return {passed:false,checks,dimensions,diagnostics:{stage:'narrative-manual-review',reason:outcome.reason}};}
  return {passed:!checks.length,checks,dimensions};
 }
 let reference,diagnostics,candidate;
 const parsed=researchResultSchema.safeParse(reply?.research);
 if(!parsed.success){checks.push('result-not-verified');diagnostics={stage:'candidate-shape'};}
 else{
  candidate=parsed.data;
  try{
   const pair=splitComparison(item,candidate,verification);reference=pair.reference;
   if(!matchRoles(item,pair.reference,candidate.rows,candidate.columns)){checks.push('measures-or-window-mismatch');dimensions.result='failed';}
   else dimensions.result='passed';
  }catch(error){checks.push('result-not-verified');diagnostics=error.verificationDiagnostic||{stage:'verification-shape'};}
 }
 if(receipt.test(answer.trim())){checks.push('receipt-fallback');dimensions.narrative='failed';}
 if(reference){const finding=findingReview(item,answer,reference);dimensions.narrative=finding.passed?'passed':'failed';if(!finding.passed){checks.push('requested-finding-missing');if(finding.reason){checks.push('narrative-manual-review');diagnostics??={stage:'narrative-manual-review',reason:finding.reason};}}}
 return {passed:!checks.length,checks,dimensions,...(diagnostics?{diagnostics}:{})};
}
module.exports={decimal,dateKey,comparisonQuery,splitComparison,matchRoles,usefulFinding,gradeReply};
