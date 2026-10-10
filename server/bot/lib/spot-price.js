'use strict';

const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd&include_last_updated_at=true&precision=full';
const MAX_AGE_MS = 5 * 60_000;

// A detection-time quote, never a historical price at the block timestamp.
// Failed or stale quotes omit USD; no daily-price or cached-price fallback.
async function fetchSpotPrice({ fetchImpl = globalThis.fetch, clock = () => new Date() } = {}) {
  try {
    const response = await fetchImpl(PRICE_URL, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { quote: null, unavailable: `http-${response.status}` };
    const { zcash } = await response.json();
    const fetchedAt = clock();
    if (!Number.isFinite(zcash?.usd) || zcash.usd <= 0 ||
        !Number.isSafeInteger(zcash?.last_updated_at) || zcash.last_updated_at <= 0) {
      return { quote: null, unavailable: 'invalid-quote' };
    }
    const updatedAt = zcash.last_updated_at * 1000;
    const age = fetchedAt.getTime() - updatedAt;
    if (!Number.isFinite(age) || age > MAX_AGE_MS || age < -60_000) {
      return { quote: null, unavailable: 'stale-or-future-quote' };
    }
    return { quote: { source: 'coingecko', currency: 'usd', usd: zcash.usd,
      basis: 'spot-at-detection', sourceUpdatedAt: new Date(updatedAt).toISOString(),
      fetchedAt: fetchedAt.toISOString() }, unavailable: null };
  } catch (error) {
    return { quote: null, unavailable: ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'fetch-failed' };
  }
}

module.exports = { fetchSpotPrice };
