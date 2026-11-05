'use strict';
// Model-draft semantics only. Source identity is resolved through simple CTE
// projections; labels never establish whether a column counts shielded/total.
const {researchCatalogue}=require('../../../../lib/ask/research-catalogue');
const fields=researchCatalogue.find(dataset=>dataset.id==='activity_daily').columns.split(', ');
const counts=new Set(['transactions','shielded_transactions','transparent_transactions','unclassified_transactions']);
const parts=node=>node?.ColumnRef?.fields?.map(field=>field.String?.sval);
const unknown=()=>null;
function affirmative(text,pattern){
 return [...text.matchAll(new RegExp(pattern.source,'gi'))].some(match=>!(/\b(?:not|never|don't|doesn't|can't|cannot|rather than|instead of)\b(?:[\s,]+[A-Za-z_-]+){0,4}[\s,]*$/i.test(text.slice(Math.max(0,match.index-70),match.index))));
}
function requestsAllShare(raw){
 if(typeof raw!=='string'||raw.length>6000)return false;
 const question=raw.replaceAll('\u2019',"'");
 if(!/\bshielded\b/i.test(question)||!/\b(?:shares?|percentages?|percents?|ratios?|proportions?)\b/i.test(question))return false;
 const pair='(?:shielded(?:\\s+transactions)?\\s*(?:\\+|and|plus)\\s*transparent(?:\\s+transactions)?|transparent(?:\\s+transactions)?\\s*(?:\\+|and|plus)\\s*shielded(?:\\s+transactions)?)';
 const mixed=affirmative(question,new RegExp('\\b(?:of|among|within|out of|using|use|based on|relative to|against)\\s+(?:(?:the|only|just)\\s+)*'+pair+'\\b','i'));
 const excluded=/\b(?:(?:do\s+not|don't|does\s+not)\s+include|not\s+including)\s+(?:the\s+)?unclassified\b/i.test(question);
 const classified=affirmative(question,/\b(?:classified[-\s]+only|(?:of|among|within|out of)\s+(?:the\s+)?classified(?:\s+transactions)?(?:\s+only)?|(?:exclude|excluding|omit|without)\s+(?:the\s+)?unclassified|unclassified\s+(?:transactions\s+)?(?:excluded|omitted))\b/);
 if(classified||mixed||excluded)return false; // Mixed/explicit subset intent is not guessed.
 return affirmative(question,/\b(?:shares?|percentages?|percents?|ratios?|proportions?)\s+(?:of|among|out of|relative to|against)\s+(?:the\s+)?(?:all|total)\s+(?:non[-\s]?coinbase\s+)?transactions\b/)
  ||affirmative(question,/\b(?:all|total)\s+(?:non[-\s]?coinbase\s+)?transactions\s+as\s+(?:the\s+)?denominator\b/)
  ||affirmative(question,/\b(?:include|includes|including)\s+(?:the\s+)?unclassified\b/);
}
function shareDenominatorDiagnostics(tree,{question}={}){
 if(!requestsAllShare(question))return [];
 const rename=(columns,aliases)=>!columns||aliases?.length>columns.length?null:columns.map((column,i)=>({...column,name:aliases?.[i]?.String?.sval||column.name}));
 function select(s,inherited=new Map(),depth=0){
  if(!s||depth>24||s.withClause?.recursive)return null;
  const scope=new Map(inherited);
  for(const item of s.withClause?.ctes||[]){const c=item.CommonTableExpr;if(!c)return null;scope.set(c.ctename,rename(select(c.ctequery?.SelectStmt,scope,depth+1),c.aliascolnames));}
  if(s.op&&s.op!=='SETOP_NONE')return null;
  const range=s.fromClause?.length===1?s.fromClause[0]?.RangeVar:null;
  if(!range)return null; // Joined, derived and correlated input scopes stay unknown.
  const isCTE=!range.schemaname&&scope.has(range.relname);
  const base=!isCTE&&(range.relname==='activity_daily'&&!range.schemaname||range.relname==='activity_daily_query'&&range.schemaname==='analytics_public');
  const columns=rename(isCTE?scope.get(range.relname):base?fields.map(name=>({name,value:counts.has(name)?{terms:[{field:name,level:0,factor:1}]}:unknown()})):null,range.alias?.colnames);
  if(!columns)return null;
  const alias=range.alias?.aliasname||range.relname;
  function resolve(ref){
   if(!ref?.length||ref.length>2||ref.some(name=>typeof name!=='string')||ref.length===2&&ref[0]!==alias)return unknown();
   const found=columns.filter(column=>column.name===ref.at(-1));return found.length===1?found[0].value:unknown();
  }
  function expression(node){
   if(!node||typeof node!=='object'||node.SubLink||node.SelectStmt)return unknown();
   if(node.ColumnRef)return resolve(parts(node));
   if(node.TypeCast){const type=node.TypeCast.typeName,names=type?.names?.map(part=>part.String?.sval);return !type?.typmods?.length&&!type?.arrayBounds?.length&&names&&(names.length===1||names.length===2&&names[0]==='pg_catalog')&&['numeric','decimal'].includes(names.at(-1))?expression(node.TypeCast.arg):unknown();}
   if(node.A_Const){const c=node.A_Const,value=c.ival?String(c.ival.ival??0):c.fval?.fval;if(typeof value!=='string'||!/^\+?(?:0+|1|100)(?:\.0+)?$/.test(value))return unknown();return {constant:Number(value)};}
   if(node.FuncCall){
    const call=node.FuncCall,name=call.funcname?.at(-1)?.String?.sval;
    const args=(call.args||[]).map(expression);
    if(['round','abs','ceil','ceiling','floor','trunc','sum','avg','min','max'].includes(name)&&args.some(arg=>arg?.wrongShare))return {wrongShare:true};
    if(name==='sum'&&!call.over&&!call.agg_filter&&!call.agg_distinct&&args.length===1&&args[0]?.terms)return {terms:args[0].terms.map(term=>({...term,level:term.level+1}))};
    if(name==='nullif'&&args.length===2&&args[1]?.constant===0)return args[0];
    return unknown();
   }
   const e=node.A_Expr;
   if(e){
    const left=expression(e.lexpr),right=expression(e.rexpr),op=e.name?.map(part=>part.String?.sval);
    if(left?.wrongShare||right?.wrongShare)return {wrongShare:true};
    if(e.kind==='AEXPR_NULLIF')return right?.constant===0?left:unknown();
    if(e.kind!=='AEXPR_OP'||op?.length!==1)return unknown();
    if(op[0]==='+'&&left?.terms&&right?.terms)return left.terms.length+right.terms.length<=2?{terms:[...left.terms,...right.terms]}:unknown();
    if(op[0]==='*'){
     const value=left?.terms&&[1,100].includes(right?.constant)?left:right?.terms&&[1,100].includes(left?.constant)?right:null;
     const factor=value===left?right?.constant:left?.constant;
     return value&&value.terms.every(term=>term.factor*factor<=100)?{terms:value.terms.map(term=>({...term,factor:term.factor*factor}))}:unknown();
    }
    if(op[0]==='/'&&left?.terms?.length===1&&right?.terms?.length===2){
     const numerator=left.terms[0],denominator=right.terms;
     if(numerator.field==='shielded_transactions'&&[1,100].includes(numerator.factor)&&denominator.every(term=>term.factor===1&&term.level===numerator.level)&&new Set(denominator.map(term=>term.field)).size===2&&denominator.some(term=>term.field==='shielded_transactions')&&denominator.some(term=>term.field==='transparent_transactions'))return {wrongShare:true};
    }
    return unknown();
   }
   return unknown();
  }
  return (s.targetList||[]).flatMap(item=>{
   const target=item.ResTarget,ref=parts(target?.val),star=target?.val?.ColumnRef?.fields?.at(-1)?.A_Star;
   if(star)return ref?.length===1||ref?.length===2&&ref[0]===alias?columns:[];
   return [{name:target?.name||ref?.at(-1)||target?.val?.FuncCall?.funcname?.at(-1)?.String?.sval,value:expression(target?.val)}];
  });
 }
 const final=select(tree?.stmts?.[0]?.stmt?.SelectStmt);
 return final?.some(column=>column.value?.wrongShare)?['The question explicitly requests shielded share of ALL transactions, including unclassified transactions. This source-resolved draft instead divides shielded counts by shielded plus transparent counts only. Use the published activity_daily.transactions denominator at the same grain, or SUM(transactions) when aggregating; carry that source count through required CTE projections. Preserve the full requested date/lookback windows, filters, rolling baseline, ranking, returned measures, null/zero semantics and percentage rounding. Do not exclude or fold unclassified transactions into transparent counts. Explicit classified-only questions retain their requested denominator.']:[];
}
module.exports={shareDenominatorDiagnostics};
