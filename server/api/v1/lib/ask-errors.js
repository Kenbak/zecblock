'use strict';
const { sqlFeedbackSchema } = require('../../../../lib/ask/sql-feedback');

// Fixed public categories only. Never forward an upstream message or body.
const failures = {
  resource:{code:'ask-resource',status:422,type:'validation-error',detail:'This query could not run within the research resource budget. Try again after backend pressure clears, or filter and aggregate joined tables; your date range has not been changed.'},
  job:{code:'ask-job',status:404,type:'not-found',detail:'This research job is unavailable or has expired.'},
  interrupted:{code:'ask-interrupted',status:503,type:'upstream-error',detail:'Research was interrupted by a worker restart. Run the query again; it was not retried automatically.'},
  query:{code:'ask-query',status:400,type:'validation-error',detail:'This SQL cannot run. Check the catalogue, column names and supported SELECT syntax.'},
  verification: { code: 'ask-verification', status: 403, type: 'access-denied', detail: 'Verification expired or failed. Retry verification, then send your question again.' },
  dataset: { code: 'ask-dataset', status: 503, type: 'upstream-error', detail: 'A dataset needed by this query is still copying or refreshing. Your query is kept; try again after it becomes available.' },
  source: { code: 'ask-source', status: 503, type: 'upstream-error', detail: 'The source data could not be read. Your analysis is still available; try again shortly.' },
  provider: { code: 'ask-provider', status: 503, type: 'upstream-error', detail: 'The AI provider is temporarily unavailable. Starter charts remain available.' },
  answer: { code: 'ask-answer', status: 503, type: 'upstream-error', detail: 'Zift could not validate the answer. Try a more specific question or open the source chart.' },
  timeout: { code: 'ask-timeout', status: 504, type: 'upstream-timeout', detail: 'The request took too long. Review the query bounds and filters on each joined table, then run it again. The requested period has not been changed.' },
  quota: { code: 'ask-quota', status: 429, type: 'rate-limited', detail: 'Zift has reached an allowance. Please try later; your draft and current results are kept.' },
  unavailable: { code: 'ask-unavailable', status: 503, type: 'upstream-error', detail: 'Zift is temporarily unavailable. Starter charts remain available.' },
};
const aiAlternatives = ' You can still run SQL directly or use starter charts, subject to their own limits.';
const keptSQL = ' Your query and current results are kept.';
const keptRequest = ' Your draft and current results are kept.';
const quotaDetails = Object.freeze({
  'ask-request-attempts': 'Too many submission or verification attempts from your connection. This limit applies to Ask and SQL.' + keptRequest,
  'ask-request-minute': 'Ask and SQL have reached their per-minute request allowance across all visitors. Try again in a minute.' + keptRequest,
  'ask-request-day': 'Ask and SQL have reached their daily request allowance across all visitors. It resets at 00:00 UTC.' + keptRequest,
  'ask-request-global-hour': 'Ask and SQL have reached the site-wide hourly request limit.' + keptRequest,
  'ask-request-global-day': 'Ask and SQL have reached the site-wide daily request limit.' + keptRequest,
  'ask-ai-minute': 'Zift’s AI has reached its per-minute allowance across all visitors. Try again in a minute.' + aiAlternatives,
  'ask-ai-day': 'Zift’s AI has reached its daily allowance across all visitors. It resets at 00:00 UTC.' + aiAlternatives,
  'ask-sql-minute': 'SQL has reached its per-minute allowance across all visitors. Try again in a minute.' + keptSQL,
  'ask-sql-day': 'SQL has reached its daily allowance across all visitors. It resets at 00:00 UTC.' + keptSQL,
  'ask-ai-calls-day': 'AI has reached its site-wide daily call limit.' + aiAlternatives,
  'ask-ai-budget-day': 'AI has reached its site-wide daily usage allowance.' + aiAlternatives,
  'ask-ai-budget-month': 'AI has reached its site-wide monthly usage allowance.' + aiAlternatives,
  'ask-ai-busy': 'AI is handling the maximum number of simultaneous requests. Try again shortly.' + aiAlternatives,
  'ask-sql-global-day': 'SQL has reached its site-wide daily query allowance.' + keptSQL,
  'ask-sql-busy': 'SQL is handling the maximum number of simultaneous queries. Try again shortly.' + keptSQL,
  'ask-sql-queue': 'The SQL queue is full. Try again shortly.' + keptSQL,
  'ask-sql-visitor': 'You already have two queries running or waiting. Try again when one finishes.' + keptSQL,
  'ask-sql-status-minute': 'Too many research status, cancellation or explanation requests from your connection.' + keptSQL + ' Zift can still answer other direct questions, subject to its own limits.',
});
function askError(kind) { const error = new Error('Ask operation failed'); error.askKind = kind; return error; }
function classifyFailure(error) {
  const maxRetryAfter = ['ask-request-attempts','ask-sql-status-minute'].includes(error?.quotaCode) ? 60 : 2678400;
  if (error?.quota === true && typeof error.quotaCode === 'string' && Object.hasOwn(quotaDetails,error.quotaCode) && Number.isInteger(error.retryAfter) && error.retryAfter > 0 && error.retryAfter <= maxRetryAfter) {
    return {...failures.quota, code:error.quotaCode, retryAfter:error.retryAfter, detail:quotaDetails[error.quotaCode]};
  }
  if (error?.quota === true && error.quotaCode === undefined && ['day','minute'].includes(error.askLimit) && Number.isInteger(error.retryAfter) && error.retryAfter > 0 && error.retryAfter <= 86400) {
    return {...failures.quota, code:'ask-quota-'+error.askLimit, retryAfter:error.retryAfter, detail:error.askLimit === 'day' ? 'The previous shared daily allowance for your connection has been reached. Ask and SQL share this legacy allowance; it resets at midnight UTC.' : 'The previous shared per-minute allowance for your connection has been reached. Ask and SQL share this legacy allowance.'};
  }
  const kind = error?.quota ? 'quota' : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : Object.hasOwn(failures, error?.askKind) ? error.askKind : 'unavailable';
  // Only schema-checked feedback about the visitor's own SQL is attached.
  const sql = ['query','resource'].includes(kind) ? sqlFeedbackSchema.safeParse(error?.sqlFeedback) : null;
  return sql?.success ? { ...failures[kind], sql: sql.data } : failures[kind];
}
// Problem-document members for a classified failure.
function failureExtra(failure) { return { code: failure.code, ...(failure.sql ? { sql: failure.sql } : {}) }; }
async function askStage(kind, operation) {
  try { return await operation(); } catch (error) {
    if (error?.quota || error?.askKind || ['TimeoutError', 'AbortError'].includes(error?.name)) throw error;
    throw askError(kind);
  }
}
module.exports = { askError, askStage, classifyFailure, failureExtra };
