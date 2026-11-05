'use strict';
// Model-only grain advice. This proves a narrow mismatch between an explicitly
// requested completed-month total/share and a direct unaggregated daily table.
// It is not SQL admission, a rewrite, or a general natural-language parser.
const months='January February March April May June July August September October November December'.split(' ');
const monthTokens=months.map(name=>name+'|'+name.slice(0,3)+(name==='September'?'|Sept':'')).join('|');
const monthPattern=new RegExp('\\b(?:for|during|in)\\s+(?:the\\s+(?:UTC\\s+)?(?:calendar\\s+)?month\\s+of\\s+)?('+monthTokens+')\\s*,?\\s+(20\\d{2})\\b','gi');
const allMonths=new RegExp('\\b(?:'+monthTokens+')\\b','gi');
const otherGrain=/\b(?:daily|days?|dates?|each|every|per|weekly|weeks?|monthly|annual|yearly|quarters?|trend(?:s)?|rolling|moving|averages?|mean|median|largest|smallest|busiest|highest|lowest|maximum|minimum|top|rank(?:s|ed|ing)?|compare|compared|comparison|versus|vs|preceding|previous|prior|baseline|growth|grew|changes?|difference|increase|decrease|first|last|latest|next)\b|month[-\s]+to[-\s]+month/i;
const unaggregatedIntent=/\b(?:time[-\s]+series|over[-\s]+time|raw[-\s]+(?:rows?|data)|individual[-\s]+(?:rows?|observations?)|unaggregated[-\s]+(?:data|rows?|observations?))\b/i;
const countFields=new Set('blocks transactions shielded_transactions transparent_transactions unclassified_transactions missing_fees missing_bytes'.split(' '));
const aggregates=new Set('count sum avg min max stddev_samp stddev_pop variance var_samp var_pop'.split(' '));
const names=parts=>parts?.map(part=>part.String?.sval);
const terms=node=>node?.BoolExpr?.boolop==='AND_EXPR'?node.BoolExpr.args.flatMap(terms):[node];
function periodFor(question){
 if(typeof question!=='string'||question.length>6000||otherGrain.test(question)||unaggregatedIntent.test(question)||!/\b(?:totals?|sum|overall|shares?|percent(?:age)?s?)\b/i.test(question))return null;
 const matches=[...question.matchAll(monthPattern)];
 if(matches.length!==1||[...question.matchAll(allMonths)].length!==1||[...question.matchAll(/\b20\d{2}\b/g)].length!==1)return null;
 const match=matches[0],index=months.findIndex(name=>name.toLowerCase().startsWith(match[1].slice(0,3).toLowerCase()));
 if(index<0)return null;
 const year=Number(match[2]),start=new Date(Date.UTC(year,index,1)),end=new Date(Date.UTC(year,index+1,1));
 if(end.valueOf()>Date.now())return null;
 return {start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10)};
}
function sourcePeriod(tree,question){
 if(tree?.stmts?.length!==1)return null;
 const period=periodFor(question),s=tree?.stmts?.[0]?.stmt?.SelectStmt;
 if(!period||!s||s.withClause||s.op&&s.op!=='SETOP_NONE'||s.fromClause?.length!==1||s.groupClause?.length||s.distinctClause?.length||s.windowClause?.length||s.havingClause||s.limitCount||s.limitOffset)return null;
 const range=s.fromClause[0]?.RangeVar;
 if(!range||range.alias?.colnames?.length||!(range.relname==='activity_daily'&&!range.schemaname||range.relname==='activity_daily_query'&&range.schemaname==='analytics_public'))return null;
 const alias=range.alias?.aliasname||range.relname;
 const sourceField=node=>{const ref=names(node?.ColumnRef?.fields);return ref?.length===1?ref[0]:ref?.length===2&&ref[0]===alias?ref[1]:null;};
 function unsupported(node){
  if(!node||typeof node!=='object')return false;
  if(node.SubLink||node.RangeSubselect||node.SelectStmt||node.FuncCall?.over)return true;
  return Object.values(node).some(value=>Array.isArray(value)?value.some(unsupported):unsupported(value));
 }
 if(Object.values(s).some(unsupported))return null;
 const where=terms(s.whereClause);if(where.length!==2)return null;
 let start=null,end=null;
 for(const term of where){
  const e=term?.A_Expr,op=names(e?.name),cast=e?.rexpr?.TypeCast;
  const type=names(cast?.typeName?.names),value=(cast?.arg||e?.rexpr)?.A_Const?.sval?.sval;
  const dateLiteral=!cast||type&&(type.length===1||type.length===2&&type[0]==='pg_catalog')&&type.at(-1)==='date'&&!cast.typeName?.typmods?.length&&!cast.typeName?.arrayBounds?.length;
  if(e?.kind!=='AEXPR_OP'||op?.length!==1||sourceField(e.lexpr)!=='date'||!dateLiteral||typeof value!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(value))return null;
  if(op[0]==='>='&&start===null)start=value;else if(op[0]==='<'&&end===null)end=value;else return null;
 }
 return start===period.start&&end===period.end?{period,s,sourceField}:null;
}
function hasAggregate(node){
 if(!node||typeof node!=='object')return false;
 if(node.FuncCall&&aggregates.has(node.FuncCall.funcname?.at(-1)?.String?.sval))return true;
 return Object.values(node).some(value=>Array.isArray(value)?value.some(hasAggregate):hasAggregate(value));
}
function periodGrainDiagnostics(tree,{question}={}){
 const source=sourcePeriod(tree,question);if(!source)return [];
 const {s,sourceField}=source;
 if(Object.values(s).some(hasAggregate))return [];
 const targets=(s.targetList||[]).map(target=>target.ResTarget?.val);
 if(!targets.some(target=>sourceField(target)==='date')||!targets.some(target=>countFields.has(sourceField(target))))return [];
 return ['The question requests a whole-period total or share for the complete specified calendar month, but this draft returns separate raw daily activity rows. Aggregate across the full requested month instead of returning daily rows. Recompute period shares from SUM(numerator) divided by SUM(denominator), with the requested percentage scaling and zero-denominator handling; never average daily percentages. Preserve every requested measure, date bound, null/missing-value meaning, filter and classification denominator, including unclassified transactions when requested. Omit an unnecessary daily date column from the whole-period result.'];
}
module.exports={periodGrainDiagnostics};
