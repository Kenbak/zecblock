/** Shareable NU7 fact cards. Pure models; the image route only draws them. */
import { nu7Average, type SpeedStory } from './block-speed';
import { estimateBlockArrival, estimateBlockArrivalDate, formatUpgradeDuration, type UpgradeSnapshot } from './network-upgrades';
import { HISTORICAL_UPGRADES } from './upgrade-history-data';

export const NU7_CARDS = ['countdown', 'blocks', 'nsm', 'readiness'] as const;
export type Nu7CardId = typeof NU7_CARDS[number];
export const NU7_CARD_LABELS: Record<Nu7CardId, string> = {
  countdown: 'Countdown', blocks: 'Blocks per day', nsm: 'NSM reserve', readiness: 'Node readiness',
};

export type CardBar = { value: number; nu7: boolean; projected: boolean };
export type Nu7Card = {
  eyebrow: string;
  headline: string;
  caption: string;
  detail: string;
  visual: { kind: 'progress'; percent: number; from: string; to: string }
    | { kind: 'bars'; bars: CardBar[]; unit: string }
    | { kind: 'share'; percent: number; label: string }
    | null;
  source: string;
};

type Network = 'mainnet' | 'testnet';
const DAY = 86_400;
const label = (network: Network) => network === 'mainnet' ? 'Zcash mainnet' : 'Zcash testnet';
const count = (value: number) => Math.round(value).toLocaleString('en-US');

/** Exact decimal from integer zatoshi, trimmed to two places for a headline. */
export function zatHeadline(zat: string, currency: string): string | null {
  if (!/^-?\d+$/.test(zat)) return null;
  const n = BigInt(zat); const negative = n < BigInt(0); const abs = negative ? -n : n;
  const whole = abs / BigInt(100_000_000); const cents = (abs % BigInt(100_000_000)) / BigInt(1_000_000);
  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}.${String(cents).padStart(2, '0')} ${currency}`;
}

export function countdownCard(network: Network, snapshot: UpgradeSnapshot | null): Nu7Card | null {
  const height = snapshot?.schedule.nu7Height;
  if (!snapshot || height == null) return null;
  const previous = HISTORICAL_UPGRADES.map(u => ({ label: u.label, height: u.heights[network] }))
    .filter(u => u.height < height).sort((a, b) => b.height - a.height)[0];
  if (snapshot.height >= height) {
    return {
      eyebrow: `NU7 · ${label(network)}`, headline: 'NU7 is live',
      caption: `Active since block #${height.toLocaleString('en-US')}`,
      detail: '25-second blocks and the Network Sustainability Mechanism.',
      visual: null, source: 'Serving-node upgrade schedule',
    };
  }
  const estimate = estimateBlockArrival(snapshot, height);
  const date = estimateBlockArrivalDate(snapshot, height);
  const remaining = height - snapshot.height;
  const percent = previous ? (snapshot.height - previous.height) / (height - previous.height) * 100 : 0;
  return {
    eyebrow: `NU7 · ${label(network)}`,
    headline: estimate ? formatUpgradeDuration(estimate.seconds) : `${count(remaining)} blocks`,
    caption: estimate ? 'until NU7 activates (estimated)' : 'until NU7 activates',
    detail: `${count(remaining)} blocks to go · block #${height.toLocaleString('en-US')}${date ? ` · ${date.label}` : ''}`,
    visual: previous ? { kind: 'progress', percent: Math.max(0, Math.min(100, percent)), from: previous.label, to: 'NU7' } : null,
    source: `Serving-node schedule · estimate from ${estimate?.basis ?? 'target spacing'}`,
  };
}

export function blocksCard(story: SpeedStory | null): Nu7Card | null {
  const after = story ? nu7Average(story) : null;
  if (!story || !after) return null;
  const perDay = (seconds: number) => DAY / seconds;
  // Testnet's minimum-difficulty days never followed a target; they are not a comparison.
  const bars = story.points.filter(point => point.kind !== 'irregular').slice(-28).map(point => ({ value: point.blocks, nu7: point.nu7, projected: point.kind === 'projected' }));
  const before = story.network === 'mainnet' ? story.before?.averageSeconds : null;
  const measured = story.phase === 'active';
  return {
    eyebrow: `NU7 · ${label(story.network)}`,
    headline: before ? `${count(perDay(before))} → ${count(perDay(after))}` : count(perDay(after)),
    caption: 'blocks per day',
    detail: before
      ? measured ? 'Measured 7-day averages before NU7 and with NU7.' : 'Measured 7-day average today → the 25-second NU7 target.'
      : 'Measured 7-day average with NU7.',
    visual: { kind: 'bars', bars, unit: 'blocks per UTC day' },
    source: 'Canonical block-header timestamps',
  };
}

export function nsmCard(network: Network, history: { totals?: { feesToNsmZat?: string | null }; reserve?: { growthSinceNu7Zat?: string | null; balanceZat?: string | null } } | null): Nu7Card | null {
  const growth = history?.reserve?.growthSinceNu7Zat;
  const currency = network === 'mainnet' ? 'ZEC' : 'TAZ';
  const headline = growth ? zatHeadline(growth, currency) : null;
  if (!headline) return null;
  const removal = history?.totals?.feesToNsmZat ? zatHeadline(history.totals.feesToNsmZat, currency) : null;
  const balance = history?.reserve?.balanceZat ? zatHeadline(history.reserve.balanceZat, currency) : null;
  return {
    eyebrow: `NU7 · ${label(network)}`, headline, caption: 'NSM reserve growth since NU7',
    detail: [removal && `Minimum fee removal ${removal}`, balance && `reserve ${balance}`].filter(Boolean).join(' · '),
    visual: null, source: 'Serving-node NSM counter and per-block fee accounting',
  };
}

export function readinessCard(network: Network, readiness: { referenceUpgrade?: string; latestProtocol?: number; readinessPct?: number | null; latestCount?: number; totalActive?: number } | null): Nu7Card | null {
  if (readiness?.referenceUpgrade !== 'NU7' || readiness.readinessPct == null || !readiness.totalActive) return null;
  return {
    eyebrow: `NU7 · ${label(network)}`, headline: `${readiness.readinessPct}%`,
    caption: 'of observed nodes advertise the NU7 protocol',
    detail: `${count(readiness.latestCount ?? 0)} of ${count(readiness.totalActive)} nodes report protocol ${readiness.latestProtocol} or newer. Self-reported.`,
    visual: { kind: 'share', percent: readiness.readinessPct, label: `Protocol ${readiness.latestProtocol}+` },
    source: 'Observed peer census',
  };
}
