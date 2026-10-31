'use strict';
// Content-free query shape for anonymous load telemetry. Literals are read only
// to choose a coarse span bucket here; no value, name or SQL text leaves.
const shapeFeatures=Object.freeze(['cte','distinct','group','join','subquery','window']);
const spans=Object.freeze(['unbounded','height','day','week','month','quarter','year','multi_year']);
const timeColumns=new Set(['timestamp','date','first_seen','last_seen']);
const units={hour:3600,hours:3600,day:86400,days:86400,week:604800,weeks:604800,month:2678400,months:2678400,year:31622400,years:31622400};
const sval=n=>n?.A_Const?.sval?.sval;
const last=list=>list?.at(-1)?.String?.sval;
const column=n=>{const f=n?.ColumnRef?.fields;return Array.isArray(f)&&f.at(-1)?.String?last(f):null;};
const castType=n=>last(n?.TypeCast?.typeName?.names);
function instant(text){return typeof text==='string'&&/^\d{4}-\d{2}-\d{2}(?:[ T][\d:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/.test(text.trim())?(t=>Number.isFinite(t)?t/1000:null)(Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text.trim())?text.trim()+'T00:00:00Z':text.trim().replace(' ','T').replace(/([+-]\d{2})$/,'$1:00'))):null;}
function interval(n){const m=/^\s*(\d{1,5})\s*([a-z]+)\s*$/.exec(sval(n?.TypeCast?.arg)||sval(n)||'');return castType(n)==='interval'&&m&&units[m[2]]?Number(m[1])*units[m[2]]:null;}
// Seconds since the Unix epoch, or null when the expression is not a literal
// instant, CURRENT_DATE-style clock or simple interval arithmetic on one.
function seconds(n,now,depth=0){
 if(!n||depth>8)return null;
 if(n.A_Const)return n.A_Const.ival?Number(n.A_Const.ival.ival??0):instant(sval(n));
 if(n.TypeCast)return ['date','timestamp','timestamptz'].includes(castType(n))?instant(sval(n.TypeCast.arg))??seconds(n.TypeCast.arg,now,depth+1):seconds(n.TypeCast.arg,now,depth+1);
 if(n.SQLValueFunction)return now;
 const f=n.FuncCall,name=last(f?.funcname);
 if(f&&['extract','date_part'].includes(name)&&f.args?.length===2&&sval(f.args[0])?.toLowerCase()==='epoch')return seconds(f.args[1],now,depth+1);
 if(f&&name==='to_timestamp'&&f.args?.length===1)return seconds(f.args[0],now,depth+1);
 if(f&&name==='date_trunc'&&f.args?.length===2)return seconds(f.args[1],now,depth+1);
 const e=n.A_Expr,op=last(e?.name);
 if(e?.kind==='AEXPR_OP'&&['+','-'].includes(op)){const base=seconds(e.lexpr,now,depth+1),step=interval(e.rexpr)??(Number.isInteger(e.rexpr?.A_Const?.ival?.ival)?e.rexpr.A_Const.ival.ival*86400:null);return base===null||step===null?null:base+(op==='+'?step:-step);}
 return null;
}
const flip={'<':'>','<=':'>=','>':'<','>=':'<=','=':'='};
function queryShape(tree,now=Date.now()/1000){
 const features=new Set(),time={from:null,to:null},height={from:null,to:null};let visited=0;
 const bound=(name,op,value)=>{
  if(value===null||!Number.isFinite(value))return;
  const range=name==='height'?height:timeColumns.has(name)?time:null;if(!range)return;
  if(['>','>=','='].includes(op))range.from=range.from===null?value:Math.min(range.from,value);
  if(['<','<=','='].includes(op))range.to=range.to===null?value:Math.max(range.to,value+(op==='='&&range===time?86400:0));
 };
 const walk=value=>{
  if(++visited>20000||value===null||typeof value!=='object')return;
  if(Array.isArray(value)){for(const item of value)walk(item);return;}
  const s=value.SelectStmt;if(s){if(s.withClause)features.add('cte');if(s.groupClause?.length)features.add('group');if(s.distinctClause)features.add('distinct');}
  if(value.JoinExpr)features.add('join');
  if(value.SubLink||value.RangeSubselect)features.add('subquery');
  if(value.FuncCall?.over)features.add('window');
  if(value.FuncCall?.agg_distinct)features.add('distinct');
  const e=value.A_Expr,op=last(e?.name);
  if(e?.kind==='AEXPR_OP'&&flip[op]){
   const left=column(e.lexpr)||column(e.lexpr?.TypeCast?.arg),right=column(e.rexpr)||column(e.rexpr?.TypeCast?.arg);
   if(left&&!right)bound(left,op,seconds(e.rexpr,now));else if(right&&!left)bound(right,flip[op],seconds(e.lexpr,now));
  }
  if(['AEXPR_BETWEEN','AEXPR_BETWEEN_SYM'].includes(e?.kind)&&e.rexpr?.List?.items?.length===2){const name=column(e.lexpr),[a,b]=e.rexpr.List.items.map(x=>seconds(x,now));if(name&&a!==null&&b!==null){bound(name,'>=',Math.min(a,b));bound(name,'<=',Math.max(a,b));}}
  for(const child of Object.values(value))walk(child);
 };
 walk(tree);
 let span='unbounded';
 if(time.from!==null){const days=(Math.max(time.to??now,time.from)-time.from)/86400;span=days<=1?'day':days<=7?'week':days<=31?'month':days<=92?'quarter':days<=366?'year':'multi_year';}
 else if(height.from!==null&&height.to!==null)span='height';
 return {features:shapeFeatures.filter(f=>features.has(f)),span};
}
module.exports={queryShape,shapeFeatures,spans};
