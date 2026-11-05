'use strict';
// Model-draft quality only: output names, not SQL permissions/types or meaning.
// Unsupported scopes remain undiagnosed; direct SQL never uses this helper.
const {researchCatalogue}=require('../../../../lib/ask/research-catalogue');
const datasetNames=new Map(researchCatalogue.map(dataset=>[dataset.id,dataset.columns.split(', ').map(name=>name.trim())]));
const canonical=name=>name?.endsWith('_query')?name.slice(0,-6):name;
const refFields=node=>node?.ColumnRef?.fields?.map(field=>field.String?.sval);
const targetName=node=>{
 if(node?.TypeCast)return targetName(node.TypeCast.arg);
 const ref=refFields(node);if(ref?.length&&ref.every(name=>typeof name==='string'))return ref.at(-1);
 const name=node?.FuncCall?.funcname?.at(-1)?.String?.sval;
 return typeof name==='string'?name:null;
};
function projectionDiagnostics(tree){
 const missing=new Set();
 const rename=(names,aliases)=>!names||aliases?.length>names.length?null:names.map((name,i)=>aliases?.[i]?.String?.sval||name);
 function select(statement,inherited=new Map(),depth=0){
  if(!statement||depth>24||statement.withClause?.recursive)return null;
  const scope=new Map(inherited);
  for(const item of statement.withClause?.ctes||[]){
   const cte=item.CommonTableExpr;if(!cte||typeof cte.ctename!=='string')return null;
   scope.set(cte.ctename,rename(select(cte.ctequery?.SelectStmt,scope,depth+1),cte.aliascolnames));
  }
  if(statement.op&&statement.op!=='SETOP_NONE'){
   const left=select(statement.larg,scope,depth+1),right=select(statement.rarg,scope,depth+1);
   return left&&right&&left.length===right.length?left:null;
  }
  const range=statement.fromClause?.length===1?statement.fromClause[0]?.RangeVar:null;
  let source=null;
  if(range){
   const isCTE=!range.schemaname&&scope.has(range.relname);
   const base=!isCTE&&(!range.schemaname||range.schemaname==='analytics_public')?datasetNames.get(canonical(range.relname)):null;
   const names=rename(isCTE?scope.get(range.relname):base,range.alias?.colnames);
   if(names?.every(name=>typeof name==='string'))source={names,alias:range.alias?.aliasname||range.relname,isCTE};
  }
  const outputs=[];let knownWidth=true;
  for(const item of statement.targetList||[]){
   const target=item.ResTarget,fields=target?.val?.ColumnRef?.fields;
   if(fields?.at(-1)?.A_Star){
    const matches=fields.length===1||fields.length===2&&fields[0]?.String?.sval===source?.alias;
    if(!source||!matches)knownWidth=false;else outputs.push(...source.names);
   }else{
    const name=target?.name||targetName(target?.val);
    outputs.push(typeof name==='string'&&name?name:null);
   }
  }
  // Only a single, fully named CTE input proves an absent input column. Joins,
  // FROM subqueries, unknown stars and correlated subqueries gain no schema.
  if(source?.isCTE){
   const names=new Set(source.names),aliases=new Set(outputs.filter(name=>typeof name==='string'));
   function visit(node){
    if(!node||typeof node!=='object'||node.SubLink||node.SelectStmt||node.RangeSubselect)return;
    if(node.ColumnRef){
     const fields=refFields(node);
     if(!fields?.length||fields.some(field=>typeof field!=='string')||fields.length>2)return;
     if(fields.length===2&&fields[0]!==source.alias)return;
     if(fields.length===1&&fields[0]===source.alias)return; // PostgreSQL whole-row reference.
     if(!names.has(fields.at(-1)))missing.add(fields.at(-1));return;
    }
    for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(visit);else visit(value);}
   }
   function groupingOrOrdering(node){
    const ref=refFields(node);
    // Standalone GROUP/ORDER names may denote SELECT aliases. Expressions,
    // WHERE/HAVING and windows still resolve their references against inputs.
    if(ref?.length===1&&(aliases.has(ref[0])||!knownWidth||outputs.some(name=>name===null)))return;
    if(node?.GroupingSet)return; // Outside the local name-resolution proof.
    visit(node);
   }
   for(const target of statement.targetList||[])visit(target.ResTarget?.val);
   visit(statement.whereClause);visit(statement.havingClause);
   for(const group of statement.groupClause||[])groupingOrOrdering(group);
   for(const sort of statement.sortClause||[])groupingOrOrdering(sort.SortBy?.node);
   for(const window of statement.windowClause||[])visit(window);
  }
  return knownWidth&&outputs.length?outputs:null;
 }
 select(tree?.stmts?.[0]?.stmt?.SelectStmt);
 if(!missing.size)return [];
 // Reflect only ordinary bounded identifiers, never quoted SQL/prose content.
 const safe=[...missing].filter(name=>/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)).sort().slice(0,4);
 const names=safe.length?' ('+safe.join(', ')+')':'';
 return ['A later SELECT references input columns'+names+' that are not projected by its fully resolved CTE source. Keep each required column in the preceding CTE projection, or reference an output column actually exposed there. Preserve the requested datasets, dates, measures, grouping and scope; do not remove required measures to make the query compile.'];
}
module.exports={projectionDiagnostics};
