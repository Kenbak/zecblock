'use strict';
// Cosmetic only: removes the schema/function qualification the server adds to
// canonical research SQL so people read and share the dataset names they wrote.
// The server re-applies the same qualification on every compile (tested), so
// this never changes what executes.
const DATASETS='blocks|transactions|flows|daily|swaps|addresses|address_activity|activity_daily|address_daily|flow_daily';
const qualifiedAlias=new RegExp(`\\banalytics_public\\.(${DATASETS})_query AS (?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))`,'g');
function displaySQL(sql){
  if(typeof sql!=='string')return sql;
  return sql
    .replace(qualifiedAlias,(match,dataset,quoted,alias)=>{const name=quoted??alias;return name===dataset?dataset:`${dataset} AS ${quoted===undefined?name:`"${name}"`}`;})
    .replace(/\bpg_catalog\.([a-z_][a-z0-9_]*)\(/g,'$1(');
}
module.exports={displaySQL};
