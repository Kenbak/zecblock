export type ZecBtcPeriod = '7d' | '30d' | '90d' | '1y';

export interface ZecBtcPoint {
  timestamp: number;
  btcPerZec: number | null;
}

export interface ZecBtcSnapshot {
  period: ZecBtcPeriod;
  quote: {
    btcPerZec: number;
    observedAt: number | null;
    fetchedAt: number;
    delayed: boolean;
  } | null;
  history: {
    points: ZecBtcPoint[];
    startAt: number;
    endAt: number;
    fetchedAt: number;
    observedAt: number | null;
    delayed: boolean;
  } | null;
  source: 'CoinGecko';
}

export type ZecBtcQuoteData = Omit<NonNullable<ZecBtcSnapshot['quote']>, 'delayed'>;
export interface ZecBtcHistoryData {
  points: ZecBtcPoint[];
  fetchedAt: number;
}

export const ZEC_BTC_DAY_MS = 86_400_000;
const PERIOD_DAYS: Record<ZecBtcPeriod, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
const FIVE_MINUTES = 300_000;
const FUTURE_TOLERANCE = 60_000;

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isZecBtcPeriod(value: string): value is ZecBtcPeriod {
  return Object.hasOwn(PERIOD_DAYS, value);
}

/** One ZEC as a percentage of one BTC; this is a quote, not a gain. */
export function btcPercentage(btcPerZec: number | null | undefined): number | null {
  if (!positive(btcPerZec)) return null;
  const percentage = btcPerZec * 100;
  return Number.isFinite(percentage) ? percentage : null;
}

/** Only exact calendar-window endpoints support a stated period return. */
export function periodChange(points: readonly ZecBtcPoint[]): number | null {
  if (points.length < 2) return null;
  const start = points[0].timestamp;
  const end = points[points.length - 1].timestamp;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const first = points[0].btcPerZec;
  const last = points[points.length - 1].btcPerZec;
  if (!positive(first) || !positive(last)) return null;
  const change = (last / first - 1) * 100;
  return Number.isFinite(change) ? change : null;
}

/** CoinGecko normally publishes its new UTC daily sample by 00:10. */
export function expectedZecBtcHistoryEnd(now: number): number {
  const midnight = Math.floor(now / ZEC_BTC_DAY_MS) * ZEC_BTC_DAY_MS;
  return now - midnight < 600_000 ? midnight - ZEC_BTC_DAY_MS : midnight;
}

export function buildZecBtcSnapshot(
  period: ZecBtcPeriod,
  quote: ZecBtcQuoteData | null,
  history: ZecBtcHistoryData | null,
  now: number,
): ZecBtcSnapshot {
  const endAt = expectedZecBtcHistoryEnd(now);
  const startAt = endAt - PERIOD_DAYS[period] * ZEC_BTC_DAY_MS;
  const values = new Map(history?.points.map(point => [point.timestamp, point.btcPerZec]));
  const points: ZecBtcPoint[] = [];
  for (let timestamp = startAt; timestamp <= endAt; timestamp += ZEC_BTC_DAY_MS) {
    points.push({ timestamp, btcPerZec: values.get(timestamp) ?? null });
  }
  const observedAt = points.findLast(point => positive(point.btcPerZec))?.timestamp ?? null;
  const fetchedAtIsOld = (fetchedAt: number, maxAge: number) =>
    !Number.isFinite(fetchedAt) || now - fetchedAt > maxAge || fetchedAt - now > FUTURE_TOLERANCE;

  return {
    period,
    source: 'CoinGecko',
    quote: quote ? {
      ...quote,
      delayed: fetchedAtIsOld(quote.fetchedAt, 60_000)
        || quote.observedAt === null
        || !Number.isFinite(quote.observedAt)
        || now - quote.observedAt > FIVE_MINUTES
        || quote.observedAt - now > FUTURE_TOLERANCE,
    } : null,
    history: history && observedAt !== null ? {
      points,
      startAt,
      endAt,
      fetchedAt: history.fetchedAt,
      observedAt,
      delayed: fetchedAtIsOld(history.fetchedAt, FIVE_MINUTES) || observedAt < endAt,
    } : null,
  };
}
