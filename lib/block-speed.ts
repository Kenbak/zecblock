/** Block-speed story built from one serving-node network's canonical header timestamps. */
import { ANNOUNCED_MAINNET_NU7 } from '@/lib/network-upgrades';

export type SpeedSummary = {
  fromHeight: number; toHeight: number; fromTimestamp: number; toTimestamp: number; intervals: number;
  averageSeconds: number | null; medianSeconds: number | null; p90Seconds: number | null; targetSeconds: number | null;
};
export type SpeedDay = {
  date: string; start: number; nu7: boolean; targetSeconds: number | null; firstHeight: number; lastHeight: number;
  intervals: number; averageSeconds: number | null; medianSeconds: number | null; p90Seconds: number | null; complete: boolean;
};
export type BlockSpeedPayload = {
  network: 'main' | 'test'; observedAt: string; indexedHeight: number; tipTimestamp: number;
  schedule: { nu7Height: number | null };
  activation: { height: number; timestamp: number | null } | null;
  coverage: { fromTimestamp: number | null; complete: boolean; historyDays: number };
  days: SpeedDay[];
  windows: { latest: SpeedSummary | null; beforeUpgrade: SpeedSummary | null };
};

/** NU7's consensus target spacing, as encoded in the serving-node schedule. */
export const NU7_TARGET_SECONDS = 25;

/** ZIP 315 recommended wallet confirmation policy. */
export const CONFIRMATION_DEPTHS = [
  { blocks: 1, label: 'First confirmation', detail: 'Included in a block' },
  { blocks: 3, label: '3 confirmations', detail: 'Your own change can be spent (ZIP 315)' },
  { blocks: 10, label: '10 confirmations', detail: 'Received funds can be spent (ZIP 315)' },
] as const;
export const SPENDABLE_CONFIRMATIONS = 10;
export const ZIP_315_URL = 'https://zips.z.cash/zip-0315';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const finiteOrNull = (value: unknown) => value === null || finite(value);

function isSummary(value: unknown): value is SpeedSummary {
  const s = value as SpeedSummary;
  return !!s && typeof s === 'object' && [s.fromHeight, s.toHeight, s.fromTimestamp, s.toTimestamp, s.intervals].every(finite)
    && [s.averageSeconds, s.medianSeconds, s.p90Seconds, s.targetSeconds].every(finiteOrNull);
}

function isDay(value: unknown): value is SpeedDay {
  const d = value as SpeedDay;
  return !!d && typeof d === 'object' && typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date)
    && [d.start, d.firstHeight, d.lastHeight, d.intervals].every(finite)
    && [d.averageSeconds, d.medianSeconds, d.p90Seconds, d.targetSeconds].every(finiteOrNull)
    && typeof d.nu7 === 'boolean' && typeof d.complete === 'boolean';
}

/** Reject malformed or wrong-network responses rather than presenting them as observations. */
export function readBlockSpeed(value: unknown, expected: 'main' | 'test'): BlockSpeedPayload | null {
  const p = value as BlockSpeedPayload;
  if (!p || typeof p !== 'object' || p.network !== expected || !finite(p.indexedHeight) || !finite(p.tipTimestamp)) return null;
  if (!Array.isArray(p.days) || !p.days.every(isDay) || !p.windows || typeof p.windows !== 'object') return null;
  if (p.windows.latest !== null && !isSummary(p.windows.latest)) return null;
  if (p.windows.beforeUpgrade !== null && !isSummary(p.windows.beforeUpgrade)) return null;
  if (!p.schedule || !finiteOrNull(p.schedule.nu7Height)) return null;
  return p;
}

/**
 * One daily point of the host network. `measured` days come from block headers;
 * `projected` days draw the consensus target before mainnet activation;
 * `irregular` marks testnet's minimum-difficulty era, which never followed its target.
 */
export type SpeedPoint = {
  key: string; date: string; nu7: boolean; kind: 'measured' | 'projected' | 'irregular';
  averageSeconds: number; targetSeconds: number | null; lastHeight: number | null;
  /** Blocks with header times in this UTC day; projected days use the target pace. */
  blocks: number;
};
export type SpeedActivation = { height: number; date: string | null; status: 'active' | 'scheduled' | 'announced' };
export type SpeedStory = {
  network: 'mainnet' | 'testnet';
  /** `upcoming`: mainnet before NU7, the NU7 side is the target. `active`: both sides are measured. */
  phase: 'upcoming' | 'active';
  /** Measured comparable blocks before NU7; null on testnet, whose pre-NU7 timing is not comparable. */
  before: SpeedSummary | null;
  /** Measured NU7 blocks; null while upcoming. */
  after: SpeedSummary | null;
  /** Testnet's pre-NU7 window, shown only to explain why it is excluded. */
  irregular: SpeedSummary | null;
  activation: SpeedActivation | null;
  points: SpeedPoint[];
  /** Measured NU7 average on the other network, as supporting evidence while mainnet is upcoming. */
  testnetNu7: SpeedSummary | null;
};

