/** One day of the daily activity series: transparent excludes coinbase. */
export interface ActivityDay {
  shielded: number;
  transparent: number;
}

/** The window the headline shielded share covers, in UTC days including today so far. */
export const SHIELDED_SHARE_DAYS = 30;

/**
 * Shielded transactions as a percentage of shielded plus non-coinbase transparent
 * transactions, across the days given. This is the figure the Daily Activity chart
 * shows for its selected range, so a headline and its chart can never disagree.
 */
export function shieldedShare(days: readonly ActivityDay[] | null | undefined): number | null {
  if (!days || days.length === 0) return null;
  let shielded = 0;
  let total = 0;
  for (const day of days) {
    const s = Number(day.shielded);
    const t = Number(day.transparent);
    if (!Number.isFinite(s) || !Number.isFinite(t)) continue;
    shielded += s;
    total += s + t;
  }
  return total > 0 ? (shielded / total) * 100 : null;
}

/**
 * The headline share: the newest {@link SHIELDED_SHARE_DAYS} days, newest first as the
 * API returns them. Null when fewer days exist, so a shorter window is never labelled 30d.
 */
export function recentShieldedShare(daysNewestFirst: readonly ActivityDay[] | null | undefined): number | null {
  if (!daysNewestFirst || daysNewestFirst.length < SHIELDED_SHARE_DAYS) return null;
  return shieldedShare(daysNewestFirst.slice(0, SHIELDED_SHARE_DAYS));
}
