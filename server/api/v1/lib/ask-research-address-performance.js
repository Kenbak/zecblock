'use strict';
// An AI-draft efficiency hint, never SQL admission or a query rewrite. The
// month-wide DISTINCT form is valid SQL, but can spill under the worker budget.
const {researchCatalogue,isPublished}=require('../../../../lib/ask/research-catalogue');
// The address_daily shortcut is offered only once that summary is published.
const summary=isPublished('address_daily')?'When no predicate other than the UTC date window applies, read address_daily for the same dates instead: its active_addresses and incidences are exactly these per-day counts over the same canonical incidences. Otherwise drive':'Drive';
const advice='This full UTC-month daily address query performs a month-wide DISTINCT/address sort. Preserve the complete requested month and the distinct-address versus address-transaction-incidence measures, including published coinbase incidences. '+summary+' from activity_daily dates in the same half-open UTC date window and use correlated per-day COUNT(DISTINCT a.address) and COUNT(*) subqueries against address_activity, with a.timestamp>=EXTRACT(EPOCH FROM d.date)::bigint AND a.timestamp<EXTRACT(EPOCH FROM (d.date+1))::bigint. This bounds each distinct sort to one day while retaining all requested dates. Preserve every additional input predicate unchanged in BOTH per-day subqueries, including any is_input/is_output boolean filter; never assume a filter is redundant or drop it. Do not shorten the period, replace distinct addresses with incidences/users, drop canonical checks, or change resource limits.';
const names=parts=>parts?.map(p=>p.String?.sval),ref=n=>names(n?.ColumnRef?.fields),unknown=()=>({kind:'unknown'});
const name=call=>{const p=names(call?.funcname);return p&&(p.length===1||p.length===2&&p[0]==='pg_catalog')?p.at(-1):null;};
function type(n){const t=n?.TypeCast?.typeName,p=names(t?.names);return !t?.typmods?.length&&!t?.arrayBounds?.length&&p&&(p.length===1||p.length===2&&p[0]==='pg_catalog')?p.at(-1):null;}
const numeric=new Set(['int2','int4','int8','smallint','integer','bigint','numeric','decimal']);
const unwrap=n=>n?.TypeCast&&numeric.has(type(n))?unwrap(n.TypeCast.arg):n;
function epoch(node){
 node=unwrap(node);const c=node?.A_Const;if(c?.ival)return c.ival.ival??0;
 const f=node?.FuncCall,arg=f?.args?.[1],kind=type(arg),literal=arg?.TypeCast?.arg?.A_Const?.sval?.sval;
 if(!['extract','date_part'].includes(name(f))||f.args?.length!==2||f.args[0]?.A_Const?.sval?.sval?.toLowerCase()!=='epoch'||!['date','timestamptz'].includes(kind)||typeof literal!=='string')return null;
 if(!/^20\d{2}-\d{2}-\d{2}(?:[ T]00:00:00(?:\.0+)?(?:Z|\+00(?::?00)?))?$/.test(literal))return null;
 const value=Date.parse(literal.length===10?literal+'T00:00:00Z':literal)/1000;return Number.isSafeInteger(value)?value:null;
}
function wholeMonth(start,end){if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start%86400||end%86400||start>=end)return false;const a=new Date(start*1000),b=new Date(end*1000);return a.getUTCDate()===1&&b.getUTCDate()===1&&a.getUTCFullYear()*12+a.getUTCMonth()+1===b.getUTCFullYear()*12+b.getUTCMonth();}
function addressDistinctDiagnostics(tree){
 const issues=new Set();let visited=0;
 const rename=(columns,aliases)=>!aliases?.length?columns:aliases.length<=columns.length?columns.map((c,i)=>({...c,name:aliases[i]?.String?.sval||c.name})):[];
 function select(s,inherited=new Map(),depth=0){
  if(!s||depth>20||++visited>4000||s.withClause?.recursive||s.op&&s.op!=='SETOP_NONE')return {columns:[],good:false};
  const scope=new Map(inherited);for(const item of s.withClause?.ctes||[]){const c=item.CommonTableExpr;if(!c)return {columns:[],good:false};const value=select(c.ctequery?.SelectStmt,scope,depth+1);scope.set(c.ctename,{...value,columns:rename(value.columns,c.aliascolnames)});}
  if(s.fromClause?.length!==1)return {columns:[],good:false};const from=s.fromClause[0];let input,alias;
  if(from.RangeVar){const r=from.RangeVar;alias=r.alias?.aliasname||r.relname;if(!r.schemaname&&scope.has(r.relname))input=scope.get(r.relname);else if(r.relname==='address_activity'&&!r.schemaname||r.relname==='address_activity_query'&&r.schemaname==='analytics_public')input={good:true,columns:researchCatalogue.find(d=>d.id==='address_activity').columns.split(', ').map(field=>({name:field,kind:field==='address'?'address':field==='timestamp'?'time':['is_input','is_output'].includes(field)?'flag':'unknown'}))};else return {columns:[],good:false};input={...input,columns:rename(input.columns,r.alias?.colnames)};}
  else if(from.RangeSubselect&&!from.RangeSubselect.lateral){const r=from.RangeSubselect;alias=r.alias?.aliasname;input=select(r.subquery?.SelectStmt,scope,depth+1);input={...input,columns:rename(input.columns,r.alias?.colnames)};}else return {columns:[],good:false};
  const resolve=n=>{const p=ref(n);if(!p?.length||p.length>2||p.length===2&&p[0]!==alias)return unknown();const found=input.columns.filter(c=>c.name===p.at(-1));return found.length===1?found[0]:unknown();};
  function bucket(n){if(++visited>4000)return false;if(n?.TypeCast&&['date','timestamp','timestamptz'].includes(type(n)))return bucket(n.TypeCast.arg);if(resolve(n).kind==='day')return true;const f=n?.FuncCall,fn=name(f),clock=f?.args?.[fn==='to_char'?0:1]?.FuncCall;if(!f||f.over||f.agg_filter||f.agg_distinct||f.args?.length!==2||name(clock)!=='to_timestamp'||clock.args?.length!==1||resolve(unwrap(clock.args[0])).kind!=='time')return false;return fn==='to_char'&&f.args[1]?.A_Const?.sval?.sval==='YYYY-MM-DD'||fn==='date_trunc'&&f.args[0]?.A_Const?.sval?.sval==='day';}
  let good=input.good,start=input.start??null,end=input.end??null;
  // Additional source-proven flag predicates preserve raw row lineage. They
  // never establish a time bound, and are not assumed redundant. Arbitrary
  // filters/subqueries and OR expressions containing time bounds still abstain.
  function flags(n,depth=0){
   if(depth>12)return false;
   if(n?.ColumnRef)return resolve(n).kind==='flag';
   const b=n?.BoolExpr;
   if(b)return ['AND_EXPR','OR_EXPR','NOT_EXPR'].includes(b.boolop)&&b.args?.length>0&&b.args.length<=8&&(b.boolop!=='NOT_EXPR'||b.args.length===1)&&b.args.every(arg=>flags(arg,depth+1));
   if(n?.BooleanTest)return resolve(n.BooleanTest.arg).kind==='flag'&&['IS_TRUE','IS_NOT_TRUE','IS_FALSE','IS_NOT_FALSE','IS_UNKNOWN','IS_NOT_UNKNOWN'].includes(n.BooleanTest.booltesttype);
   if(n?.NullTest)return resolve(n.NullTest.arg).kind==='flag'&&['IS_NULL','IS_NOT_NULL'].includes(n.NullTest.nulltesttype);
   const e=n?.A_Expr,op=names(e?.name);
   return e?.kind==='AEXPR_OP'&&op?.length===1&&['=','<>','!='].includes(op[0])&&((resolve(e.lexpr).kind==='flag'&&e.rexpr?.A_Const?.boolval!==undefined)||(resolve(e.rexpr).kind==='flag'&&e.lexpr?.A_Const?.boolval!==undefined));
  }
  function bounds(n){if(flags(n))return true;if(n?.BoolExpr)return n.BoolExpr.boolop==='AND_EXPR'&&n.BoolExpr.args?.length>0&&n.BoolExpr.args.every(bounds);const e=n?.A_Expr,op=names(e?.name),value=epoch(e?.rexpr);if(e?.kind!=='AEXPR_OP'||op?.length!==1||resolve(unwrap(e.lexpr)).kind!=='time'||!Number.isSafeInteger(value))return false;if(op[0]==='>=')start=start===null?value:Math.max(start,value);else if(op[0]==='<')end=end===null?value:Math.min(end,value);else return false;return true;}
  if(s.whereClause&&!bounds(s.whereClause))good=false;
  if(s.groupClause?.length===1&&!s.havingClause&&!s.distinctClause?.length){
   let group=s.groupClause[0],p=ref(group),ordinal=group?.A_Const?.ival?.ival;if(Number.isInteger(ordinal)&&ordinal>0)group=s.targetList?.[ordinal-1]?.ResTarget?.val;else if(p?.length===1&&!input.columns.some(c=>c.name===p[0])){const matches=s.targetList?.filter(t=>t.ResTarget?.name===p[0]);if(matches?.length===1)group=matches[0].ResTarget.val;}
   const counts=(s.targetList||[]).map(t=>unwrap(t.ResTarget?.val)?.FuncCall).filter(f=>name(f)==='count'&&!f.over&&!f.agg_filter&&!f.agg_order?.length);
   if(good&&wholeMonth(start,end)&&bucket(group)&&counts.some(f=>f.agg_distinct&&f.args?.length===1&&resolve(unwrap(f.args[0])).kind==='address')&&counts.some(f=>f.agg_star&&!f.agg_distinct))issues.add(advice);
  }
  // Aggregated, distinct or limited intermediate sources cannot be treated as
  // raw incidences by an outer SELECT; the hint must not suggest changing grain.
  if(s.groupClause?.length||s.distinctClause?.length||s.havingClause||s.limitCount||s.limitOffset)good=false;
  const columns=(s.targetList||[]).flatMap(t=>{const v=t.ResTarget?.val,p=ref(v);if(v?.ColumnRef?.fields?.at(-1)?.A_Star)return p?.length===1||p?.length===2&&p[0]===alias?input.columns:[];const info=resolve(v),kind=info.kind==='unknown'&&bucket(v)?'day':info.kind;return [{name:t.ResTarget?.name||p?.at(-1),kind}];});
  return {columns,good,start,end};
 }
 select(tree.stmts?.[0]?.stmt?.SelectStmt);return [...issues];
}
module.exports={addressDistinctDiagnostics};
