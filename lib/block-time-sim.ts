/**
 * Block-time simulator: what a Zcash block target would mean, from the
 * random-arrival model that matches mainnet's measured 150s, 75s and 25s eras.
 * Pure functions; the page only draws them.
 */

export const SIM_MIN_SECONDS = 5;
export const SIM_MAX_SECONDS = 150;
export const SIM_DEFAULT_SECONDS = 25;
/** ZIP 315's recommended confirmations before received funds are spendable. */
export const SPENDABLE_CONFIRMATIONS = 10;
const DAY = 86_400;
const EULER_GAMMA = 0.5772156649;

export type SimPreset = { seconds: number; label: string; detail: string };
export const SIM_PRESETS: readonly SimPreset[] = [
  { seconds: 150, label: '150s', detail: 'Launch to Blossom, 2016–2019' },
  { seconds: 75, label: '75s', detail: 'Blossom to NU7, 2019–2026' },
  { seconds: 25, label: '25s', detail: 'Since NU7, Nov 2026' },
  { seconds: 20, label: '20s', detail: 'Proposed' },
  { seconds: 10, label: '10s', detail: 'Hypothetical' },
];

/**
 * Measured mainnet windows, from canonical block-header times (public SQL,
 * 2026-11-16). Each is about 30 days before the next upgrade, or everything
 * since NU7 activation at the time of measurement.
 */
export type SimEra = {
  targetSeconds: number; label: string; fromHeight: number; toHeight: number; intervals: number;
  meanSeconds: number; shareAtLeast60: number; shareAtLeast120: number; shareAtLeast300: number;
  /** Average of each complete UTC day's longest gap. */
  dailyLongestSeconds: number; days: number;
  /** Observed orphans ÷ canonical blocks; null before orphan observation began. */
  orphanRate: number | null;
};
export const SIM_ERAS: readonly SimEra[] = [
  { targetSeconds: 150, label: 'Before Blossom', fromHeight: 636_320, toHeight: 653_599, intervals: 17_280, meanSeconds: 150.68,
    shareAtLeast60: 0.6684, shareAtLeast120: 0.44722, shareAtLeast300: 0.13756, dailyLongestSeconds: 1_123, days: 30, orphanRate: null },
  { targetSeconds: 75, label: 'Before NU7', fromHeight: 3_508_000, toHeight: 3_543_404, intervals: 35_405, meanSeconds: 75.36,
    shareAtLeast60: 0.4599, shareAtLeast120: 0.20664, shareAtLeast300: 0.01887, dailyLongestSeconds: 618, days: 30, orphanRate: 101 / 35_405 },
  { targetSeconds: 25, label: 'With NU7', fromHeight: 3_543_406, toHeight: 3_579_544, intervals: 36_139, meanSeconds: 25.13,
    shareAtLeast60: 0.094, shareAtLeast120: 0.00877, shareAtLeast300: 0, dailyLongestSeconds: 216, days: 9, orphanRate: 76 / 36_040 },
];
/** Average size of a block holding only its coinbase transaction since NU7, in bytes. */
export const EMPTY_BLOCK_BYTES = 1_943;

/** Measured range: the timing model is checked against data from 25s to 150s. */
export type SimZone = 'measured' | 'extrapolated' | 'beyond';
export function simZone(seconds: number): SimZone {
  return seconds >= 25 ? 'measured' : seconds >= 10 ? 'extrapolated' : 'beyond';
}

export function clampSeconds(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) return SIM_DEFAULT_SECONDS;
  return Math.min(SIM_MAX_SECONDS, Math.max(SIM_MIN_SECONDS, Math.round(n)));
}

export const blocksPerDay = (seconds: number) => DAY / seconds;

/** Share of block gaps lasting at least `limit` seconds: e^(−limit / T). */
export const shareAtLeast = (seconds: number, limit: number) => Math.exp(-limit / seconds);

/** P(sum of k gaps ≤ x) for the Erlang(k, T) distribution. */
function erlangCdf(x: number, k: number, seconds: number): number {
  const lambda = x / seconds;
  let term = 1; let sum = 1;
  for (let i = 1; i < k; i++) { term *= lambda / i; sum += term; }
  return 1 - Math.exp(-lambda) * sum;
}

