/** Compact number formatting for dashboard stat cards */

export const ZATOSHI_PER_ZEC = 100_000_000;

/** Parse an exact integer wire amount before arithmetic; reject lossy conversions. */
export function parseSafeZatoshi(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !/^-?(0|[1-9]\d*)$/.test(value))) {
    throw new TypeError('Invalid zatoshi amount');
  }
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new RangeError('Unsafe zatoshi amount');
  return amount;
}

/** Aggregate in integer space, checking the result before chart/display conversion. */
export function sumZatoshis(values: readonly (number | string)[]): number {
  const total = values.reduce<bigint>((sum, value) => sum + BigInt(parseSafeZatoshi(value)), BigInt(0));
  const result = Number(total);
  if (!Number.isSafeInteger(result)) throw new RangeError('Unsafe zatoshi total');
  return result;
}

/** Convert zatoshis to ZEC. Accepts number, string, or bigint. */
export const zatToZec = (zat: number | string | bigint): number =>
  Number(zat) / ZATOSHI_PER_ZEC;

export function formatDifficulty(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(1);
}

/** Zcash's Equihash PoW is measured in solutions/sec (Sol/s), not raw hashes/sec. */
export function formatHashrate(hashrate: number): string {
  if (!Number.isFinite(hashrate)) return '—';
  if (hashrate >= 1e12) return `${(hashrate / 1e12).toFixed(2)} TSol/s`;
  if (hashrate >= 1e9) return `${(hashrate / 1e9).toFixed(2)} GSol/s`;
  if (hashrate >= 1e6) return `${(hashrate / 1e6).toFixed(2)} MSol/s`;
  if (hashrate >= 1e3) return `${(hashrate / 1e3).toFixed(2)} KSol/s`;
  return `${hashrate.toFixed(2)} Sol/s`;
}

export function formatZecCompact(zec: number): string {
  if (!Number.isFinite(zec)) return '—';
  if (zec >= 1_000_000) return `${(zec / 1_000_000).toFixed(2)}M`;
  if (zec >= 1_000) return `${(zec / 1_000).toFixed(1)}K`;
  return zec.toFixed(zec >= 10 ? 1 : 4);
}

/**
 * Readable ZEC amount (trailing zeros trimmed), e.g. `1.3767`, `46.273`.
 * 4 decimals is plenty for a "how much moved" glance — full 8-decimal
 * zatoshi precision belongs on the tx detail page, not a table row. Falls
 * back to `formatZecCompact` above 1000 ZEC. Falls back to full precision
 * below 0.0001 ZEC so genuine dust amounts don't just round to "0".
 * Only ever pass amounts that are genuinely public (e.g. a shield/deshield's
 * transparent-side value balance) — never derive this for fully-shielded txs.
 */
export function formatZecPrecise(zec: number): string {
  if (!Number.isFinite(zec)) return '—';
  if (zec === 0) return '0';
  if (Math.abs(zec) >= 1_000) return formatZecCompact(zec);
  const decimals = Math.abs(zec) < 0.0001 ? 8 : 4;
  return zec.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Exact ZEC down to the zatoshi, keeping at least 4 decimals so a column of
 * amounts stays aligned, e.g. `0.00132`, `0.00234694`, `0.0010`.
 */
export function formatZecExact(zec: number): string {
  if (!Number.isFinite(zec)) return '—';
  return zec.toFixed(8).replace(/(\.\d{4}\d*?)0+$/, '$1');
}

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400);
  if (days >= 60) {
    const years = Math.floor(days / 365);
    const months = Math.round((days % 365) / 30);
    if (years > 0 && months > 0) return `${years}y ${months}mo`;
    if (years > 0) return `${years}y`;
    return `${months}mo`;
  }
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatRelativeTime(unixSeconds: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
