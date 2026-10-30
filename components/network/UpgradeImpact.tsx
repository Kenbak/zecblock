'use client';

import Link from 'next/link';
import { useApiQuery } from '@/hooks/useApiQuery';
import type { AppNetwork } from '@/lib/network';
import { readUpgradeSnapshot } from '@/lib/network-upgrades';
import { formatZecCompact } from '@/lib/format-numbers';
import { normalizeMigrationData } from '@/app/ironwood/components/api-data';
import type { Overview } from '@/app/ironwood/components/types';

type Stats = {
  mining?: { avgBlockTime?: number | null; targetBlockTime?: number | null; blocks24h?: number | null };
  supply?: { chain?: string; sapling?: number | null; orchard?: number | null } | null;
};
type Accounting = {
  schedule?: { network?: string; nu7Height?: number | null } | null;
  nodeHeight?: number;
  nsmBalanceZat?: number | string | null;
};
type Turnstile = {
  since?: string;
  summary?: { totalDeshielded?: number; heldPercent?: number; reshieldedPercent?: number };
};
type ImpactMetric = { label: string; value: string; href: string; actionLabel: string; note: string; title?: string };

function ArrowRight() {
  return <svg aria-hidden="true" focusable="false" className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
  </svg>;
}

const finiteAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validHeight = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 500_000_000;
const percent = (value: unknown) => finiteAmount(value) && value <= 100 ? `${value.toFixed(1)}%` : 'Unavailable';

/** Preserve signed reserve amounts in integer space, including single-zatoshi amounts. */
function reserveAmount(value: unknown, currency: string): string | null {
  if ((typeof value !== 'string' || !/^-?(0|[1-9]\d*)$/.test(value))
    && (typeof value !== 'number' || !Number.isSafeInteger(value))) return null;
  const amount = BigInt(value as string | number);
  const zero = BigInt(0);
  const scale = BigInt(100_000_000);
  const absolute = amount < zero ? -amount : amount;
  return `${amount < zero ? '-' : ''}${(absolute / scale).toLocaleString('en-US')}.${String(absolute % scale).padStart(8, '0')} ${currency}`;
}

function migrationSnapshot(data: Overview | null, network: AppNetwork): Overview | null {
  if (data?.network !== network) return null;
  try {
    return normalizeMigrationData(data);
  } catch {
    return null;
  }
}

