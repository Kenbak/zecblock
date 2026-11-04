import type { ChartRow } from '@/lib/chart-catalog';

export type ActivityPeriod = '7d' | '30d' | '90d' | '1y';
export type ActivityMode = 'count' | 'share';
export type ActivityPool = 'ironwood' | 'orchard' | 'sapling' | 'sprout';

export interface PoolActivityPoint {
  date: string;
  totalTransactions: number | null;
  sprout: number | null;
  sapling: number | null;
  orchard: number | null;
  ironwood: number | null;
  complete: boolean;
}

export interface PoolActivityData {
  period: ActivityPeriod;
  startDate: string;
  endDate: string;
  sourceHeight: number | null;
  points: PoolActivityPoint[];
  totals: Omit<PoolActivityPoint, 'date' | 'complete'>;
  coverage: { completeDays: number; expectedDays: number };
}

export const ACTIVITY_POOLS = [
  { key: 'ironwood', label: 'Ironwood', color: 'ironwood' },
  { key: 'orchard', label: 'Orchard', color: 'orchard' },
  { key: 'sapling', label: 'Sapling', color: 'sapling' },
  { key: 'sprout', label: 'Sprout', color: 'sprout' },
] as const;

export const ACTIVITY_NOTE = 'Percentages use all confirmed non-coinbase transactions. Transactions can use multiple pools, so shares may total over 100%.';
export const ACTIVITY_EXPORT_NOTE = 'Shares use all confirmed non-coinbase transactions. Pools overlap.';
export const RECOVERY_LABEL = 'Quantum recoverable';
export const RECOVERY_NOTE = 'Ironwood is designed to support a future recovery protocol (ZIP 2005). Full quantum security requires further upgrades.';

/** Selection changes presentation only; pool values retain the network denominator. */
export function selectedActivityPools(selection: readonly ActivityPool[]) {
  return ACTIVITY_POOLS.filter(pool => selection.includes(pool.key)).map(pool => ({
    ...pool, marker: pool.key === 'ironwood' ? 'diamond' as const : undefined,
    strokeWidth: pool.key === 'ironwood' ? 3 : 2,
  }));
}

export function toggleActivityPool(selection: ActivityPool[], key: ActivityPool): ActivityPool[] {
  if (selection.includes(key) && selection.length === 1) return selection;
  const next = selection.includes(key) ? selection.filter(pool => pool !== key) : [...selection, key];
  return ACTIVITY_POOLS.filter(pool => next.includes(pool.key)).map(pool => pool.key);
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A zero denominator is unavailable, while a real zero pool count is preserved. */
export function activityValue(value: number | null, denominator: number | null, mode: ActivityMode): number | null {
  if (!count(value) || !count(denominator) || value > denominator) return null;
  return mode === 'count' ? value : denominator > 0 ? value / denominator * 100 : null;
}

export function poolActivityRows(points: PoolActivityPoint[], mode: ActivityMode): ChartRow[] {
  return points.map(point => ({
    x: Date.parse(`${point.date}T00:00:00Z`),
    ...Object.fromEntries(ACTIVITY_POOLS.map(({ key }) => [
      key, point.complete ? activityValue(point[key], point.totalTransactions, mode) : null,
    ])),
  })).filter(row => Number.isFinite(row.x)).sort((a, b) => Number(a.x) - Number(b.x));
}

export function activityNumber(value: number | null, mode: ActivityMode): string {
  if (value == null) return '—';
  return mode === 'share'
    ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)}%`
    : value.toLocaleString('en-US');
}

/** Both views keep the period count and its share of the same network denominator. */
export function poolActivitySummary(value: number | null, denominator: number | null, mode: ActivityMode) {
  const countValue = activityValue(value, denominator, 'count');
  const shareValue = activityValue(value, denominator, 'share');
  return {
    primary: activityNumber(mode === 'count' ? countValue : shareValue, mode),
    secondary: mode === 'count'
      ? activityNumber(shareValue, 'share')
      : countValue == null ? '—' : `${activityNumber(countValue, 'count')} txs`,
  };
}
