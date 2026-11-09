import { formatZecCompact } from './format-numbers';

export type PoolCurrency = 'zec' | 'usd';

/** Balances stay in ZEC; USD is always a current-quote equivalent, never a historical price. */
export function poolAmount(zec: number, currency: PoolCurrency, price: number | null): number | null {
  if (!Number.isFinite(zec)) return null;
  if (currency === 'zec') return zec;
  return price != null && Number.isFinite(price) && price > 0 ? zec * price : null;
}

export function formatPoolAmount(zec: number, currency: PoolCurrency, price: number | null, unit = true): string {
  const value = poolAmount(zec, currency, price);
  if (value == null) return '—';
  if (currency === 'zec') return `${value < 0 ? '-' : ''}${value === 0 ? '0' : formatZecCompact(Math.abs(value))}${unit ? ' ZEC' : ''}`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
}

/** Remaining issuance has no market value; only issued balances are converted to USD. */
export function formatSupplySegmentAmount(segment: { key: string; zat: number }, currency: PoolCurrency, price: number | null): string {
  if (segment.key === 'unmined' && currency === 'usd') return 'Not issued';
  return formatPoolAmount(segment.zat / 1e8, currency, price);
}

/** Calendar ticks on a real time axis. Missing daily samples do not compress elapsed time. */
export function poolDateAxis(dates: string[], width: number) {
  const times = dates.map(date => Date.parse(date)).filter(Number.isFinite);
  const start = times[0];
  const end = times.at(-1);
  const ticks: number[] = [];
  const count = Math.max(2, Math.min(12, Math.floor(width / 95)));
  const span = start != null && end != null ? (end - start) / 86400000 : 0;
  const yearly = span > 730;
  const monthly = span > 120;
  if (start != null && end != null) {
    const cursor = new Date(start);
    if (yearly) {
      const step = Math.max(1, Math.ceil(span / 365.25 / count));
      cursor.setUTCFullYear(Math.ceil(cursor.getUTCFullYear() / step) * step, 0, 1);
      while (cursor.getTime() <= end) {
        if (cursor.getTime() >= start) ticks.push(cursor.getTime());
        cursor.setUTCFullYear(cursor.getUTCFullYear() + step);
      }
    } else if (monthly) {
      const step = Math.max(1, Math.ceil(span / 30.44 / count));
      cursor.setUTCDate(1);
      while (cursor.getTime() <= end) {
        if (cursor.getTime() >= start) ticks.push(cursor.getTime());
        cursor.setUTCMonth(cursor.getUTCMonth() + step);
      }
    } else {
      const step = Math.max(1, Math.ceil(span / count));
      for (let at = start; at <= end; at += step * 86400000) ticks.push(at);
    }
    if (!ticks.length) ticks.push(start);
  }
  return {
    ticks,
    format: (value: number) => new Date(value).toLocaleDateString('en-GB', {
      timeZone: 'UTC', ...(yearly ? { year: 'numeric' } as const : monthly ? { month: 'short', year: '2-digit' } as const : { day: 'numeric', month: 'short' } as const),
    }),
  };
}
