import { ApiError, readApiResponse } from '@/lib/api-client';
import { getAskApiUrl } from './api-base';
import type { AskLocale, AskProgressStage, AskReply, AskTurn, AskTurnScope } from './chat';
import type { AnalysisSpec } from './contract';
const aiAlternatives = ' You can still run SQL directly or use starter charts, subject to their own limits.';
const keptSQL = ' Your query and current results are kept.';
const keptRequest = ' Your draft and current results are kept.';
const quotaFailures: Record<string, { title: string; detail: string; maxRetrySeconds?: number }> = Object.freeze({
  'ask-request-attempts': { title: 'Request limit reached', detail: 'Too many submission or verification attempts from your connection. This limit applies to Ask and SQL.' + keptRequest, maxRetrySeconds: 60 },
  'ask-request-minute': { title: 'Request limit reached', detail: 'Your connection has reached its per-minute request limit. This limit applies to Ask and SQL.' + keptRequest },
  'ask-request-day': { title: 'Request limit reached', detail: 'Your connection has reached its daily request limit. This limit applies to Ask and SQL.' + keptRequest },
  'ask-request-global-hour': { title: 'Request limit reached', detail: 'Ask and SQL have reached the site-wide hourly request limit.' + keptRequest },
  'ask-request-global-day': { title: 'Request limit reached', detail: 'Ask and SQL have reached the site-wide daily request limit.' + keptRequest },
  'ask-ai-minute': { title: 'AI limit reached', detail: 'Your connection has reached its per-minute AI request limit.' + aiAlternatives },
  'ask-ai-day': { title: 'AI limit reached', detail: 'Your connection has reached its daily AI request limit.' + aiAlternatives },
  'ask-sql-minute': { title: 'SQL limit reached', detail: 'Your connection has reached its per-minute SQL query limit.' + keptSQL },
  'ask-sql-day': { title: 'SQL limit reached', detail: 'Your connection has reached its daily SQL query limit.' + keptSQL },
  'ask-ai-calls-day': { title: 'AI limit reached', detail: 'AI has reached its site-wide daily call limit.' + aiAlternatives },
  'ask-ai-budget-day': { title: 'AI limit reached', detail: 'AI has reached its site-wide daily usage allowance.' + aiAlternatives },
  'ask-ai-budget-month': { title: 'AI limit reached', detail: 'AI has reached its site-wide monthly usage allowance.' + aiAlternatives },
  'ask-ai-busy': { title: 'AI busy', detail: 'AI is handling the maximum number of simultaneous requests. Try again shortly.' + aiAlternatives },
  'ask-sql-global-day': { title: 'SQL limit reached', detail: 'SQL has reached its site-wide daily query allowance.' + keptSQL },
  'ask-sql-busy': { title: 'SQL busy', detail: 'SQL is handling the maximum number of simultaneous queries. Try again shortly.' + keptSQL },
  'ask-sql-queue': { title: 'SQL busy', detail: 'The SQL queue is full. Try again shortly.' + keptSQL },
  'ask-sql-visitor': { title: 'Queries in progress', detail: 'You already have two queries running or waiting. Try again when one finishes.' + keptSQL },
  'ask-sql-status-minute': { title: 'Research updates limited', detail: 'Too many research status, cancellation or explanation requests from your connection.' + keptSQL + ' Zift can still answer other direct questions, subject to its own limits.', maxRetrySeconds: 60 },
});
function quotaFailure(error: ApiError) {
  return error.status === 429 && typeof error.code === 'string' && Object.hasOwn(quotaFailures, error.code) ? quotaFailures[error.code] : undefined;
}
export function askErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const quota = quotaFailure(error);
    if (quota) return quota.detail;
    if (error.status === 429 && error.code === 'ask-quota-day') return 'The previous shared daily allowance for your connection has been reached. Ask and SQL share this legacy allowance.';
    if (error.status === 429 && error.code === 'ask-quota-minute') return 'The previous shared per-minute allowance for your connection has been reached. Ask and SQL share this legacy allowance.';
    if (error.status === 429) return 'Zift has reached an allowance. Try again later. Your draft and current results are kept.';
    if (error.code === 'ask-verification') return 'Verification expired or failed. Retry verification, then send your question again.';
    if (error.code === 'ask-resource') return 'This query exceeded its disk or result-size budget. Filter every joined table to your requested period and aggregate before joining. Your period has not been changed.';
    if (error.code === 'ask-query') return 'This SQL could not run. Check the column names and supported functions in the data catalogue.';
    if (error.code === 'ask-interrupted') return 'The research worker restarted. Run the query again; it was not retried automatically.';
    if (error.code === 'ask-job') return 'This research job has expired or is unavailable. Run the query again.';
    if (error.code === 'ask-dataset') return 'A dataset needed by this query is still copying or refreshing. Your draft is kept; try again after it becomes available.';
    if (error.code === 'ask-source') return 'Source data is temporarily unavailable. Try again shortly; your current analysis is still available.';
    if (error.code === 'ask-answer') return 'Zift could not validate the answer. Try a more specific question or open the source chart.';
    if (error.code === 'ask-provider') return 'The AI provider is temporarily unavailable. Starter charts remain available.';
    if (error.status === 400) return 'This query or question is not supported. Check the data catalogue and SQL syntax, then try again.';
    if (error.status === 504) return 'The request took too long. Review the filters on each joined table, then run it again. Your requested period has not been changed.';
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'The request took too long. Please try again.';
  return 'Zift is temporarily unavailable. Please try again or choose a starter chart.';
}
export interface AskCapability { mode: 'guided' | 'ai'; provider: string | null; siteKey?: string | null; researchEnabled?: boolean; jobsEnabled?: boolean; researchExtended?: boolean; authenticatedStaging?: boolean }
export async function askCapability(signal: AbortSignal): Promise<AskCapability> {
  const response = await fetch(getAskApiUrl(), { signal, cache: 'no-store' });
  const { data, meta } = await readApiResponse<AskCapability>(response);
  if (meta.network !== 'mainnet') throw new Error('Wrong network');
  return data;
}
const progressStages: Record<AskProgressStage, true> = { planning: true, checking: true, running: true, repairing: true, explaining: true, looking_up: true, reading: true };
// The NDJSON progress stream: stage lines, then one result or problem line
// holding the usual envelope, returned as an ordinary response to check.
async function readProgress(response: Response, onProgress: (stage: AskProgressStage) => void): Promise<Response> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += value || '';
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop()!;
    for (const text of lines) {
      if (!text.trim()) continue;
      let line: { type?: unknown; stage?: unknown; status?: unknown; retryAfter?: unknown; body?: unknown };
      try { line = JSON.parse(text); } catch { throw new ApiError('The API returned an invalid response.', 502); }
      if (line.type === 'progress') { if (typeof line.stage === 'string' && Object.hasOwn(progressStages, line.stage)) onProgress(line.stage as AskProgressStage); continue; }
      if ((line.type === 'result' || line.type === 'problem') && Number.isInteger(line.status) && (line.status as number) >= 200 && (line.status as number) <= 599) {
        await reader.cancel();
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        const requestId = response.headers.get('x-request-id');
        if (requestId) headers['x-request-id'] = requestId;
        if (typeof line.retryAfter === 'string') headers['retry-after'] = line.retryAfter;
        return new Response(JSON.stringify(line.body ?? null), { status: line.status as number, headers });
      }
    }
    if (done) throw new ApiError('The API returned an incomplete response.', 502);
  }
}
// turnScope: the previous reply's scope, sent back for follow-ups. onProgress
// asks for the progress stream; without it the reply is plain JSON.
export interface AskChatOptions { turnScope?: AskTurnScope; onProgress?: (stage: AskProgressStage) => void }
export async function askChat(question: string, page: string, context: AnalysisSpec | null, locale: AskLocale, history: string[], challenge: string, signal: AbortSignal, block?: string, transaction?: string, currentAnalytics?: import('./chat').QueryPlan, currentResearch?: import('./research-contract').ResearchQuery, options: AskChatOptions = {}): Promise<AskReply> {
  const response = await fetch(`${getAskApiUrl()}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(options.onProgress ? { Accept: 'application/x-ndjson, application/json' } : {}) }, cache: 'no-store', signal, body: JSON.stringify({ question, page, context, locale, currentAnalytics, currentResearch, turnScope: options.turnScope, history: history.slice(-4), challenge, block, transaction }) });
  const streamed = options.onProgress && response.ok && /^application\/x-ndjson\b/i.test(response.headers.get('content-type') || '');
  const { data, meta } = await readApiResponse<AskReply>(streamed ? await readProgress(response, options.onProgress!) : response);
  if (meta.network !== 'mainnet') throw new Error('Wrong network');
  return data;
}
// question: a draft the page widget could not answer, prefilled in Zift.
export interface AskHandoff { transaction?: string; block?: string; turns: AskTurn[]; spec: AnalysisSpec | null; page: string; question?: string }
// Memory only, never URL parameters, browser storage or analytics.
let handoff: AskHandoff | null = null;
export function saveAskHandoff(value: AskHandoff) { handoff = { ...value, turns: value.turns.slice(-12) }; }
export function peekAskHandoff() { return handoff; }
export function clearAskHandoff() { handoff = null; }

export type AskFailureScope = 'request' | 'ai' | 'sql';
export interface AskFailure { title: string; detail: string; retryAt?: number; retryable: boolean; scope?: AskFailureScope }
export function askFailure(error: unknown, now = Date.now()): AskFailure {
  const limited = error instanceof ApiError && error.status === 429;
  const quota = error instanceof ApiError ? quotaFailure(error) : undefined;
  // Only fixed public quota categories carry a trusted retry window. Monthly
  // allowances may reset up to 31 days later; generic denials promise no reset.
  const legacy = limited && ['ask-quota-day', 'ask-quota-minute'].includes(error.code || '');
  const seconds = limited && (quota || legacy) && /^\d+$/.test(error.retryAfter || '') ? Number(error.retryAfter) : 0;
  const maxSeconds = quota ? quota.maxRetrySeconds || 2678400 : 86400;
  const scope: AskFailureScope | undefined = limited ? quota && error.code?.startsWith('ask-ai-') ? 'ai' : quota && error.code?.startsWith('ask-sql-') ? 'sql' : 'request' : undefined;
  return { title: quota?.title || (limited ? 'Request limit reached' : error instanceof ApiError && error.code === 'ask-verification' ? 'Verification needed' : 'Request could not finish'), detail: askErrorMessage(error), retryAt: Number.isSafeInteger(seconds) && seconds > 0 && seconds <= maxSeconds ? now + seconds * 1000 : undefined, retryable: !limited && !(error instanceof ApiError && error.code === 'ask-verification'), scope };
}