/** Time by which a share `p` of k-block waits finish. */
export function confirmationsQuantile(seconds: number, p: number, k = SPENDABLE_CONFIRMATIONS): number {
  let lo = 0; let hi = seconds * k * 10;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (erlangCdf(mid, k, seconds) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Expected longest gap among one day's blocks: T × (ln n + γ). */
export const typicalDailyLongest = (seconds: number) => seconds * (Math.log(blocksPerDay(seconds)) + EULER_GAMMA);

/** Fixed propagation delay implied by the latest measured orphan rate. */
const MEASURED = SIM_ERAS[2];
const PROPAGATION_SECONDS = -MEASURED.meanSeconds * Math.log(1 - MEASURED.orphanRate!);

export type OrphanView = { kind: 'measured'; rate: number } | { kind: 'estimate'; rate: number } | { kind: 'none'; reason: 'between' | 'beyond' | 'unobserved' };

/**
 * Measured orphan rate at a measured era. Below 25s, an estimate that scales
 * today's measurement with block rate (fixed propagation delay). The 75s era's
 * higher rate shows this delay is not constant, so no curve is drawn between
 * measured points, and nothing below 10s, where Zcash has no data.
 */
export function orphanView(seconds: number): OrphanView {
  const era = SIM_ERAS.find(e => e.targetSeconds === seconds);
  if (era) return era.orphanRate == null ? { kind: 'none', reason: 'unobserved' } : { kind: 'measured', rate: era.orphanRate };
  const zone = simZone(seconds);
  if (zone === 'beyond') return { kind: 'none', reason: 'beyond' };
  if (zone === 'measured') return { kind: 'none', reason: 'between' };
  return { kind: 'estimate', rate: 1 - Math.exp(-PROPAGATION_SECONDS / seconds) };
}

export type SimResult = {
  seconds: number; zone: SimZone;
  spendableMean: number; spendableP90: number; firstConfirmationMean: number;
  blocksPerDay: number; shareAtLeast60: number; shareAtLeast120: number; typicalDailyLongest: number;
  orphans: OrphanView; orphansPerDay: number | null; emptyBlockBytesPerDay: number;
  era: SimEra | null;
};

export function simulate(input: number): SimResult {
  const seconds = clampSeconds(input);
  const perDay = blocksPerDay(seconds);
  const orphans = orphanView(seconds);
  return {
    seconds, zone: simZone(seconds),
    spendableMean: seconds * SPENDABLE_CONFIRMATIONS,
    spendableP90: confirmationsQuantile(seconds, 0.9),
    // Random arrivals are memoryless: a transaction waits a full average gap for its first block.
    firstConfirmationMean: seconds,
    blocksPerDay: perDay,
    shareAtLeast60: shareAtLeast(seconds, 60),
    shareAtLeast120: shareAtLeast(seconds, 120),
    typicalDailyLongest: typicalDailyLongest(seconds),
    orphans, orphansPerDay: orphans.kind === 'none' ? null : orphans.rate * perDay,
    emptyBlockBytesPerDay: perDay * EMPTY_BLOCK_BYTES,
    era: SIM_ERAS.find(era => era.targetSeconds === seconds) ?? null,
  };
}

export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5_400) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3_600).toFixed(1)} h`;
}

/** "1 in 118 gaps" style frequency, or a percentage when common. */
export function formatShare(share: number): string {
  if (share >= 0.1) return `${Math.round(share * 100)}%`;
  if (share >= 0.01) return `${(share * 100).toFixed(1)}%`;
  if (share <= 0) return '0%';
  const n = 1 / share;
  if (n > 1e6) return 'less than 1 in a million';
  return `1 in ${n >= 1_000 ? Math.round(n / 100) * 100 : Math.round(n)}`;
}

/**
 * Other chains at their protocol block targets. `wait` is only given where
 * the chain has a clear, documented rule; each says what it measures.
 */
/** `logo` is a local public path; null draws the chain's initial. */
export type ChainRef = { name: string; logo: string | null; blockSeconds: number; blockLabel: string; wait: { seconds: number; rule: string } | null; consensus: string };
export const ZCASH_LOGO = '/tokens/zec.png';
export const CHAIN_REFS: readonly ChainRef[] = [
  { name: 'Bitcoin', logo: '/chains/btc.png', blockSeconds: 600, blockLabel: '10 min', wait: { seconds: 3_600, rule: '6 confirmations, a common convention' }, consensus: 'Proof of work' },
  { name: 'Litecoin', logo: '/chains/ltc.png', blockSeconds: 150, blockLabel: '2.5 min', wait: { seconds: 900, rule: '6 confirmations, a common convention' }, consensus: 'Proof of work' },
  { name: 'Monero', logo: '/tokens/xmr.png', blockSeconds: 120, blockLabel: '2 min', wait: { seconds: 1_200, rule: '10-block lock before funds can be spent' }, consensus: 'Proof of work' },
  { name: 'Dogecoin', logo: '/chains/doge.png', blockSeconds: 60, blockLabel: '1 min', wait: null, consensus: 'Proof of work' },
  { name: 'Cardano', logo: '/chains/cardano.png', blockSeconds: 20, blockLabel: '20s average', wait: null, consensus: 'Proof of stake' },
  { name: 'Ethereum', logo: '/chains/eth.png', blockSeconds: 12, blockLabel: '12s slots', wait: { seconds: 768, rule: 'finality after two epochs (64 slots), nominal' }, consensus: 'Proof of stake' },
  { name: 'Kaspa', logo: null, blockSeconds: 0.1, blockLabel: '0.1s (10 per second)', wait: null, consensus: 'Proof of work, blockDAG' },
];
