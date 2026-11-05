import 'server-only';
import { readBoundedJson } from './bounded-json';
import { createRefreshCache } from './refresh-cache';
import {
  buildZecBtcSnapshot,
  ZEC_BTC_DAY_MS,
  type ZecBtcHistoryData,
  type ZecBtcPeriod,
  type ZecBtcQuoteData,
  type ZecBtcSnapshot,
} from './zec-btc';

const PROVIDER_TIMEOUT_MS = 8_000;
const MAX_PROVIDER_BYTES = 256 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    && Number.isFinite(value * 100);
}

export function parseZecBtcQuote(payload: unknown, fetchedAt: number): ZecBtcQuoteData {
  const zcash = record(record(payload)?.zcash);
  if (!positive(zcash?.btc)) throw new Error('Invalid ZEC/BTC quote');
  const timestamp = zcash.last_updated_at;
  const observedAt = typeof timestamp === 'number' && Number.isSafeInteger(timestamp)
    && timestamp > 0 && Number.isSafeInteger(timestamp * 1000) ? timestamp * 1000 : null;
  return { btcPerZec: zcash.btc, observedAt, fetchedAt };
}

export function parseZecBtcHistory(payload: unknown, fetchedAt: number): ZecBtcHistoryData {
  const prices = record(payload)?.prices;
  if (!Array.isArray(prices) || prices.length === 0 || prices.length > 1_000) {
    throw new Error('Invalid ZEC/BTC history');
  }
  const earliest = Math.floor(fetchedAt / ZEC_BTC_DAY_MS) * ZEC_BTC_DAY_MS - 365 * ZEC_BTC_DAY_MS;
  const values = new Map<number, number | null>();
  for (const sample of prices) {
    if (!Array.isArray(sample) || sample.length !== 2) continue;
    const [timestamp, value] = sample;
    // The API also appends a live, partial sample. It is not a daily observation.
    if (!Number.isSafeInteger(timestamp) || timestamp < earliest || timestamp > fetchedAt
      || timestamp % ZEC_BTC_DAY_MS !== 0) continue;
    const btcPerZec = positive(value) ? value : null;
    // Contradictory duplicate samples are unavailable, never arbitrarily chosen.
    if (values.has(timestamp) && values.get(timestamp) !== btcPerZec) values.set(timestamp, null);
    else if (!values.has(timestamp)) values.set(timestamp, btcPerZec);
  }
  const points = [...values.entries()].sort(([a], [b]) => a - b)
    .map(([timestamp, btcPerZec]) => ({ timestamp, btcPerZec }));
  if (!points.some(point => point.btcPerZec !== null)) throw new Error('No daily ZEC/BTC observations');
  return { points, fetchedAt };
}

interface ZecBtcSourceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  demoApiKey?: string;
  proApiKey?: string;
}

/** Fixed upstreams and paths keep caller input and provider keys out of requests. */
export function createZecBtcSource({
  fetch: fetcher = fetch,
  now = Date.now,
  demoApiKey,
  proApiKey,
}: ZecBtcSourceOptions = {}): (period: ZecBtcPeriod, includeHistory?: boolean) => Promise<ZecBtcSnapshot> {
  const origin = proApiKey ? 'https://pro-api.coingecko.com' : 'https://api.coingecko.com';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (proApiKey) headers['x-cg-pro-api-key'] = proApiKey;
  else if (demoApiKey) headers['x-cg-demo-api-key'] = demoApiKey;

  async function request(path: string): Promise<unknown> {
    const response = await fetcher(`${origin}/api/v3/${path}`, {
      headers,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('ZEC/BTC provider unavailable');
    return readBoundedJson(response, MAX_PROVIDER_BYTES, PROVIDER_TIMEOUT_MS);
  }

  const quote = createRefreshCache<'quote', ZecBtcQuoteData | null>({
    load: async () => parseZecBtcQuote(await request('simple/price?ids=zcash&vs_currencies=btc&include_last_updated_at=true'), now()),
    maxAgeMs: 60_000,
    retryAfterMs: 30_000,
    fallback: () => null,
    now,
  });
  const history = createRefreshCache<'history', ZecBtcHistoryData | null>({
    load: async () => parseZecBtcHistory(await request('coins/zcash/market_chart?vs_currency=btc&days=365&interval=daily'), now()),
    maxAgeMs: 300_000,
    retryAfterMs: 30_000,
    fallback: () => null,
    now,
  });

  return async (period, includeHistory = true) => {
    const [quoteResult, historyResult] = await Promise.allSettled([
      quote('quote'),
      includeHistory ? history('history') : Promise.resolve(null),
    ]);
    return buildZecBtcSnapshot(
      period,
      quoteResult.status === 'fulfilled' ? quoteResult.value : null,
      historyResult.status === 'fulfilled' ? historyResult.value : null,
      now(),
    );
  };
}

export const getZecBtcSnapshot = createZecBtcSource({
  demoApiKey: process.env.COINGECKO_DEMO_API_KEY,
  proApiKey: process.env.COINGECKO_PRO_API_KEY,
});

/** The compact metric shares the chart's quote cache without loading history. */
export async function getZecBtcQuote(): Promise<Pick<ZecBtcSnapshot, 'source' | 'quote'>> {
  const { source, quote } = await getZecBtcSnapshot('30d', false);
  return { source, quote };
}
