import { fetchWithDeadline } from './server-fetch';
import { readBoundedJson } from './bounded-json';
import { GOVERNANCE_API } from './governance';

const REQUEST_BUDGET_MS = 8_000;
const ATTEMPT_BUDGET_MS = 4_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const RETRY_DELAY_MS = 100;
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']);

type FailureReason = 'timeout' | 'network' | 'http' | 'invalid-json' | 'response-too-large' | 'invalid-directory' | 'inconsistent-tally' | 'cache';

/** Carry only bounded, public diagnostics; never retain an upstream body or raw cause. */
export class GovernanceDataError extends Error {
  constructor(
    readonly endpoint: string,
    readonly reason: FailureReason,
    readonly status?: number,
    readonly code?: string,
    readonly retryAfterMs?: number | null,
  ) {
    super(`Governance ${reason}: ${endpoint}${status === undefined ? '' : ` (HTTP ${status})`}`);
    this.name = 'GovernanceDataError';
  }
}

function classify(error: unknown, endpoint: string): GovernanceDataError {
  if (error instanceof GovernanceDataError) return error;
  const value = error as { name?: string; message?: string; cause?: { code?: string } } | null;
  if (value?.name === 'TimeoutError' || value?.name === 'AbortError' || value?.message === 'JSON response deadline exceeded') return new GovernanceDataError(endpoint, 'timeout');
  if (value?.message === 'JSON response exceeds byte limit') return new GovernanceDataError(endpoint, 'response-too-large');
  if (value?.name === 'SyntaxError') return new GovernanceDataError(endpoint, 'invalid-json');
  const code = value?.cause?.code;
  return new GovernanceDataError(endpoint, 'network', undefined, typeof code === 'string' && NETWORK_CODES.has(code) ? code : undefined);
}

export function governanceFailureDetails(error: unknown) {
  const safe = error instanceof GovernanceDataError ? error : new GovernanceDataError('cache', 'cache');
  return { endpoint: safe.endpoint, reason: safe.reason, ...(safe.status === undefined ? {} : { status: safe.status }), ...(safe.code ? { code: safe.code } : {}) };
}

function retryAfter(response: Response): number | null | undefined {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return undefined;
  const milliseconds = /^\d+$/.test(raw) ? Number(raw) * 1_000 : Date.parse(raw) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : null;
}

const pending = new Map<string, Promise<unknown>>();

async function requestJson(path: string): Promise<unknown> {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt++) {
    // Headers and the decoded body share this attempt's budget. A retry must
    // fit inside the original eight seconds, rather than starting a new clock.
    const attemptDeadline = Math.min(startedAt + REQUEST_BUDGET_MS, Date.now() + ATTEMPT_BUDGET_MS);
    try {
      const response = await fetchWithDeadline(`${GOVERNANCE_API}/${path}`, { cache: 'no-store' }, Math.max(1, attemptDeadline - Date.now()));
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new GovernanceDataError(path, 'http', response.status, undefined, retryAfter(response));
      }
      return await readBoundedJson(response, MAX_JSON_BYTES, Math.max(1, attemptDeadline - Date.now()));
    } catch (error) {
      const failure = classify(error, path);
      const transient = failure.reason === 'timeout' || failure.reason === 'network' || (failure.reason === 'http' && (failure.status === 429 || (failure.status ?? 0) >= 500));
      const delay = failure.retryAfterMs === undefined ? RETRY_DELAY_MS : failure.retryAfterMs;
      // Long Retry-After values belong to a later cache refresh; never ignore
      // the provider's backoff or hold a cold response open to wait for it.
      if (attempt !== 0 || !transient || delay === null || delay > 1_000 || Date.now() + delay >= startedAt + REQUEST_BUDGET_MS) throw failure;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export function fetchGovernanceJson(path: string): Promise<unknown> {
  const existing = pending.get(path);
  if (existing) return existing;
  const work = requestJson(path).finally(() => { if (pending.get(path) === work) pending.delete(path); });
  pending.set(path, work);
  return work;
}
