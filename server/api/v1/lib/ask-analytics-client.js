'use strict';
const { compilePlan } = require('./ask-analytics-plan');
const { evidenceFor } = require('./ask-analytics');
const { catalogue } = require('./ask-query-plan');
const { coreCatalogue } = require('./ask-core-catalogue');
const {compileResearchSQL}=require('./ask-research-sql');
const {researchResultSchema}=require('../../../../lib/ask/research-contract');
const {jobTicketSchema,jobStatusSchema}=require('../../../../lib/ask/research-job-contract');
const { askError } = require('./ask-errors');
const { sqlQuotaSchema } = require('../../../../lib/ask/quota-contract');
const { sqlQuotaError } = require('./ask-sql-quota');
const { sqlFeedbackSchema } = require('../../../../lib/ask/sql-feedback');

async function workerQuotaError(response) {
  // Even authenticated private failures are bounded and reduced to fixed codes.
  const reader=response.body?.getReader();const chunks=[];let bytes=0;
  try {
    if(reader)while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1024)break;chunks.push(Buffer.from(value));}
    if(bytes<=1024){const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));const quota=sqlQuotaSchema.safeParse(data.quota);if(quota.success)return sqlQuotaError(quota.data.code,quota.data.retryAfter);}
  }catch{/* Unknown/legacy failure remains generic; no raw body escapes. */}
  finally{await reader?.cancel();}
  return Object.assign(askError('quota'),{quota:true});
}

// Visitor-SQL feedback from the worker, re-validated here; anything else in
// the body is discarded.
async function workerSQLFeedback(response) {
  const reader=response.body?.getReader();const chunks=[];let bytes=0;
  try {
    if(reader)while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2048)return null;chunks.push(Buffer.from(value));}
    const sql=sqlFeedbackSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8'))?.sql);
    return sql.success?sql.data:null;
  }catch{return null;}
  finally{await reader?.cancel();}
}

function createAnalyticsClient(env, fetchImpl) {
  if (env.ASK_ANALYTICS_ENABLED !== 'true' || !env.ASK_ANALYTICS_SERVICE_KEY || env.ASK_ANALYTICS_SERVICE_KEY.length < 32) return null;
  let url;
  try {
    url = new URL(env.ASK_ANALYTICS_SERVICE_URL);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
  } catch { return null; }
  const transport=fetchImpl?null:require('./ask-worker-transport').createWorkerTransport();
  fetchImpl ||= transport.fetch;
  async function jobRPC(operation,input,signal,owner){
    if(env.ASK_RESEARCH_JOBS_ENABLED!=='true'||env.ASK_RESEARCH_ENABLED!=='true'||env.ASK_ANALYTICS_STORE!=='logical_public_core')throw askError('source');
    const body=operation==='submit'?(await compileResearchSQL(input,{extended:env.ASK_RESEARCH_EXTENDED==='true'})).request:jobTicketSchema.parse(input);
    const response=await fetchImpl(new URL('/jobs/'+operation,url),{method:'POST',redirect:'error',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(5000)]),headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.ASK_ANALYTICS_SERVICE_KEY}`,...(operation==='submit'&&typeof owner==='string'&&/^[0-9a-f]{64}$/.test(owner)?{'X-Ask-Visitor':owner}:{})},body:JSON.stringify(body)});
    if(!response.ok){if(response.status===429)throw await workerQuotaError(response);await response.body?.cancel();throw askError(response.status===404?'job':response.status===422?'resource':'source');}
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>270000)throw askError('source');chunks.push(Buffer.from(value));}}finally{await reader.cancel();}
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const parsed=(operation==='submit'?jobTicketSchema:jobStatusSchema).parse(value);
    if(operation!=='submit'&&parsed.id!==input.id)throw askError('source');
    if(parsed.result){const verified=await compileResearchSQL(parsed.result.query,{extended:env.ASK_RESEARCH_EXTENDED==='true'});if(parsed.result.fingerprint!==verified.fingerprint||parsed.result.query.sql!==verified.request.sql||JSON.stringify(parsed.result.datasets)!==JSON.stringify(verified.datasets))throw askError('source');}
    return parsed;
  }
  return {
    jobsEnabled:env.ASK_RESEARCH_JOBS_ENABLED==='true'&&env.ASK_RESEARCH_ENABLED==='true'&&env.ASK_ANALYTICS_STORE==='logical_public_core',
    submit:(query,{signal,owner}={})=>jobRPC('submit',query,signal,owner),
    status:(ticket,{signal}={})=>jobRPC('status',ticket,signal),
    cancel:(ticket,{signal}={})=>jobRPC('cancel',ticket,signal),
    catalogue:env.ASK_ANALYTICS_STORE==='logical_public_core'?coreCatalogue:catalogue,
    close: async () => { transport?.close(); },
    async execute(input, { signal } = {}) {
      const research=input?.version===3;
      if(research&&(env.ASK_RESEARCH_ENABLED!=='true'||env.ASK_ANALYTICS_STORE!=='logical_public_core'))throw askError('source');
      const compiled = research?await compileResearchSQL(input,{extended:env.ASK_RESEARCH_EXTENDED==='true'}):compilePlan(input,undefined,env.ASK_ANALYTICS_STORE);
      const response = await fetchImpl(new URL('/query', url), { method: 'POST', redirect: 'error',
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12000)]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.ASK_ANALYTICS_SERVICE_KEY}` }, body: JSON.stringify(research?compiled.request:compiled.plan) });
      if (!response.ok) {
        if (response.status === 429) throw await workerQuotaError(response);
        if(research&&[400,422].includes(response.status)){
          const error=askError(response.status===400?'query':'resource');
          const sql=await workerSQLFeedback(response);if(sql)error.sqlFeedback=sql;
          throw error;
        }
        await response.body?.cancel();
        if(response.status===425)throw askError('dataset');
        if(response.status===422)throw askError('resource');
        if(response.status===504)throw askError('timeout');
        throw askError('source');
      }
      const reader = response.body.getReader(); const chunks = []; let bytes = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break;
          bytes += value.length; if (bytes > (research?270000:65536)) throw askError('source'); chunks.push(Buffer.from(value)); }
      } finally { await reader.cancel(); }
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(research){
        const result=researchResultSchema.parse(wire.research);
        if(result.query.sql!==compiled.request.sql||result.query.limit!==compiled.request.limit||result.fingerprint!==compiled.fingerprint||JSON.stringify(result.datasets)!==JSON.stringify(compiled.datasets))throw askError('source');
        return {result};
      }
      if (!Array.isArray(wire.rows) || typeof wire.retrievedAt !== 'string' || !Number.isFinite(Date.parse(wire.retrievedAt))) throw askError('source');
      if(env.ASK_ANALYTICS_STORE==='logical_public_core' && wire.consistency!=='verified-canonical-core')throw askError('source');
      // Recompute facts locally; never trust worker-supplied narrative or facts.
      return evidenceFor(compiled, wire.rows, { observed_days: wire.observedDays, indexed_through: wire.indexedThrough, consistency:env.ASK_ANALYTICS_STORE==='logical_public_core'?wire.consistency:null }, new Date(wire.retrievedAt).toISOString());
    },
  };
}
module.exports = { createAnalyticsClient };