/** A small preview of existing dashboards, rather than a second analytics page. */
export function UpgradeImpact({ upgradeId, network, active }: {
  upgradeId: string; network: AppNetwork; active: boolean;
}) {
  const supported = network !== 'crosslink-testnet';
  const usesStats = supported && ['nu7', 'nu62', 'sapling', 'nu5', 'blossom'].includes(upgradeId);
  const stats = useApiQuery<Stats>('/v1/network/stats', undefined, { enabled: usesStats, refreshInterval: 30_000 });
  const accounting = useApiQuery<Accounting>('/v1/network/accounting', undefined, { enabled: supported && upgradeId === 'nu7' && active, refreshInterval: 30_000 });
  const migration = useApiQuery<Overview>('/v1/migration/overview', undefined, { enabled: supported && upgradeId === 'nu63', refreshInterval: 30_000 });
  const turnstile = useApiQuery<Turnstile>('/v1/shielded-pools/turnstile', { since: '2026-06-01' }, { enabled: supported && upgradeId === 'nu62', refreshInterval: 60_000 });

  if (!supported) return null;
  const currency = network === 'mainnet' ? 'ZEC' : 'TAZ';
  const chain = network === 'mainnet' ? 'main' : 'test';
  const node = readUpgradeSnapshot(stats.data, network);
  const statsMatch = node != null && (stats.data?.supply?.chain == null || stats.data.supply.chain === chain);
  const interval = statsMatch && finiteAmount(stats.data?.mining?.avgBlockTime) && stats.data.mining.avgBlockTime > 0
    ? `${stats.data.mining.avgBlockTime.toFixed(1)}s` : 'Unavailable';
  const observedNote = stats.error ? 'Last available observation' : 'Observed block interval';
  let metrics: ImpactMetric[] = [];

  if (upgradeId === 'nu7') {
    const activation = accounting.data?.schedule?.nu7Height;
    const verifiedActive = active && !accounting.error && accounting.data?.schedule?.network === chain
      && validHeight(activation) && activation > 0 && validHeight(accounting.data.nodeHeight)
      && accounting.data.nodeHeight >= activation;
    const reserve = verifiedActive ? reserveAmount(accounting.data?.nsmBalanceZat, currency) : null;
    // Blocks per day is one unambiguous window; averages elsewhere use other windows.
    const blocks24h = statsMatch && Number.isSafeInteger(stats.data?.mining?.blocks24h) ? stats.data!.mining!.blocks24h! : null;
    const target = statsMatch ? stats.data?.mining?.targetBlockTime : null;
    const targetPerDay = finiteAmount(target) && target > 0 ? Math.round(86_400 / target) : null;
    metrics = [
      { label: 'Blocks · last 24h', value: blocks24h != null ? blocks24h.toLocaleString('en-US') : 'Unavailable', href: '/network/block-speed', actionLabel: 'View block speed',
        note: `${stats.error ? 'Last available · ' : ''}${active ? `NU7 target ${(86_400 / 25).toLocaleString('en-US')} a day` : `Target ${targetPerDay?.toLocaleString('en-US') ?? '—'} today · ${(86_400 / 25).toLocaleString('en-US')} with NU7`}` },
      { label: 'NSM reserve', value: active ? reserve ?? 'Unavailable' : 'At NU7', href: '/network#nu7-accounting', actionLabel: 'Explore NSM',
        note: active ? 'Recorded separately from issued supply' : 'Accounting begins at activation' },
    ];
  } else if (upgradeId === 'nu63') {
    const overview = migrationSnapshot(migration.data, network);
    const orchard = overview?.poolSizes?.orchardZat;
    const migrated = overview?.inflowSources?.fromOrchardZat;
    const denominator = finiteAmount(orchard) && finiteAmount(migrated) ? orchard + migrated : null;
    const migratedPercent = denominator != null && Number.isSafeInteger(denominator) && denominator > 0
      ? migrated! / denominator * 100 : null;
    const balance = overview?.poolSizes?.ironwoodZat;
    const balanceZec = finiteAmount(balance) ? balance / 100_000_000 : null;
    const retained = migration.error ? 'Last available · ' : '';
    metrics = [
      { label: 'Orchard migration', value: percent(migratedPercent), href: '/ironwood', actionLabel: 'View migration', note: `${retained}Orchard → Ironwood value` },
      { label: 'Ironwood balance', value: balanceZec != null ? `${formatZecCompact(balanceZec)} ${currency}` : 'Unavailable',
        href: '/ironwood#supply', actionLabel: 'View pool supply', note: `${retained}Current pool balance`,
        title: balanceZec != null ? reserveAmount(balance, currency) ?? undefined : undefined },
    ];
  } else if (upgradeId === 'nu62') {
    const summary = statsMatch && turnstile.data?.since === '2026-06-01' ? turnstile.data.summary : null;
    const hasExits = finiteAmount(summary?.totalDeshielded) && summary.totalDeshielded > 0;
    const retained = turnstile.error || stats.error ? 'Last available · ' : '';
    metrics = [
      { label: 'Still held', value: hasExits ? percent(summary?.heldPercent) : 'Unavailable',
        href: '/turnstile?period=nu6.2', actionLabel: 'View pool flows', note: `${retained}Public exits since Jun 1, 2026` },
      { label: 'Reshielded', value: hasExits ? percent(summary?.reshieldedPercent) : 'Unavailable',
        href: '/turnstile?period=nu6.2', actionLabel: 'View pool flows', note: `${retained}Latest tracked destination` },
    ];
  } else if (upgradeId === 'sapling' || upgradeId === 'nu5') {
    const pool = upgradeId === 'sapling' ? 'sapling' : 'orchard';
    const balance = statsMatch ? stats.data?.supply?.[pool] : null;
    metrics = [{ label: `Current ${pool === 'sapling' ? 'Sapling' : 'Orchard'} balance`,
      value: finiteAmount(balance) ? `${formatZecCompact(balance)} ${currency}` : 'Unavailable', href: '/pools#supply', actionLabel: 'View pool supply',
      note: stats.error ? 'Last available pool snapshot' : 'Current pool supply',
      title: finiteAmount(balance) ? `${balance.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${currency}` : undefined }];
  } else if (upgradeId === 'blossom') {
    const target = statsMatch ? stats.data?.mining?.targetBlockTime : null;
    metrics = [{ label: 'Current block interval', value: interval, href: '/network/block-speed', actionLabel: 'View block speed',
      note: `${observedNote}${finiteAmount(target) && target > 0 ? ` · current target ${target}s` : ''}` }];
  }

  if (!metrics.length) return null;
  return <div role="group" aria-label="Upgrade dashboard preview" className={`grid grid-cols-1 ${metrics.length > 1 ? 'lg:grid-cols-2' : ''} gap-x-8 gap-y-4 border-y border-cipher-border py-4 mt-5`}>
    {metrics.map((metric, index) => <div key={metric.label} className={`flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${index > 0 ? 'border-t border-cipher-border pt-4 lg:border-t-0 lg:border-l lg:pl-6 lg:pt-0' : ''}`}>
      <dl className="min-w-0 flex-1">
        <dt className="text-caption text-muted">{metric.label}</dt>
        <dd className="mt-1">
          <span title={metric.title} className="block font-mono text-xl text-primary tabular-nums break-words">{metric.value}</span>
          <span className="block text-caption text-muted mt-1">{metric.note}</span>
        </dd>
      </dl>
      <Link href={metric.href} className="btn btn-sm btn-secondary shrink-0 self-start sm:self-center">
        {metric.actionLabel}<ArrowRight />
      </Link>
    </div>)}
  </div>;
}