const HISTORY_POINTS = 21;
const PROJECTED_NU7_DAYS = 7;
const MAX_PROJECTED_DAYS = 30;
const DAY = 86_400;

const isoDay = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => isoDay(Date.parse(`${date}T00:00:00Z`) / 1000 + days * DAY);

function measuredPoints(days: SpeedDay[], network: SpeedStory['network'], limit: number): SpeedPoint[] {
  return days.filter(day => day.complete && day.averageSeconds != null).slice(-limit).map(day => ({
    key: `${day.date}-${day.nu7 ? 'nu7' : 'pre'}`, date: day.date, nu7: day.nu7, averageSeconds: day.averageSeconds!, targetSeconds: day.targetSeconds,
    kind: network === 'testnet' && !day.nu7 ? 'irregular' : 'measured', lastHeight: day.lastHeight,
    blocks: day.lastHeight - day.firstHeight + 1,
  }));
}

/** Upcoming mainnet activation: the serving-node schedule wins over the editorial announcement. */
function upcomingActivation(host: BlockSpeedPayload, preTarget: number | null): SpeedActivation {
  const scheduled = host.schedule.nu7Height;
  if (scheduled == null) return { height: ANNOUNCED_MAINNET_NU7.height, date: ANNOUNCED_MAINNET_NU7.date, status: 'announced' };
  const date = preTarget ? isoDay(host.tipTimestamp + Math.max(0, scheduled - host.indexedHeight) * preTarget) : null;
  return { height: scheduled, date, status: 'scheduled' };
}

/** Target days from today to activation, then a week at the NU7 target. */
function projectedPoints(from: string, activationDate: string | null, preTarget: number | null): SpeedPoint[] {
  if (!activationDate) return [];
  const point = (date: string, nu7: boolean, target: number): SpeedPoint =>
    ({ key: `${date}-projected`, date, nu7, kind: 'projected', averageSeconds: target, targetSeconds: target, lastHeight: null, blocks: Math.round(DAY / target) });
  const points: SpeedPoint[] = [];
  if (preTarget != null) {
    for (let date = from; date < activationDate && points.length < MAX_PROJECTED_DAYS; date = addDays(date, 1)) points.push(point(date, false, preTarget));
  }
  const nu7Start = activationDate > from ? activationDate : from;
  for (let i = 0; i < PROJECTED_NU7_DAYS; i++) points.push(point(addDays(nu7Start, i), true, NU7_TARGET_SECONDS));
  return points;
}

/**
 * Each network tells its own story. Mainnet shows measured days, then the
 * consensus target until NU7 is live; once it is, measured days replace the
 * projection. Testnet shows its NU7 era; its earlier minimum-difficulty days
 * are marked irregular rather than used as a baseline.
 */
export function buildSpeedStory(host: BlockSpeedPayload | null, peer: BlockSpeedPayload | null = null): SpeedStory | null {
  if (!host) return null;
  const network = host.network === 'main' ? 'mainnet' : 'testnet';
  const measured = measuredPoints(host.days, network, network === 'testnet' ? host.days.length : HISTORY_POINTS);
  if (host.activation) {
    return {
      network, phase: 'active', points: measured, testnetNu7: null,
      before: network === 'mainnet' ? host.windows.beforeUpgrade : null,
      after: host.windows.latest,
      irregular: network === 'testnet' ? host.windows.beforeUpgrade : null,
      activation: { height: host.activation.height, date: host.activation.timestamp != null ? isoDay(host.activation.timestamp) : null, status: 'active' },
    };
  }
  if (network === 'testnet') {
    return { network, phase: 'upcoming', points: measured, before: null, after: null, irregular: host.windows.latest, activation: null, testnetNu7: null };
  }
  const preTarget = host.windows.latest?.targetSeconds ?? measured.at(-1)?.targetSeconds ?? null;
  const activation = upcomingActivation(host, preTarget);
  return {
    network, phase: 'upcoming', before: host.windows.latest, after: null, irregular: null, activation,
    points: [...measured, ...projectedPoints(isoDay(host.tipTimestamp), activation.date, preTarget)],
    testnetNu7: peer?.network === 'test' && peer.activation ? peer.windows.latest : null,
  };
}

/** NU7 side of a comparison: measured once active, otherwise the consensus target. */
export function nu7Average(story: SpeedStory): number | null {
  return story.phase === 'active' ? story.after?.averageSeconds ?? null : story.network === 'mainnet' ? NU7_TARGET_SECONDS : null;
}

/** Expected wait for N blocks, assuming the next block includes the transaction and blocks arrive at random at this average pace. */
export function confirmationSeconds(averageSeconds: number | null | undefined, blocks: number): number | null {
  return averageSeconds != null && averageSeconds > 0 ? averageSeconds * blocks : null;
}

export function formatWait(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  return `${(seconds / 60).toFixed(1)} min`;
}

export function formatSeconds(seconds: number | null | undefined): string {
  return seconds == null || !Number.isFinite(seconds) ? '—' : `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

export function formatSpeedup(ratio: number | null): string {
  return ratio == null ? '—' : `${ratio.toFixed(1)}×`;
}

export function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
