/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';
// Actionable feedback for SQL the visitor wrote. Only parser/policy messages
// produced by our own code and allowlisted PostgreSQL error classes are shown;
// connection, permission, catalogue and internal failures stay generic.
const {z}=require('zod');
const qualifiedView=new RegExp(`\\b(?:analytics_public\\.)?(${require('./research-catalogue').researchIds.filter(id=>id!=='labels').sort((a,b)=>b.length-a.length).join('|')})_query\\b`,'g');

const sqlFeedbackSchema=z.object({
  stage:z.enum(['syntax','policy','database','cost']),
  message:z.string().min(1).max(320),
  hint:z.string().min(1).max(240).optional(),
  code:z.string().regex(/^[0-9A-Z]{5}$/).optional(),
  line:z.number().int().min(1).max(100000).optional(),
  column:z.number().int().min(1).max(100000).optional(),
}).strict();

// SQLSTATEs caused by the query text itself. Anything else (42501 permission,
// 08xxx connection, XX internal, 55xxx state) is never forwarded.
const USER_CODES=new Set([
  '42601','42703','42883','42804','42P01','42702','42803','42P10','42725','42P18','42846','42P20','42611','42P19',
  '22012','22003','22P02','22007','22008','2201B','22023','22001','22004','22011','2201W','2201X','22013','22014','22016','2200H','22025','22019',
  '21000',
]);

const clean=(text,max)=>{
  if(typeof text!=='string')return undefined;
  // Show visitor-facing dataset names instead of the server's qualified views.
  const value=text.replace(/[\u0000-\u001f\u007f]+/g,' ')
    .replace(qualifiedView,'$1')
    .replace(/\banalytics_public\./g,'')
    .replace(/\bpg_catalog\./g,'').replace(/\s+/g,' ').trim();
  if(!value)return undefined;
  return value.length>max?value.slice(0,max-1)+'…':value;
};

function lineColumn(sql,position){
  if(typeof sql!=='string'||!Number.isInteger(position)||position<0||position>sql.length)return {};
  const before=sql.slice(0,position),lines=before.split('\n');
  return {line:lines.length,column:lines.at(-1).length+1};
}

// `error` comes from compileResearchSQL. Parser errors carry sqlDetails with a
// cursor into the visitor's own SQL; policy errors carry sqlPolicy from the walker.
function policyFeedback(error,sql){
  const source=typeof sql==='string'?sql.trim():'';
  if(error?.sqlDetails&&typeof error.sqlDetails.message==='string'){
    const message=clean(error.sqlDetails.message,300);
    if(message)return sqlFeedbackSchema.parse({stage:'syntax',message:message[0].toUpperCase()+message.slice(1),...lineColumn(source,error.sqlDetails.cursorPosition)});
  }
  if(error?.sqlPolicy&&typeof error.sqlPolicy.message==='string'){
    const message=clean(error.sqlPolicy.message,300);
    if(message)return sqlFeedbackSchema.parse({stage:'policy',message,...(error.sqlPolicy.hint?{hint:clean(error.sqlPolicy.hint,240)}:{}),...lineColumn(source,error.sqlPolicy.position)});
  }
  return null;
}

// PostgreSQL positions refer to the server's canonical rewritten SQL, not the
// visitor's text, so database feedback deliberately carries no line/column.
function databaseFeedback(error){
  if(!error||typeof error.code!=='string'||!USER_CODES.has(error.code))return null;
  const message=clean(error.message,300);
  if(!message)return null;
  const hint=clean(error.hint,240);
  return sqlFeedbackSchema.parse({stage:'database',code:error.code,message,...(hint?{hint}:{})});
}

function costFeedback(estimate,budget){
  const rounded=n=>Number(n).toLocaleString('en-US',{maximumFractionDigits:0});
  return sqlFeedbackSchema.parse({stage:'cost',message:`The query planner estimates this query at ${rounded(estimate)} cost units, above the ${rounded(budget)} research budget.`,hint:'Filter large tables by timestamp or height before joining, aggregate before joins, and avoid joins without an ON condition.'});
}

module.exports={sqlFeedbackSchema,policyFeedback,databaseFeedback,costFeedback,lineColumn,USER_CODES};
