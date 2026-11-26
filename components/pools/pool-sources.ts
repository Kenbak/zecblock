// Display model for /v1/shielded-pools/sources (server/lib/pool-sources.js).
// API categories are folded into a few display groups so the charts stay
// readable; the exact category amounts remain in the API and the CSV export.

export type SourcePool = 'sapling' | 'ironwood' | 'orchard';
export type SourcePeriod = '7d' | '30d' | '90d' | '1y' | 'all';

export interface SourceCategory { category: string; amountZat: string; txCount: number }
export interface SourceDetail { category: string; detail: string; label: string | null; amountZat: string; txCount: number }
export interface SourceBucket {
  date: string;
  coverage: 'complete' | 'partial' | 'none';
  days: number;
  inZat: string | null;
  outZat: string | null;
  netZat: string | null;
  in: Record<string, string> | null;
  out: Record<string, string> | null;
}
export interface PoolSourcesData {
  success: true;
  status: 'ok' | 'stale';
  staleReason: string | null;
  pool: string;
  period: string | null;
  from: string;
  to: string;
  granularity: 'day' | 'week' | 'month';
  coverage: { fromDate: string; throughDate: string; completeDays: number; partialDays: number; uncoveredDays: number };
  totals: { inZat: string; outZat: string; netZat: string } | null;
  sources: SourceCategory[] | null;
  destinations: SourceCategory[] | null;
  sourceDetails: SourceDetail[] | null;
  destinationDetails: SourceDetail[] | null;
  series: SourceBucket[];
}

export type GroupKey = 'pools' | 'mining' | 'rewards' | 'fees' | 'exchanges' | 'transparent' | 'unknown';
export interface Group { key: GroupKey; label: string; categories: string[] }

// Fixed order: color follows the group, never its rank.
export const IN_GROUPS: Group[] = [
  { key: 'pools', label: 'Other shielded pools', categories: ['migration'] },
  { key: 'mining', label: 'Mining rewards', categories: ['mining', 'coinbase'] },
  { key: 'rewards', label: 'Dev fund & other rewards', categories: ['funding', 'other_coinbase'] },
  { key: 'exchanges', label: 'Exchanges', categories: ['exchange'] },
  { key: 'transparent', label: 'Other public addresses', categories: ['transparent'] },
  { key: 'unknown', label: 'Unattributed', categories: ['unknown'] },
];
export const OUT_GROUPS: Group[] = [
  { key: 'pools', label: 'Other shielded pools', categories: ['migration'] },
  { key: 'fees', label: 'Fees', categories: ['fee'] },
  { key: 'exchanges', label: 'Exchanges', categories: ['exchange'] },
  { key: 'transparent', label: 'Other public addresses', categories: ['transparent'] },
  { key: 'unknown', label: 'Unattributed', categories: ['unknown'] },
];

/** Validated with the dataviz palette script (adjacent CVD and normal-vision separation pass in both modes). */
export function groupColors(theme: 'dark' | 'light'): Record<GroupKey, string> {
  const dark = theme === 'dark';
  const stone = dark ? '#7F897A' : '#526073';
  return {
    pools: dark ? '#B6A0E0' : '#7040B5',
    mining: dark ? '#F8BC21' : '#DB9E00',
    rewards: stone,
    fees: stone,
    exchanges: dark ? '#E2A66E' : '#A34A16',
    transparent: dark ? '#5E6670' : '#A3ADBA',
    unknown: dark ? '#3A3F47' : '#D5D9E0',
  };
}

export const zat = (v: string | null | undefined): number => (v == null ? 0 : Number(v) / 1e8);

export interface GroupTotal { key: GroupKey; label: string; zec: number; share: number; txCount: number }

/** Category totals folded into groups, in fixed order, with share of the direction's total. */
export function groupTotals(rows: SourceCategory[] | null, groups: Group[]): GroupTotal[] {
  const byCat = new Map((rows ?? []).map(r => [r.category, r]));
  const totals = groups.map(g => ({
    key: g.key, label: g.label,
    zec: g.categories.reduce((a, c) => a + zat(byCat.get(c)?.amountZat), 0),
    txCount: g.categories.reduce((a, c) => a + (byCat.get(c)?.txCount ?? 0), 0),
    share: 0,
  }));
  const sum = totals.reduce((a, t) => a + t.zec, 0);
  return totals.filter(t => t.zec > 0).map(t => ({ ...t, share: sum > 0 ? t.zec / sum : 0 }));
}

/** One chart row per bucket: inflow groups positive, outflow groups negative (ZEC). */
export function seriesRows(series: SourceBucket[]) {
  return series.map(b => {
    const row: Record<string, number | string | null> = { date: b.date, coverage: b.coverage };
    for (const g of IN_GROUPS) row[`in_${g.key}`] = b.in ? g.categories.reduce((a, c) => a + zat(b.in?.[c]), 0) : null;
    for (const g of OUT_GROUPS) row[`out_${g.key}`] = b.out ? -g.categories.reduce((a, c) => a + zat(b.out?.[c]), 0) : null;
    row.net = b.netZat == null ? null : zat(b.netZat);
    return row;
  });
}

/** Share of inflow from outside the shielded pools that came from mining rewards; null when there was none. */
export function miningShare(data: PoolSourcesData): number | null {
  const groups = groupTotals(data.sources, IN_GROUPS);
  const outside = groups.filter(g => g.key !== 'pools').reduce((a, g) => a + g.zec, 0);
  if (outside <= 0) return null;
  return (groups.find(g => g.key === 'mining')?.zec ?? 0) / outside;
}

/** Days the averages divide by: every covered day in the window. */
export const coveredDays = (data: PoolSourcesData) => data.coverage.completeDays + data.coverage.partialDays;

const CATEGORY_NAMES: Record<string, string> = {
  migration: 'Pool migration', mining: 'Mining', coinbase: 'Shielded coinbase', funding: 'Funding stream',
  other_coinbase: 'Other block reward', exchange: 'Exchange', transparent: 'Public address', fee: 'Fee', unknown: 'Unattributed',
};
export const categoryName = (c: string) => CATEGORY_NAMES[c] ?? c;

/** Display name for a detail: registry label, else a shortened address. */
export function detailName(d: SourceDetail): string {
  if (d.label) return d.label;
  if (d.category === 'exchange' && d.detail === 'other') return 'Other exchanges';
  if (/^t[13]/.test(d.detail)) return `${d.detail.slice(0, 8)}…${d.detail.slice(-4)}`;
  return d.detail;
}
