'use client';

import { useState } from 'react';

export const REFERENCE_DENOMS = [
  { value: 0.01, label: '0.01 ZEC' },
  { value: 0.1, label: '0.1 ZEC' },
  { value: 1, label: '1 ZEC' },
  { value: 10, label: '10 ZEC' },
  { value: 100, label: '100 ZEC' },
];

export const DENOM_BUCKETS = [
  0.001, 0.002, 0.005,
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000,
];

export function formatDenomBucketLabel(denom: number): string {
  if (denom >= 1) return String(denom);
  const s = denom.toString();
  return s.startsWith('0.') ? s.slice(1) : s;
}

export const COMPLIANCE_GRADES = [
  {
    key: 'green' as const,
    label: 'ZIP-318 compliant',
    checks: '3/3',
    hint: 'Standard denomination, correct actions (O:2, I:1), boundary-aligned anchor',
  },
  {
    key: 'partial2' as const,
    label: 'Partial',
    checks: '2/3',
    hint: 'Passes two of three ZIP-318 checks',
  },
  {
    key: 'partial1' as const,
    label: 'Partial',
    checks: '1/3',
    hint: 'Passes one of three ZIP-318 checks',
  },
  {
    key: 'weak' as const,
    label: 'Weak',
    checks: '0/3',
    hint: 'Fails all three ZIP-318 checks',
  },
];

export function ComplianceSummary({
  stats,
  privacyColors,
  mode,
}: {
  stats: { total: number; green: number; partial2: number; partial1: number; weak: number; greenVol: number; partial2Vol: number; partial1Vol: number; weakVol: number };
  privacyColors: Record<string, string>;
  mode: 'volume' | 'txs';
}) {
  const [hovered, setHovered] = useState<(typeof COMPLIANCE_GRADES)[number]['key'] | null>(null);

  const colorMap = {
    green: privacyColors.best,
    partial2: privacyColors.denomPadded,
    partial1: privacyColors.distinctUnpadded,
    weak: privacyColors.worst,
  };
  const countMap = {
    green: stats.green,
    partial2: stats.partial2,
    partial1: stats.partial1,
    weak: stats.weak,
  };
  const volMap = {
    green: stats.greenVol,
    partial2: stats.partial2Vol,
    partial1: stats.partial1Vol,
    weak: stats.weakVol,
  };

  const segments = COMPLIANCE_GRADES.map((g) => ({
    ...g,
    count: countMap[g.key],
    pct: stats.total > 0 ? (countMap[g.key] / stats.total) * 100 : 0,
    volPct: volMap[g.key],
    color: colorMap[g.key],
  }));

  const greenPct = stats.total > 0 ? (stats.green / stats.total) * 100 : 0;
  const greenVolPct = stats.greenVol;
  const hoveredSegment = hovered ? segments.find((s) => s.key === hovered) : null;

  const headlinePct = hoveredSegment
    ? (mode === 'volume' ? hoveredSegment.volPct : hoveredSegment.pct)
    : (mode === 'volume' ? greenVolPct : greenPct);

  return (
    <div
      className="mb-3 rounded-lg border border-cipher-border/30 bg-glass-3 px-3 py-2"
      onMouseLeave={() => setHovered(null)}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div
            className="text-xl font-semibold tabular-nums leading-none tracking-tight transition-colors"
            style={{ color: hoveredSegment?.color ?? privacyColors.best }}
          >
            {headlinePct.toFixed(hoveredSegment ? 1 : 0)}%
          </div>
          <div className="mt-1 min-h-8 text-caption font-mono leading-snug text-muted">
            {hoveredSegment ? (
              <>
                <span className="text-secondary">{hoveredSegment.label} ({hoveredSegment.checks})</span>
                {' · '}
                <span className="text-primary">{hoveredSegment.count.toLocaleString()} txs</span>
                {' · '}
                {hoveredSegment.hint}
                {' · '}
                {hoveredSegment.volPct.toFixed(0)}% by volume
              </>
            ) : (
              <>
                <span className="text-secondary">ZIP-318 compliant ({stats.green}/{stats.total})</span>
                {' · '}
                <span className="text-primary">{stats.green.toLocaleString()} txs</span>
                {' · '}
                Standard denomination, correct actions (O:2, I:1), boundary-aligned anchor
              </>
            )}
          </div>
        </div>

        <span className="shrink-0 text-caption font-mono text-muted pt-0.5">{stats.total.toLocaleString()} txs</span>
      </div>

      <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-cipher-border/20">
        {segments.filter((s) => s.count > 0).map((s) => (
          <button
            key={s.key}
            type="button"
            className="relative h-full transition-[width,opacity,filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-inset"
            style={{
              width: `${mode === 'volume' ? s.volPct : s.pct}%`,
              backgroundColor: s.color,
              minWidth: 4,
              opacity: hovered && hovered !== s.key ? 0.45 : 1,
              boxShadow: hovered === s.key ? `inset 0 0 0 1px ${s.color}, 0 0 0 2px rgba(255,255,255,0.15)` : undefined,
            }}
            onMouseEnter={() => setHovered(s.key)}
            onFocus={() => setHovered(s.key)}
            aria-label={`${s.label} (${s.checks}): ${s.pct.toFixed(1)}%, ${s.count} transactions, ${s.volPct.toFixed(0)}% by volume. ${s.hint}`}
          />
        ))}
      </div>
    </div>
  );
}

