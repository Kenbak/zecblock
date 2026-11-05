'use client';
import { formatDateLabelUTC } from '@/lib/utils';
import { CHART_DATE_AXIS } from '@/lib/chart-theme';

import { ApiError, readApiData } from '@/lib/api-client';
import { ChartWatermark } from '@/components/ChartWatermark';
import { useEffect, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Legend, ResponsiveContainer,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { getApiUrl } from '@/lib/api-config';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { getFlowColors } from '@/lib/flow-colors';
import { formatZecCompact } from '@/lib/format-numbers';
import { Card, CardBody } from '@/components/ui/Card';
import { PeriodPillTags } from '@/components/ui/PeriodPillTags';
import { ChartCard } from '@/components/network/ChartCard';
import { MetricWithTooltip } from '@/components/pools/MetricWithTooltip';
import { InteractiveCompositionBar } from '@/components/pools/InteractiveCompositionBar';
import { parseTurnstilePeriod, type TurnstilePeriod } from '@/lib/turnstile-period';
import { objectRowsCsv } from '@/components/charts/PanelShareControl';

const PERIOD_SINCE: Record<TurnstilePeriod, string> = {
  'nu6.2': '2026-06-01',
  '30d': '',
  '90d': '',
  '1y': '',
  'all': '2016-10-28',
};

function getSinceDate(p: TurnstilePeriod): string {
  if (PERIOD_SINCE[p]) return PERIOD_SINCE[p];
  const d = new Date();
  if (p === '30d') d.setDate(d.getDate() - 30);
  else if (p === '90d') d.setDate(d.getDate() - 90);
  else if (p === '1y') d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().split('T')[0];
}

/** Flows API only supports fixed lookbacks — pick one that covers the turnstile window. */
function getFlowsApiPeriod(p: TurnstilePeriod): string {
  switch (p) {
    case 'nu6.2': return 'all';
    case '30d':
      return '30d';
    case '90d':
      return '90d';
    case '1y': return '1y';
    case 'all': return 'all';
  }
}

function sumShieldInPeriod(points: { date: string; shield: number }[], since: string): number {
  return points
    .filter(pt => pt.date >= since)
    .reduce((sum, pt) => sum + pt.shield, 0);
}

interface TurnstileSummary {
  totalDeshielded: number;
  totalHeld: number;
  totalReshielded: number;
  totalTransferred: number;
  totalBridge: number;
  totalExchange: number;
  totalMoved: number;
  heldPercent: number;
  reshieldedPercent: number;
  transferredPercent: number;
  bridgePercent: number;
  exchangePercent: number;
  movedPercent: number;
  txCount: number;
}

interface TurnstilePoint {
  date: string;
  deshielded: number;
  held: number;
  reshielded: number;
  transferred: number;
  bridge: number;
  exchange: number;
  dateLabel: string;
}

interface TurnstileTrackerProps {
  showCardHeader?: boolean;
  initialPeriod?: TurnstilePeriod;
}

const PERIOD_OPTIONS: { key: TurnstilePeriod; label: string }[] = [
  { key: 'nu6.2', label: 'Since NU6.2' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: '1y', label: '1Y' },
  { key: 'all', label: 'ALL' },
];

type TurnstileCategory = 'held' | 'reshielded' | 'moved' | 'transferred' | 'bridge' | 'exchange';

const TURNSTILE_HINTS: Record<TurnstileCategory, string> = {
  held: 'sitting at t-addr',
  reshielded: 'back to privacy',
  moved: 'sent elsewhere',
  transferred: 'to another t-addr',
  bridge: 'labeled bridge addr',
  exchange: 'labeled exchange addr',
};

export function TurnstileTracker({ initialPeriod = '30d' }: TurnstileTrackerProps) {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const flowColors = getFlowColors(theme);
  const [period, setPeriod] = useState<TurnstilePeriod>(() => parseTurnstilePeriod(initialPeriod));
  const [summary, setSummary] = useState<TurnstileSummary | null>(null);
  const [totalShielded, setTotalShielded] = useState<number | null>(null);
  const [timeseries, setTimeseries] = useState<TurnstilePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [viewBuilding, setViewBuilding] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [hoveredCategory, setHoveredCategory] = useState<TurnstileCategory | null>(null);

  useEffect(() => {
    setLoading(true);
    setUnavailable(false);
    setViewBuilding(false);
    setSummary(null);
    setTotalShielded(null);
    setTimeseries([]);
    setLastUpdated(null);
    const since = getSinceDate(period);
    const flowsPeriod = getFlowsApiPeriod(period);

    Promise.all([
      fetch(`${getApiUrl()}/v1/shielded-pools/turnstile?since=${since}`).then(r => {
        if (r.status === 503) return readApiData(r).catch(error => { setViewBuilding(error instanceof ApiError && error.code === 'building'); return null; });
        return r.ok ? readApiData(r) : null;
      }),
      fetch(`${getApiUrl()}/v1/shielded-pools/flows?period=${flowsPeriod}&pool=all`).then(r => r.ok ? readApiData(r) : null),
    ])
      .then(([turnstileData, flowsData]) => {
        if (!turnstileData) setUnavailable(true);
        if (turnstileData?.summary) setSummary(turnstileData.summary);
        if (turnstileData?.lastUpdated) setLastUpdated(turnstileData.lastUpdated);
        if (turnstileData?.timeseries) {
          setTimeseries(turnstileData.timeseries.map((p: TurnstilePoint) => ({
            ...p,
            bridge: p.bridge ?? 0,
            dateLabel: formatDateLabelUTC(p.date),
          })));
        }
        if (flowsData?.points) {
          setTotalShielded(sumShieldInPeriod(flowsData.points, since));
        }
      })
      .catch(() => setUnavailable(true))
      .finally(() => setLoading(false));
  }, [period]);

  if (viewBuilding && !summary) {
    return (
      <div className="space-y-4">
        <Card variant="glass">
          <CardBody>
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="w-5 h-5 border-2 border-cipher-gold border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-muted font-mono">Turnstile view is rebuilding — data will appear shortly</p>
              <p className="text-caption text-muted font-mono">Auto-retries in 60s</p>
            </div>
          <ChartWatermark /></CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card variant="glass">
        <CardBody>
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
            <PeriodPillTags
              options={PERIOD_OPTIONS}
              value={period}
              onChange={setPeriod}
              className="sm:ml-auto"
              aria-label="Turnstile time period"
            />
          </div>

          {loading ? (
            <div className="space-y-6">
              <div className="h-10 w-48 skeleton-bg rounded motion-safe:animate-pulse" />
              <div className="h-3 skeleton-bg rounded-full motion-safe:animate-pulse" />
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                {[1, 2, 3, 4, 5].map(i => (
                  <div key={i} className="h-24 skeleton-bg rounded-xl motion-safe:animate-pulse" />
                ))}
              </div>
            </div>
          ) : !summary ? (
            <div className="flex items-center justify-center h-32">
              <span className="text-xs text-muted font-mono" role="status">
                {unavailable ? 'Turnstile data is temporarily unavailable' : 'No turnstile data available'}
              </span>
            </div>
          ) : (
            <>
              {(() => {
                const showInflow = totalShielded != null && totalShielded > 0 && period !== 'all';
                const inflowRatio = showInflow && summary.totalDeshielded > 0
                  ? totalShielded / summary.totalDeshielded
                  : null;
                const netOutflow = showInflow && summary.totalDeshielded > totalShielded
                  ? summary.totalDeshielded - totalShielded
                  : null;

                return (
                  <div className="mb-6 rounded-xl bg-glass-4 border border-glass-6 overflow-hidden">
                    <div className={`grid ${showInflow ? 'sm:grid-cols-2' : ''} divide-y sm:divide-y-0 sm:divide-x divide-glass-6`}>
                      <div className="p-4 sm:p-5">
                        <div className="flex items-center gap-2 mb-2">
                          <svg
                            className="w-3.5 h-3.5 shrink-0 text-muted opacity-70"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                          >
                            <path d="M8 4v8M8 12l3-3M8 12L5 9" />
                          </svg>
                          <span className="text-caption font-mono uppercase tracking-wider text-muted">
                            Out of privacy
                          </span>
                        </div>
                        <MetricWithTooltip
                          label="Deshielded"
                          tooltip="ZEC that left a shielded pool to a transparent address in this period"
                        >
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-2xl sm:text-3xl font-semibold font-mono tabular-nums text-primary">
                              {formatZecCompact(summary.totalDeshielded)}
                            </span>
                            <span className="text-sm font-mono text-muted">ZEC</span>
                          </div>
                          <p className="text-xs font-mono text-muted mt-1">
                            across {summary.txCount.toLocaleString()} txs
                          </p>
                        </MetricWithTooltip>
                      </div>

                      {showInflow && (
                        <div className="p-4 sm:p-5">
                          <div className="flex items-center gap-2 mb-2">
                            <svg
                              className="w-3.5 h-3.5 shrink-0 text-muted opacity-70"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden
                            >
                              <path d="M8 12V4M8 4L5 7M8 4l3 3" />
                            </svg>
                            <span className="text-caption font-mono uppercase tracking-wider text-muted">
                              Into privacy
                            </span>
                          </div>
                          <MetricWithTooltip
                            label="Shielded"
                            tooltip="Total ZEC moved into shielded pools during this period — from transparent addresses, exchanges, bridges, and other sources. Not limited to deshielded outputs below."
                          >
                            <div className="flex items-baseline gap-2 flex-wrap">
                              <span className="text-2xl sm:text-3xl font-semibold font-mono tabular-nums text-primary">
                                {formatZecCompact(totalShielded)}
                              </span>
                              <span className="text-sm font-mono text-muted">ZEC</span>
                            </div>
                            <p className="text-xs font-mono text-muted mt-1">
                              all shield inflows this period
                            </p>
                          </MetricWithTooltip>
                        </div>
                      )}
                    </div>

                    {showInflow && inflowRatio != null && summary.totalDeshielded > 0 && (
                      <div className="px-4 sm:px-5 py-3 border-t border-glass-6 bg-glass-2">
                        <p className="text-xs font-mono text-muted leading-relaxed">
                          {inflowRatio >= 1 ? (
                            <>
                              <span className="text-secondary tabular-nums">{inflowRatio.toFixed(2)}×</span>
                              {' '}more shielded in than deshielded out
                            </>
                          ) : (
                            <>
                              <span className="text-secondary tabular-nums">{inflowRatio.toFixed(2)}×</span>
                              {' '}shielded in per 1 ZEC deshielded out
                              {netOutflow != null && netOutflow > 0 && (
                                <>
                                  {' '}· net{' '}
                                  <span className="text-secondary tabular-nums">{formatZecCompact(netOutflow)}</span>
                                  {' '}left privacy
                                </>
                              )}
                            </>
                          )}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}

              {summary.totalDeshielded > 0 && (() => {
                const movedPct = (summary.transferredPercent ?? 0) + (summary.bridgePercent ?? 0) + summary.exchangePercent;
                const movedAmt = (summary.totalTransferred ?? 0) + (summary.totalBridge ?? 0) + summary.totalExchange;
                const movedColor = flowColors.transferred;

                const segments = showDetail
                  ? [
                      { key: 'held', pct: summary.heldPercent, amount: summary.totalHeld },
                      { key: 'reshielded', pct: summary.reshieldedPercent, amount: summary.totalReshielded },
                      { key: 'transferred', pct: summary.transferredPercent, amount: summary.totalTransferred },
                      { key: 'bridge', pct: summary.bridgePercent ?? 0, amount: summary.totalBridge ?? 0 },
                      { key: 'exchange', pct: summary.exchangePercent, amount: summary.totalExchange },
                    ]
                  : [
                      { key: 'held', pct: summary.heldPercent, amount: summary.totalHeld },
                      { key: 'reshielded', pct: summary.reshieldedPercent, amount: summary.totalReshielded },
                      { key: 'moved', pct: movedPct, amount: movedAmt },
                    ];

                const cards = showDetail
                  ? [
                      { key: 'held' as const, value: summary.totalHeld, pct: summary.heldPercent },
                      { key: 'reshielded' as const, value: summary.totalReshielded, pct: summary.reshieldedPercent },
                      { key: 'transferred' as const, value: summary.totalTransferred, pct: summary.transferredPercent },
                      { key: 'bridge' as const, value: summary.totalBridge ?? 0, pct: summary.bridgePercent ?? 0 },
                      { key: 'exchange' as const, value: summary.totalExchange, pct: summary.exchangePercent },
                    ]
                  : [
                      { key: 'held' as const, value: summary.totalHeld, pct: summary.heldPercent },
                      { key: 'reshielded' as const, value: summary.totalReshielded, pct: summary.reshieldedPercent },
                      { key: 'moved' as const, value: movedAmt, pct: movedPct },
                    ];

                const categoryColors: Record<string, string> = {
                  held: flowColors.held,
                  reshielded: flowColors.reshielded,
                  moved: movedColor,
                  transferred: flowColors.transferred,
                  bridge: flowColors.bridge ?? flowColors.transferred,
                  exchange: flowColors.exchange,
                };

                const categoryLabels: Record<string, string> = {
                  held: 'Still Held',
                  reshielded: 'Reshielded',
                  moved: 'Moved',
                  transferred: 'Transferred',
                  bridge: 'To Bridge',
                  exchange: 'To Exchange',
                };

                const tooltips: Record<string, string> = {
                  held: 'Deshielded ZEC still sitting on the original transparent address',
                  reshielded: 'ZEC that moved back into a shielded pool after deshielding',
                  moved: 'ZEC sent elsewhere — transferred, bridged, or deposited to an exchange',
                  transferred: 'ZEC sent to another transparent address (not an exchange or bridge)',
                  bridge: 'ZEC sent to a labeled cross-chain bridge address (e.g. NEAR Intents)',
                  exchange: 'ZEC sent to a labeled exchange deposit address',
                };

                return (
                  <>
                    <p className="text-caption font-mono uppercase tracking-wider text-muted mb-3">
                      Where deshielded ZEC went
                    </p>
                    <InteractiveCompositionBar
                      className="mb-6"
                      hoveredKey={hoveredCategory}
                      onHoverKeyChange={key => setHoveredCategory(key as TurnstileCategory | null)}
                      segments={segments.map(({ key, pct, amount }) => ({
                        key,
                        label: categoryLabels[key] ?? key,
                        percent: pct,
                        color: categoryColors[key] ?? flowColors.transferred,
                        opacity: key === 'transferred' ? 0.5 : key === 'held' ? 0.85 : key === 'moved' ? 0.6 : key === 'bridge' ? 0.65 : 0.7,
                        hint: TURNSTILE_HINTS[key as TurnstileCategory] ?? '',
                        title: `${categoryLabels[key]}: ${formatZecCompact(amount)} ZEC (${pct.toFixed(1)}%)`,
                      }))}
                    />

                    <div className="flex items-center justify-end mb-3">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={showDetail}
                          onChange={e => setShowDetail(e.target.checked)}
                          className="w-3.5 h-3.5 rounded border-glass-12 bg-glass-4 accent-cipher-gold"
                        />
                        <span className="text-caption font-mono text-muted uppercase tracking-wider">
                          Show full breakdown
                        </span>
                      </label>
                    </div>

                    <div className={`grid gap-3 ${showDetail ? 'grid-cols-2 lg:grid-cols-5' : 'grid-cols-3'}`}>
                      {cards.map(({ key, value, pct }) => {
                        const isHovered = hoveredCategory === key;
                        const isDimmed = hoveredCategory != null && !isHovered;

                        return (
                          <div
                            key={key}
                            className={`bg-glass-4 rounded-xl p-4 border-l-2 transition duration-200 ${
                              isHovered ? 'ring-1 ring-glass-12 bg-glass-6' : ''
                            } ${isDimmed ? 'opacity-40' : ''}`}
                            style={{ borderLeftColor: categoryColors[key] }}
                            onMouseEnter={() => setHoveredCategory(key as TurnstileCategory)}
                            onMouseLeave={() => setHoveredCategory(null)}
                          >
                            <MetricWithTooltip label={categoryLabels[key]} tooltip={tooltips[key]}>
                              <p
                                className="text-xl font-semibold font-mono tabular-nums"
                                style={{ color: categoryColors[key] }}
                              >
                                {formatZecCompact(value)}
                              </p>
                            </MetricWithTooltip>
                            <p className="text-xs font-mono text-muted mt-1">
                              {pct.toFixed(1)}% of deshielded
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </>
          )}

          <p className="text-xs text-secondary font-sans mt-6 leading-relaxed">
            Tracks what happens after ZEC leaves a shielded pool — held, reshielded, transferred, bridged cross-chain, or sent to exchanges.
            {lastUpdated && ` Updated ${new Date(lastUpdated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} at ${new Date(lastUpdated).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.`}
            {!lastUpdated && ' Updated daily.'}
          </p>
          {(period === 'all' || period === '1y') && (
            <p className="text-caption text-muted font-mono mt-2 leading-relaxed italic">
              Note: cumulative volume — the same ZEC can be deshielded and reshielded multiple times, so totals may exceed circulating supply.
            </p>
          )}
        </CardBody>
      </Card>

      {timeseries.length > 1 && (() => {
        const chartData = timeseries.map(p => ({
          ...p,
          moved: (p.transferred ?? 0) + (p.bridge ?? 0) + (p.exchange ?? 0),
        }));

        return (
          <ChartCard title="DAILY_DESHIELDED_ZEC_BREAKDOWN" height={280} share={{ title: 'Daily deshielded ZEC breakdown', fileName: 'zecblock-daily-deshielded-zec', csv: () => objectRowsCsv(chartData) }}>
            <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={280}>
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
                <XAxis
                  dataKey="dateLabel"
                  stroke={colors.axis}
                  tick={{ fill: colors.axis, fontSize: 12 }}
                  {...CHART_DATE_AXIS}
                />
                <YAxis
                  stroke={colors.axis}
                  tick={{ fill: colors.axis, fontSize: 12 }}
                  tickFormatter={v => formatZecCompact(v)}
                  width={48}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: colors.tooltipBg,
                    border: `1px solid ${colors.tooltipBorder}`,
                    borderRadius: '8px',
                    fontSize: 12,
                  }}
                  formatter={(value, name) => {
                    const labels: Record<string, string> = {
                      held: 'Still Held',
                      reshielded: 'Reshielded',
                      moved: 'Moved',
                      transferred: 'Transferred',
                      bridge: 'To Bridge',
                      exchange: 'To Exchange',
                    };
                    return [`${Number(value).toFixed(2)} ZEC`, labels[String(name)] || String(name)];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                <Area type="monotone" dataKey="held" stackId="1" stroke={flowColors.held} fill={flowColors.held} fillOpacity={0.35} name="Still Held" />
                <Area type="monotone" dataKey="reshielded" stackId="1" stroke={flowColors.reshielded} fill={flowColors.reshielded} fillOpacity={0.3} name="Reshielded" />
                <Area type="monotone" dataKey="moved" stackId="1" stroke={flowColors.moved} fill={flowColors.moved} fillOpacity={0.25} name="Moved" hide={showDetail} />
                <Area type="monotone" dataKey="transferred" stackId="1" stroke={flowColors.transferred} fill={flowColors.transferred} fillOpacity={0.2} name="Transferred" hide={!showDetail} />
                <Area type="monotone" dataKey="bridge" stackId="1" stroke={flowColors.bridge} fill={flowColors.bridge} fillOpacity={0.3} name="To Bridge" hide={!showDetail} />
                <Area type="monotone" dataKey="exchange" stackId="1" stroke={flowColors.exchange} fill={flowColors.exchange} fillOpacity={0.25} name="To Exchange" hide={!showDetail} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        );
      })()}
    </div>
  );
}
