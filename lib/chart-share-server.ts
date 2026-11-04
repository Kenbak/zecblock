import 'server-only';
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { after } from 'next/server';
import { ApiError, parseApiResponse, type ApiMeta } from './api-client';
import { readBoundedJson } from './bounded-json';
import { catalogRows, latestCatalogObservation, type CatalogChart } from './chart-catalog';
import { chartEndpoint } from './chart-sharing';
import { getApiUrl, getNetwork } from './seo';
import { fetchWithDeadline } from './server-fetch';

const CHART_PAGE_WAIT_MS = 1_000;
const CHART_REFRESH_TIMEOUT_MS = 10_000;
const CHART_MAX_BYTES = 2 * 1024 * 1024;
const CHART_REVALIDATE_SECONDS = 300;
interface ChartSnapshot { payload: unknown; meta: ApiMeta; fetchedAt: number }
function refreshFailureReason(error: unknown): string {
  return error instanceof ApiError ? `API request failed (HTTP ${error.status})`
    : error instanceof Error ? error.message.replace(/[\r\n]/g, ' ').slice(0, 160) : 'Chart refresh failed';
}

// Only in-flight work is retained in process. Durable last-good values live in
// Next's Data Cache, shared by the page and its social image across invocations.
const pendingRefreshes = new Map<string, Promise<ChartSnapshot>>();
const refreshChart = unstable_cache(async (chart: CatalogChart, apiUrl: string, network: ReturnType<typeof getNetwork>): Promise<ChartSnapshot> => {
  const key = JSON.stringify([network, apiUrl, chart.id]);
  const pending = pendingRefreshes.get(key);
  if (pending) return pending;
  const refresh = (async () => {
    const started = Date.now();
    const response = await fetchWithDeadline(`${apiUrl}${chartEndpoint(chart)}`, { cache: 'no-store' }, CHART_REFRESH_TIMEOUT_MS);
    const remaining = CHART_REFRESH_TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0) {
      void response.body?.cancel().catch(() => {});
      throw new DOMException('Chart snapshot refresh deadline exceeded', 'TimeoutError');
    }
    const envelope = parseApiResponse(response, await readBoundedJson(response, CHART_MAX_BYTES, remaining));
    if (envelope.meta.network !== network) throw new Error('Network mismatch');
    if (envelope.meta.freshness?.status === 'unavailable') throw new Error('Chart source unavailable');
    const fetchedAt = Date.parse(envelope.meta.generatedAt);
    if (!Number.isFinite(fetchedAt)) throw new Error('Chart snapshot timestamp unavailable');
    if (!latestCatalogObservation(catalogRows(chart, envelope.data), chart.series)) throw new Error('Chart observations unavailable');
    // Do not duplicate transformed rows in the cache: all-history payloads can
    // be large. Invalid/unavailable refreshes throw so the last good survives.
    return { payload: envelope.data, meta: envelope.meta, fetchedAt };
  })().catch(error => {
    // Next also logs background revalidation failures. Never pass upstream
    // problem-detail text or an unbounded exception into those framework logs.
    throw new Error(refreshFailureReason(error));
  });
  pendingRefreshes.set(key, refresh);
  try { return await refresh; }
  finally { if (pendingRefreshes.get(key) === refresh) pendingRefreshes.delete(key); }
}, ['chart-snapshots-v2'], { revalidate: CHART_REVALIDATE_SECONDS });

/** Keep original API time visible when Next serves a last-good stale snapshot. */
export function delayedChartSnapshotLabel(fetchedAt: number, freshness?: ApiMeta['freshness'], now = Date.now()): string | undefined {
  if (now - fetchedAt <= CHART_REVALIDATE_SECONDS * 1_000 && freshness?.status !== 'stale') return undefined;
  return `API snapshot · ${new Date(fetchedAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')} · refresh delayed`;
}

// A cold page waits at most 1s. Its longer refresh continues under Next's
// waitUntil-backed after(), populating the cache for subsequent requests.
// Images have no browser fallback and may opt into the full bounded wait.
export const loadShareChart = cache(async (chart: CatalogChart, waitMs = CHART_PAGE_WAIT_MS) => {
  const pending = refreshChart(chart, getApiUrl(), getNetwork()).catch(error => {
    console.error(`[charts] snapshot for ${chart.id} unavailable:`, refreshFailureReason(error));
    return null;
  });
  const deferred = Symbol('chart snapshot deferred');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([pending, new Promise<typeof deferred>(resolve => {
      timer = setTimeout(() => resolve(deferred), Math.min(CHART_REFRESH_TIMEOUT_MS, Math.max(1, waitMs)));
    })]);
    if (snapshot === deferred) {
      after(async () => { await pending; });
      return null;
    }
    return snapshot ? { ...snapshot, rows: catalogRows(chart, snapshot.payload) } : null;
  } finally { clearTimeout(timer); }
});