const FAMILY_META: Record<string, { label: string; color: string }> = {
  'zip318-current-sdk': { label: 'ZODL / Vizor', color: '#4ade80' },
  'cake-zkool2-compatible': { label: 'Cake/zkool2', color: '#f97316' },
  'multi-action-migration': { label: 'Multi-action', color: '#B6A0E0' },
  unknown: { label: 'Unknown', color: '#6b7280' },
};

export function FamiliesTab({
  counts,
  compliance,
  total,
  privacyColors,
}: {
  counts: Record<string, number>;
  compliance: Record<string, Record<string, number>>;
  total: number;
  privacyColors: Record<string, string>;
}) {
  const gradeColors = {
    green: privacyColors.best,
    partial2: privacyColors.denomPadded,
    partial1: privacyColors.distinctUnpadded,
    weak: privacyColors.worst,
  };

  const entries = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([id, count]) => ({
      id,
      count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
      compliance: compliance[id] || { green: 0, partial2: 0, partial1: 0, weak: 0 },
      ...(FAMILY_META[id] || { label: id, color: '#6b7280' }),
    }));

  if (!entries.length) return <p className="py-16 text-center text-xs font-mono text-muted">No family data available.</p>;

  return (
    <div className="py-4">
      <div className="flex h-5 w-full overflow-hidden rounded-full bg-cipher-border/20">
        {entries.map((e) => (
          <div
            key={e.id}
            className="h-full transition-[width,opacity,filter] relative group"
            style={{ width: `${e.pct}%`, backgroundColor: e.color }}
            title={`${e.label}: ${e.count} (${e.pct}%)`}
          />
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {entries.map((e) => {
          const c = e.compliance;
          const cTotal = c.green + c.partial2 + c.partial1 + c.weak;
          const greenPct = cTotal > 0 ? Math.round((c.green / cTotal) * 100) : 0;
          return (
            <div key={e.id} className="rounded-lg border border-cipher-border/20 bg-cipher-surface/30 px-3 py-2">
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: e.color }} />
                <span className="text-caption font-medium text-primary">{e.label}</span>
              </div>
              <div className="mt-1 text-lg font-mono font-semibold text-primary">{e.pct}%</div>
              <div className="text-caption font-mono text-muted">{e.count.toLocaleString()} txs</div>
              <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-cipher-border/20">
                {(['green', 'partial2', 'partial1', 'weak'] as const).map((grade) => {
                  const w = cTotal > 0 ? (c[grade] / cTotal) * 100 : 0;
                  return w > 0 ? (
                    <div
                      key={grade}
                      className="h-full"
                      style={{ width: `${w}%`, backgroundColor: gradeColors[grade] }}
                    />
                  ) : null;
                })}
              </div>
              <div className="mt-1 text-caption font-mono text-muted">
                {greenPct}% compliant
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 border-t border-cipher-border/20 pt-3 text-caption text-muted leading-relaxed">
        <p>
          Fingerprints identify <em>compatible construction software</em>, not individual wallet
          owners.
        </p>
        <p className="mt-1.5">
          <strong className="text-primary">ZODL / Vizor:</strong> Unpadded Ironwood bundle (I:1), bucketed expiry,
          grid-aligned anchor, &#123;1,2,5&#125;&times;10<sup>k</sup> denominations. Both use the <code className="text-caption bg-glass-6 px-1 rounded">zcash_pool_migration</code> crate.
        </p>
        <p className="mt-1">
          <strong className="text-primary">Cake/zkool2:</strong> Padded bundle (I:2), legacy +40 expiry, near-tip anchor,
          power-of-10 denominations.
        </p>
      </div>
    </div>
  );
}

export function DenomMixChart({
  denomBuckets,
  maxBucketCount,
  maxBucketVolume,
  totalDenomVolume,
  totalTxs,
  barColor,
  mode,
}: {
  denomBuckets: { denom: number; count: number; volume: number }[];
  maxBucketCount: number;
  maxBucketVolume: number;
  totalDenomVolume: number;
  totalTxs: number;
  barColor: string;
  mode: 'volume' | 'txs';
}) {
  const isVolume = mode === 'volume';
  const totalDenomCount = denomBuckets.reduce((s, b) => s + b.count, 0);
  return (
    <div className="min-w-0 w-full">
      <div className="w-full min-w-0 overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
        <div className="flex h-[200px] min-w-max items-end gap-1 border-b border-cipher-border/25 pb-2 sm:h-[220px] sm:min-w-0 sm:gap-1.5 sm:px-1">
          {denomBuckets.map(({ denom, count, volume }) => {
            const value = isVolume ? volume : count;
            const max = isVolume ? maxBucketVolume : maxBucketCount;
            const label = isVolume
              ? (totalDenomVolume > 0 ? `${((volume / totalDenomVolume) * 100).toFixed(0)}%` : '0%')
              : (totalDenomCount > 0 ? `${((count / totalDenomCount) * 100).toFixed(0)}%` : '0%');
            return (
              <div
                key={denom}
                className="flex w-6 shrink-0 flex-col items-center gap-1 sm:min-w-0 sm:w-auto sm:shrink sm:flex-1 sm:gap-1.5"
              >
                <span className="text-caption font-mono tabular-nums text-primary sm:text-caption">{label}</span>
                <div
                  className="w-full min-w-[4px] rounded-t-md"
                  style={{
                    height: `${max > 0 ? Math.max(8, (value / max) * 160) : 8}px`,
                    backgroundColor: barColor,
                    opacity: 0.9,
                  }}
                />
                <span className="max-w-full truncate text-caption font-mono text-muted sm:text-caption">
                  {formatDenomBucketLabel(denom)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-3 text-center text-caption font-mono text-muted max-sm:px-1">
        {isVolume
          ? `${totalDenomVolume.toLocaleString(undefined, { maximumFractionDigits: 1 })} ZEC across ${totalDenomCount.toLocaleString()} txs`
          : `${totalDenomCount.toLocaleString()} txs using standard denominations`}
      </p>
    </div>
  );
}

export function ComplianceLegend({
  privacyColors,
  denomLineColor,
  activeGrades,
  onToggle,
}: {
  privacyColors: Record<string, string>;
  denomLineColor: string;
  activeGrades?: Set<string>;
  onToggle?: (key: string) => void;
}) {
  const colorMap = {
    green: privacyColors.best,
    partial2: privacyColors.denomPadded,
    partial1: privacyColors.distinctUnpadded,
    weak: privacyColors.worst,
  };

  const interactive = !!onToggle;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-caption font-mono text-muted sm:flex sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
      {COMPLIANCE_GRADES.map((g) => {
        const active = !activeGrades || activeGrades.has(g.key);
        return (
          <button
            key={g.key}
            type="button"
            onClick={interactive ? () => onToggle(g.key) : undefined}
            className={`flex min-w-0 items-center gap-1.5 transition-opacity ${interactive ? 'cursor-pointer hover:opacity-80' : 'cursor-default'} ${active ? 'opacity-100' : 'opacity-35'}`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colorMap[g.key] }} />
            <span className="truncate sm:whitespace-normal">
              {g.key === 'green' ? (
                <>
                  <span className="sm:hidden">Compliant ({g.checks})</span>
                  <span className="hidden sm:inline">{g.label} ({g.checks})</span>
                </>
              ) : (
                <>
                  {g.label} ({g.checks})
                </>
              )}
            </span>
          </button>
        );
      })}
      <span className="col-span-2 flex items-center gap-1.5 sm:col-span-1">
        <span className="inline-block h-0 w-4 shrink-0 border-t border-dashed" style={{ borderColor: denomLineColor, opacity: 0.75 }} />
        Target denominations
      </span>
    </div>
  );
}
