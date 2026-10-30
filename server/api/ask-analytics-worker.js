'use strict';
// Standalone read-only worker. Intentionally no dotenv, primary pool, RPC,
// provider, legacy routes, file/shell tools or process execution imports.
const express = require('express');
const { timingSafeEqual } = require('node:crypto');
const { createClient } = require('redis');
const { createAnalytics } = require('./v1/lib/ask-analytics');
const { compilePlan } = require('./v1/lib/ask-analytics-plan');
const {createResearchJobs}=require('./v1/lib/ask-research-jobs');
const {jobTicketSchema}=require('../../lib/ask/research-job-contract');
const {compileResearchSQL}=require('./v1/lib/ask-research-sql');
const {createMemoryPressure}=require('./v1/lib/ask-memory-pressure');
const {sqlQuotaDetails}=require('./v1/lib/ask-sql-quota');
const {sqlFeedbackSchema}=require('../../lib/ask/sql-feedback');
const {recordMetrics}=require('./v1/lib/ask-research-metrics');

function createWorker(env, { analytics, redis, memoryPressure=createMemoryPressure(env) } = {}) {
  if (!env.ASK_ANALYTICS_SERVICE_KEY || env.ASK_ANALYTICS_SERVICE_KEY.length < 32 || !analytics || !redis) throw new Error('Analytics worker not configured');
  const guardedAnalytics={execute:async(...args)=>{await memoryPressure.assertAvailable();return analytics.execute(...args);}};
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');res.set('X-Robots-Tag','noindex, nofollow');
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${env.ASK_ANALYTICS_SERVICE_KEY}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.status(401).json({ error:'unauthorized' });
    next();
  });
  const jobs=createResearchJobs(env,{analytics:guardedAnalytics,redis});
  app.locals.jobs=jobs;
  for(const operation of ['submit','status','cancel'])app.post('/jobs/'+operation,express.json({limit:'12kb'}),async(req,res)=>{
    if(!jobs)return res.status(503).json({error:'unavailable'});
    try{if(operation==='submit')await memoryPressure.assertAvailable();const input=operation==='submit'?(await compileResearchSQL(req.body,{extended:env.ASK_RESEARCH_EXTENDED==='true'})).request:jobTicketSchema.parse(req.body);
      res.json(await (operation==='submit'?jobs.submit(input,{owner:req.get('X-Ask-Visitor')}):jobs[operation](input)));
    }catch(error){const quota=sqlQuotaDetails(error);if(quota)res.set('Retry-After',String(quota.retryAfter));res.status(error?.askKind==='job'?404:error?.askKind==='quota'?429:error?.askKind==='resource'?422:error?.askKind?503:400).json({error:error?.askKind==='job'?'expired':error?.askKind==='quota'?'allowance':error?.askKind==='resource'?'resource':error?.askKind?'unavailable':'invalid-request',...(quota?{quota}:{})});}
  });
  app.post('/query', express.json({ limit:'12kb' }), async (req, res) => {
    let compiled;
    try { if(req.body?.version===3){if(env.ASK_RESEARCH_ENABLED!=='true'||env.ASK_ANALYTICS_STORE!=='logical_public_core')throw Error('Research is disabled');compiled=await compileResearchSQL(req.body,{extended:env.ASK_RESEARCH_EXTENDED==='true'});}else compilePlan(req.body,undefined,env.ASK_ANALYTICS_STORE); } catch { return res.status(400).json({error:'invalid-plan'}); }
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort);
    // Quick research runs share the queued jobs' anonymous categories only.
    const started=Date.now(),measure=outcome=>compiled&&env.ASK_RESEARCH_METRICS_ENABLED==='true'?recordMetrics(redis,{outcome:controller.signal.aborted?'cancelled':outcome,datasets:compiled.datasets,features:compiled.shape.features,span:compiled.shape.span,mode:'quick',elapsedMs:Date.now()-started}):undefined;
    try {
      const evidence = await guardedAnalytics.execute(req.body, {redis, signal:controller.signal});
      void measure('success');
      if (!controller.signal.aborted && req.body.version===3)return res.json({research:evidence.result});
      if (!controller.signal.aborted) res.json({ rows: evidence.result.plan.version === 2 ? evidence.result.rows.map(row => Object.fromEntries(Object.entries(row).flatMap(([key,cell]) => [[key,cell.value], ...(/^m[0-3]$/.test(key) ? [['u'+key.slice(1),String(cell.missing)]] : [])]))) : evidence.result.rows.map(row => ({bucket:row.date,value:row.value,observed_days:row.observedDays,observed_through:row.observedThrough})), consistency:env.ASK_ANALYTICS_STORE==='logical_public_core'?'verified-canonical-core':null, observedDays:evidence.result.coverage.observedDays, indexedThrough:evidence.result.coverage.indexedThrough, retrievedAt:evidence.result.retrievedAt });
    } catch (error) {
      const quota=sqlQuotaDetails(error);if(quota)res.set('Retry-After',String(quota.retryAfter));
      const invalid=error?.askKind==='query'||['42601','42703','42883','42804','22012','22003','42P01'].includes(error?.code);
      // sqlFeedback is built from allowlisted visitor-caused errors only.
      const sql=sqlFeedbackSchema.safeParse(error?.sqlFeedback);
      void measure(error?.askKind==='dataset'?'dataset':error?.quota?'quota':error?.code==='57014'||error?.askKind==='timeout'?'timeout':error?.askKind==='resource'||error?.code==='53400'?'resource':invalid?'query':error?.askKind==='unavailable'?'unavailable':'source');
      if (!controller.signal.aborted) res.status(error?.askKind==='dataset'?425:error?.quota?429:error?.code==='57014'?504:error?.askKind==='resource'||error?.code==='53400'?422:invalid?400:503).json({error:error?.askKind==='dataset'?'dataset-warming':error?.quota?'allowance':error?.code==='57014'?'timeout':error?.askKind==='resource'||error?.code==='53400'?'resource':invalid?'invalid-query':'unavailable',...(quota?{quota}:{}),...(sql.success?{sql:sql.data}:{})});
    } finally { res.off('close', abort); }
  });
  app.use((req,res) => res.status(404).json({error:'not-found'}));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error,req,res,next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({error:'invalid-request'}));
  return app;
}
async function main() {
  const env = process.env;
  if (process.getuid?.() === 0) throw new Error('Analytics worker must run as a non-root account');
  const analytics = createAnalytics(env);
  if (!analytics || !env.ASK_ANALYTICS_REDIS_URL) throw new Error('Analytics worker not configured');
  const redis = createClient({ url:env.ASK_ANALYTICS_REDIS_URL }); redis.on('error', () => {});
  await redis.connect();
  const app = createWorker(env,{analytics,redis});
  app.locals.jobs?.start();
  const port = Number(env.ASK_ANALYTICS_PORT || 3015);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid analytics port');
  const server = app.listen(port,'127.0.0.1');
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 8;
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
    server.close(async () => { await app.locals.jobs?.stop(); await Promise.allSettled([analytics.close(),redis.quit()]); });
    server.closeAllConnections();
  });
}
if (require.main === module) main().catch(() => { console.error('Analytics worker failed'); process.exitCode=1; });
module.exports = {createWorker};
