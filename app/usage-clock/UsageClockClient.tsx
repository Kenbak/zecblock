'use client';

import { readApiData } from '@/lib/api-client';
import { ChartWatermark } from '@/components/ChartWatermark';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/SectionHeader';
import styles from './usage-clock.module.css';
import { feature } from 'topojson-client';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,

  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { getApiUrl } from '@/lib/api-config';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  project,
  declinationDeg,
  subsolarLon,
  isDaylight,
  nightPath,
  sunRegionLabel,
  regionsInDaylight,
  decomposeRegions,
  pearson,
} from './solar';
import { useUrlState } from '@/lib/use-url-state';

const WORLD_TOPO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json';
const DOT_SPACING = 3;
const DOT_RADIUS = 1.5;

const PERIODS = [
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: '6m', label: '6M' },
  { key: '1y', label: '1Y' },
  { key: 'all', label: 'ALL' },
];

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface HeatCell { hour: number; dow: number; txCount: number; blockCount: number; }
interface HourPoint { hour: number; txCount: number; }
interface ClockData {
  period: string;
  dateRange: { from: string | null; to: string | null };
  totalBlocks: number;
  totalTxs: number;
  heatmap: HeatCell[];
  hourly: HourPoint[];
  peakHour: number;
  lowHour: number;
  peakToLowRatio: number;
}
interface NodeLoc { country: string; countryCode: string; city: string; lat: number; lon: number; nodeCount: number; }

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function isPointOnLand(lat: number, lon: number, features: any[]): boolean {
  for (const feat of features) {
    const geom = feat.geometry || feat;
    if (geom.type === 'Polygon') {
      if (pointInRing(lon, lat, geom.coordinates[0])) return true;
    } else if (geom.type === 'MultiPolygon') {
      for (const polygon of geom.coordinates) {
        if (pointInRing(lon, lat, polygon[0])) return true;
      }
    }
  }
  return false;
}

function clusterNodes(nodes: NodeLoc[]): NodeLoc[] {
  const clusters = new Map<string, NodeLoc>();
  for (const loc of nodes) {
    const key = `${Math.round(loc.lat / 8) * 8},${Math.round(loc.lon / 8) * 8}`;
    const existing = clusters.get(key);
    if (existing) {
      const total = existing.nodeCount + loc.nodeCount;
      clusters.set(key, {
        ...existing,
        lat: (existing.lat * existing.nodeCount + loc.lat * loc.nodeCount) / total,
        lon: (existing.lon * existing.nodeCount + loc.lon * loc.nodeCount) / total,
        nodeCount: total,
      });
    } else {
      clusters.set(key, { ...loc });
    }
  }
  return Array.from(clusters.values());
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

function heatColor(t: number): string {
  return `color-mix(in srgb, var(--clock-heat-high) ${Math.max(0, Math.min(1, t)) * 100}%, var(--clock-heat-low))`;
}

// ---------------------------------------------------------------------------
// Radial 24-hour clock dial
// ---------------------------------------------------------------------------

// viewBox is padded well beyond the outer bars so hour labels and the
// sun/moon anchors at the rim aren't clipped at the edges.
const DIAL = 520;
const CX = DIAL / 2;
const CY = DIAL / 2;
const BAR_INNER = 124;
const BAR_MAX = 74;
const RING_R = 104;
const RING_W = 11;
const HUB_R = 90;

// Noon (12:00) at top, midnight (00:00) at bottom, sunrise (06) right, sunset
// (18) left — the dial follows the sun's arc across the sky.
function polar(r: number, hourFrac: number): { x: number; y: number } {
  const a = (90 - 15 * hourFrac) * (Math.PI / 180);
  return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
}

function ringArc(r: number, h0: number, h1: number): string {
  const s = polar(r, h1);
  const e = polar(r, h0);
  const large = (h1 - h0) / 24 > 0.5 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

function tealForShare(t: number): string {
  return `color-mix(in srgb, var(--clock-daylight) ${Math.max(0, Math.min(1, t)) * 100}%, var(--color-border))`;
}

function goldForLevel(t: number): string {
  return `color-mix(in srgb, var(--clock-gold) ${35 + Math.max(0, Math.min(1, t)) * 65}%, var(--color-border))`;
}

function RadialClock({
  hourly,
  nodeDaylightShare,
  hour,
  currentHour,
  activityPct,
}: {
  hourly: number[];
  nodeDaylightShare: number[];
  hour: number;
  currentHour: number;
  activityPct: number;
}) {
  const sunHand = polar(BAR_INNER + BAR_MAX + 14, hour);
  // Bar lengths share a zero baseline at the inner guide circle.
  const maxV = Math.max(...hourly, 1);
  return (
    <svg viewBox={`0 0 ${DIAL} ${DIAL}`} className="w-full h-auto" role="img" aria-label={`Daily activity clock. Selected hour ${currentHour}:00 UTC, ${activityPct}% of the busiest hour.`}>
      <defs>
        <radialGradient id="hubGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--color-surface)" />
          <stop offset="100%" stopColor="var(--color-bg)" />
        </radialGradient>
        <filter id="barGlow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* faint guide circles */}
      <circle cx={CX} cy={CY} r={BAR_INNER + BAR_MAX} fill="none" stroke="var(--color-border)" strokeOpacity={0.8} />
      <circle cx={CX} cy={CY} r={BAR_INNER} fill="none" stroke="var(--color-border)" strokeOpacity={0.8} />

      {/* daylight ring — how much of the node network is in sunlight at each hour */}
      {Array.from({ length: 24 }, (_, h) => (
        <path
          key={`ring-${h}`}
          d={ringArc(RING_R, h + 0.12, h + 0.88)}
          stroke={tealForShare(nodeDaylightShare[h] || 0)}
          strokeWidth={RING_W}
          fill="none"
          strokeLinecap="butt"
          opacity={h === currentHour ? 1 : 0.85}
        />
      ))}

      {/* activity bars — length and brightness both encode volume */}
      {hourly.map((v, h) => {
        const norm = v / maxV;
        const len = norm * BAR_MAX;
        const p0 = polar(BAR_INNER, h + 0.5);
        const p1 = polar(BAR_INNER + len, h + 0.5);
        const active = h === currentHour;
        return (
          <line
            key={`bar-${h}`}
            x1={p0.x}
            y1={p0.y}
            x2={p1.x}
            y2={p1.y}
            stroke={active ? 'var(--clock-gold)' : goldForLevel(norm)}
            strokeWidth={9}
            strokeLinecap="butt"
            opacity={v === 0 ? 0 : 1}
            filter={active ? 'url(#barGlow)' : undefined}
          />
        );
      })}

      {/* hour labels */}
      {[0, 6, 12, 18].map((h) => {
        const p = polar(BAR_INNER + BAR_MAX + 18, h);
        return (
          <text
            key={`lbl-${h}`}
            x={p.x}
            y={p.y}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={12}
            fontFamily="var(--font-geist-mono), monospace"
            fill="var(--color-text-muted)"
          >
            {String(h).padStart(2, '0')}
          </text>
        );
      })}

      {/* sun (noon, top) & moon (midnight, bottom) anchors */}
      {(() => {
        const sun = polar(BAR_INNER + BAR_MAX + 40, 12);
        const moon = polar(BAR_INNER + BAR_MAX + 40, 0);
        return (
          <g>
            <g>
              <circle cx={sun.x} cy={sun.y} r={6} fill="var(--clock-gold)" />
              {Array.from({ length: 8 }, (_, i) => {
                const a = (i / 8) * 2 * Math.PI;
                return (
                  <line
                    key={i}
                    x1={sun.x + Math.cos(a) * 8}
                    y1={sun.y + Math.sin(a) * 8}
                    x2={sun.x + Math.cos(a) * 11}
                    y2={sun.y + Math.sin(a) * 11}
                    stroke="var(--clock-gold)"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  />
                );
              })}
            </g>
            <g>
              <circle cx={moon.x} cy={moon.y} r={6} fill="var(--color-text-muted)" />
              <circle cx={moon.x + 2.6} cy={moon.y - 1.6} r={5} fill="var(--color-surface)" />
            </g>
          </g>
        );
      })()}

      {/* sun hand */}
      <line x1={CX} y1={CY} x2={sunHand.x} y2={sunHand.y} stroke="var(--clock-gold)" strokeWidth={2} strokeOpacity={0.5} />
      <circle cx={sunHand.x} cy={sunHand.y} r={9} fill="var(--clock-gold)" stroke="var(--clock-gold)" strokeWidth={1.5} />

      {/* hub */}
      <circle cx={CX} cy={CY} r={HUB_R} fill="url(#hubGrad)" stroke="var(--color-border)" strokeOpacity={0.4} />
      <text x={CX} y={CY - 22} textAnchor="middle" fontSize={34} fontFamily="var(--font-geist-mono), monospace" fontWeight={600} fill="var(--color-shielded-ink)">
        {String(currentHour).padStart(2, '0')}:00
      </text>
      <text x={CX} y={CY + 2} textAnchor="middle" fontSize={12} fontFamily="var(--font-geist-mono), monospace" fill="var(--color-text-muted)" letterSpacing="2">
        UTC
      </text>
      <text x={CX} y={CY + 30} textAnchor="middle" fontSize={20} fontFamily="var(--font-geist-mono), monospace" fontWeight={600} fill="var(--color-text-primary)">
        {activityPct}%
      </text>
      <text x={CX} y={CY + 48} textAnchor="middle" fontSize={12} fontFamily="var(--font-geist-mono), monospace" fill="var(--color-text-muted)" letterSpacing="1">
        OF PEAK
      </text>
    </svg>
  );
}

function ResidualTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const up = d.residual >= 0;
  return (
    <div className="chart-tooltip-surface">
      <div className="text-secondary mb-1">{d.label}:00 UTC</div>
      <div className="text-muted">actual {d.actual}% of the day</div>
      <div className="text-muted">baseline {d.predicted}% of the day</div>
      <div style={{ color: up ? 'var(--color-orange)' : 'var(--color-text-secondary)', marginTop: 4, fontWeight: 600 }}>
        {up ? '+' : ''}{d.residual} pts · {up ? 'above baseline' : 'below baseline'}
      </div>
    </div>
  );
}

export function UsageClockClient({
  initialData,
  initialPeriod,
  initialNodes,
}: {
  initialData: ClockData | null;
  initialPeriod: string;
  initialNodes: NodeLoc[];
}) {
  const [period, setPeriod] = useUrlState<string>('period', initialPeriod, PERIODS.map((option) => option.key));
  const [data, setData] = useState<ClockData | null>(initialData);
  const [loading, setLoading] = useState(false);
  const [nodes, setNodes] = useState<NodeLoc[]>(initialNodes || []);
  const [worldDots, setWorldDots] = useState<{ x: number; y: number; lat: number; lon: number }[]>([]);
  const [hour, setHour] = useState(15);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [mapError, setMapError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const decl = useMemo(() => declinationDeg(), []);

  useEffect(() => {
    if (initialNodes.length) return;
    const controller = new AbortController();
    fetch(`${getApiUrl()}/v1/network/nodes`, { signal: controller.signal })
      .then((r) => readApiData<{ locations?: NodeLoc[] }>(r))
      .then((d) => { if (!controller.signal.aborted) setNodes(d.locations || []); })
      .catch(() => { /* Node-dependent charts retain an explicit unavailable state. */ });
    return () => controller.abort();
  }, [initialNodes, retry]);

  useEffect(() => {
    fetch(WORLD_TOPO_URL)
      .then((r) => r.json())
      .then((topology: any) => {
        const land = feature(topology, topology.objects.land) as any;
        const features = land.features ? land.features : [land];
        const dots: { x: number; y: number; lat: number; lon: number }[] = [];
        for (let lat = 82; lat >= -58; lat -= DOT_SPACING) {
          for (let lon = -180; lon < 180; lon += DOT_SPACING) {
            if (isPointOnLand(lat, lon, features)) {
              const p = project(lat, lon);
              dots.push({ x: p.x, y: p.y, lat, lon });
            }
          }
        }
        setWorldDots(dots);
      })
      .catch(() => setMapError(true));
  }, []);

  useEffect(() => {
    if (period === initialPeriod && initialData) {
      setData(initialData);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`${getApiUrl()}/v1/analytics/usage-clock?period=${period}`, { signal: controller.signal })
      .then((r) => readApiData<ClockData>(r))
      .then((d) => { if (!controller.signal.aborted) setData(d); })
      .catch(() => {
        if (!controller.signal.aborted) setError('This period could not be loaded. Try again.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [period, initialPeriod, initialData, retry]);

  // ~10fps sweep keeps the dial smooth without re-rendering the map at 60fps.
  useEffect(() => {
    if (!playing) return;
    timerRef.current = setInterval(() => {
      setHour((h) => (h + 0.24) % 24);
    }, 100);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [playing]);

  const clustered = useMemo(() => clusterNodes(nodes), [nodes]);
  const totalNodeCount = useMemo(() => nodes.reduce((s, n) => s + n.nodeCount, 0), [nodes]);

  const hourly = useMemo(() => {
    const arr = new Array(24).fill(0);
    (data?.hourly || []).forEach((p) => { arr[p.hour] = p.txCount; });
    return arr;
  }, [data]);
  const hourlyTotal = useMemo(() => hourly.reduce((s, v) => s + v, 0) || 1, [hourly]);
  const hourlyFrac = useMemo(() => hourly.map((v) => v / hourlyTotal), [hourly, hourlyTotal]);
  const peakValue = useMemo(() => Math.max(...hourly, 1), [hourly]);

  const nodeDaylightShare = useMemo(() => {
    const out = new Array(24).fill(0);
    if (totalNodeCount === 0) return out;
    for (let h = 0; h < 24; h++) {
      let lit = 0;
      for (const n of nodes) if (isDaylight(n.lat, n.lon, h, decl)) lit += n.nodeCount;
      out[h] = lit / totalNodeCount;
    }
    return out;
  }, [nodes, totalNodeCount, decl]);

  const nodeGeoSplit = useMemo(() => {
    let americas = 0, europe = 0, asia = 0;
    for (const n of nodes) {
      if (n.lon < -30) americas += n.nodeCount;
      else if (n.lon < 60) europe += n.nodeCount;
      else asia += n.nodeCount;
    }
    const t = americas + europe + asia || 1;
    return { americas: americas / t, europe: europe / t, asia: asia / t };
  }, [nodes]);

  const regionMix = useMemo(() => decomposeRegions(hourlyFrac), [hourlyFrac]);
  const correlation = useMemo(() => pearson(hourly, nodeDaylightShare), [hourly, nodeDaylightShare]);

  const predictedFrac = useMemo(() => {
    const out = new Array(24).fill(0);
    if (totalNodeCount === 0) return out;
    const WAKING = [
      0.20, 0.14, 0.10, 0.09, 0.09, 0.14, 0.30, 0.50, 0.70, 0.85, 0.95, 1.0,
      1.0, 1.0, 1.0, 1.0, 0.97, 0.95, 1.0, 1.0, 0.90, 0.70, 0.48, 0.30,
    ];
    for (const n of nodes) {
      const offset = Math.round(n.lon / 15);
      for (let h = 0; h < 24; h++) {
        const local = ((h + offset) % 24 + 24) % 24;
        out[h] += n.nodeCount * WAKING[local];
      }
    }
    const t = out.reduce((s, v) => s + v, 0) || 1;
    return out.map((v) => v / t);
  }, [nodes, totalNodeCount]);

  const currentHour = Math.floor(hour) % 24;
  const litRegions = useMemo(() => regionsInDaylight(hour, decl), [hour, decl]);
  const activityPct = peakValue > 0 ? Math.round((hourly[currentHour] / peakValue) * 100) : 0;
  const sunMarker = project(decl, subsolarLon(hour));

  const residualBars = useMemo(
    () => hourly.map((_, h) => ({
      hour: h,
      label: `${String(h).padStart(2, '0')}`,
      actual: +(hourlyFrac[h] * 100).toFixed(2),
      predicted: +(predictedFrac[h] * 100).toFixed(2),
      residual: +((hourlyFrac[h] - predictedFrac[h]) * 100).toFixed(2),
    })),
    [hourly, hourlyFrac, predictedFrac]
  );

  const heat = useMemo(() => {
    const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let max = 1;
    (data?.heatmap || []).forEach((c) => {
      const row = (c.dow + 6) % 7;
      grid[row][c.hour] = c.txCount;
      if (c.txCount > max) max = c.txCount;
    });
    return { grid, max };
  }, [data]);

  const hasActivity = !!data && data.totalTxs > 0 && data.hourly.length > 0;
  const hasNodes = totalNodeCount > 0;
  const hasCorrelation = hasNodes && hasActivity && new Set(hourly).size > 1 && new Set(nodeDaylightShare).size > 1;
  const peakH = data?.peakHour ?? 0;
  const lowH = data?.lowHour ?? 1;
  const ratio = data?.peakToLowRatio ?? 0;

  return (
    <div className={`${styles.page} max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10`}>
      <PageHeader eyebrow="USAGE_CLOCK" title="The Rhythm of Zcash"
        subtitle="Explore when Zcash transactions happen. Compare the daily activity pattern with daylight and the observed node network." />

      {/* Period selector + range */}
      <div className={styles.toolbar}>
        <div className={styles.periods} role="group" aria-label="Activity period">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              aria-pressed={period === p.key}
              className={styles.period}
            >
              {p.label}
            </button>
          ))}
        </div>
        {data && (
          <div className="text-caption font-mono text-muted">
            {data.dateRange.from} → {data.dateRange.to} · {data.totalBlocks.toLocaleString()} blocks · {fmt(data.totalTxs)} txs
          </div>
        )}
        {loading && <span role="status" className="text-caption font-mono text-secondary">Updating…</span>}
      </div>

      {error && <div className={styles.notice} role="alert">{error} {data && 'Showing the previous period.'} <button onClick={() => setRetry((v) => v + 1)} className="underline">Retry</button></div>}
      {!hasActivity ? <div className={styles.empty} role="status">{loading ? 'Loading activity…' : 'No activity data is available for this period.'}</div> : <>
      <dl className={styles.stats}>
        {[['Transactions', data!.totalTxs.toLocaleString('en-US')], ['Busiest hour', `${String(peakH).padStart(2, '0')}:00 UTC`], ['Quietest hour', `${String(lowH).padStart(2, '0')}:00 UTC`], ['Peak / quietest', ratio > 0 ? `${ratio}×` : 'Unavailable']].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>

      {/* ===================== HERO: dial + thesis ===================== */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.05fr_0.95fr] gap-5 items-start">
        {/* Dial */}
        <div className="rounded-xl border border-cipher-border p-4 sm:p-5 flex flex-col bg-cipher-surface">
          <div className={styles.cardHeading}><h2>Daily activity</h2><span>Selected hour · UTC</span></div>
          <div className="max-w-[340px] w-full mx-auto">
            <RadialClock
              hourly={hourly}
              nodeDaylightShare={nodeDaylightShare}
              hour={hour}
              currentHour={currentHour}
              activityPct={activityPct}
            />
            <ChartWatermark />
          </div>

          {/* controls */}
          <div className="mt-4 flex items-center gap-4">
            <button
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? 'Pause day playback' : 'Play through the day'}
              className="w-9 h-9 flex items-center justify-center rounded-lg border border-cipher-border bg-glass-3 text-secondary hover:text-primary hover:border-cipher-yellow/40 transition flex-shrink-0"
            >
              {playing ? (
                <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1.5" width="3" height="9" rx="1" /><rect x="7" y="1.5" width="3" height="9" rx="1" /></svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.8v8.4a.6.6 0 0 0 .92.5l6.6-4.2a.6.6 0 0 0 0-1L3.92 1.3A.6.6 0 0 0 3 1.8z" /></svg>
              )}
            </button>
            <input
              type="range"
              min={0}
              max={23.99}
              step={0.25}
              value={hour}
              onChange={(e) => { setPlaying(false); setHour(parseFloat(e.target.value)); }}
              className="flex-1 accent-cipher-yellow-bright cursor-pointer"
              aria-label="Hour of day (UTC)"
              aria-valuetext={`${currentHour}:00 UTC`}
            />
          </div>
          <div className={styles.legend}><span><i style={{ background: 'var(--clock-gold)' }} />Transactions</span><span><i style={{ background: 'var(--clock-daylight)' }} />Nodes in daylight</span></div>
          <p className="mt-2 text-caption text-muted leading-relaxed">Bar length shows transaction volume relative to the busiest hour. The inner ring gets stronger as more nodes enter daylight.</p>
          {!hasNodes && <p className="mt-2 text-caption text-muted">Node observations unavailable; the daylight ring has no data.</p>}

        </div>

        <div className="min-w-0 space-y-5">
      {/* ===================== GEOGRAPHIC PANEL (demoted) ===================== */}
      <div className="rounded-xl border border-cipher-border overflow-hidden relative bg-cipher-surface">
        <div className="px-4 py-2.5 border-b border-cipher-border/60 flex items-center justify-between gap-3 flex-wrap">
          <span className="text-caption font-mono font-semibold text-secondary uppercase tracking-wider">Sun &amp; network · {String(currentHour).padStart(2, '0')}:00 UTC {playing ? '· playing' : '· paused'}</span>
          <div className="flex items-center gap-3 text-caption font-mono">
            <span className="flex items-center gap-1.5"><span className={styles.nodeDay} /> <span className="text-muted">node, lit</span></span>
            <span className="flex items-center gap-1.5"><span className={styles.nodeNight} /> <span className="text-muted">node, dark</span></span>
          </div>
        </div>
        <svg viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} className="w-full h-auto block" style={{ maxHeight: 245 }} role="img" aria-label={`Daylight and observed node locations at ${currentHour}:00 UTC`}>
          <defs>
            <radialGradient id="sunGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#FFD060" stopOpacity="0.9" />
              <stop offset="40%" stopColor="#F8BC21" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#F8BC21" stopOpacity="0" />
            </radialGradient>
            <filter id="nodeGlow2" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          {worldDots.map((d, i) => {
            const lit = isDaylight(d.lat, d.lon, hour, decl);
            return <circle key={i} cx={d.x} cy={d.y} r={DOT_RADIUS} fill={lit ? 'var(--clock-land-day)' : 'var(--clock-land-night)'} opacity={1} />;
          })}
          <path d={nightPath(hour, decl)} fill="var(--clock-night)" />
          <circle cx={sunMarker.x} cy={sunMarker.y} r={42} fill="url(#sunGlow)" />
          <circle cx={sunMarker.x} cy={sunMarker.y} r={6} fill="var(--clock-gold)" stroke="var(--clock-gold)" strokeWidth={1.5} />
          {[...clustered].sort((a, b) => b.nodeCount - a.nodeCount).map((n, i) => {
            const p = project(n.lat, n.lon);
            const lit = isDaylight(n.lat, n.lon, hour, decl);
            const r = Math.max(3, Math.min(10, 2.5 + Math.sqrt(n.nodeCount) * 2.2));
            return <circle key={`n${i}`} cx={p.x} cy={p.y} r={r} fill={lit ? 'var(--clock-gold)' : 'var(--clock-node-night)'} stroke="var(--color-surface)" strokeWidth={0.7} filter={lit ? 'url(#nodeGlow2)' : undefined} />;
          })}
        </svg>
        {mapError && <p className="px-4 text-caption text-muted" role="status">The basemap could not load. Node locations and daylight remain available.</p>}
        <p className="px-4 pt-2 text-caption text-muted">Daylight simulation for today at the selected hour · {hasNodes ? `${totalNodeCount.toLocaleString('en-US')} observed nodes` : 'Node locations unavailable'}. Sun over {sunRegionLabel(hour)}; daylight near {litRegions.join(', ') || 'the open ocean'}. <Link href="/network/nodes" className="underline">Explore nodes</Link></p>
        <ChartWatermark className="px-4 pb-3" />
      </div>

        {/* Correlation */}
        <div className="rounded-xl border border-cipher-border bg-cipher-surface p-4 flex flex-col">
          <h2 className="text-xs font-mono font-semibold text-secondary uppercase tracking-wider mb-2">Daylight correlation</h2>
          <div className="text-2xl font-semibold font-mono text-cipher-shielded">{hasCorrelation ? `${correlation >= 0 ? '+' : ''}${correlation.toFixed(2)}` : '—'}</div>
          <p className="text-caption text-muted mt-2 leading-relaxed">
            Pearson correlation between hourly transactions and the share of observed nodes in daylight. Ranges from −1 to +1; it does not establish a cause or a user location.
            {!hasCorrelation && ' Unavailable without varying activity and node daylight observations.'}

          </p>
        </div>

        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5 items-start">
        {/* Thesis + the headline differentiator */}
        <div className="rounded-xl border border-cipher-border bg-cipher-surface p-5 flex flex-col">
          <h2 className="text-base font-semibold text-primary">Timing &amp; node geography</h2>
          <p className="text-xs text-secondary leading-relaxed mt-2">
            Compare a modeled timing mix with observed node locations. Timing weights describe how well three daily profiles fit the activity curve; they do not locate users.

          </p>

          <div className="mt-5 space-y-4">
            {[
              { label: 'Americas', timing: regionMix.americas, geo: nodeGeoSplit.americas, color: 'var(--color-text-secondary)' },
              { label: 'Europe & Africa', timing: regionMix.europe, geo: nodeGeoSplit.europe, color: 'var(--clock-daylight)' },
              { label: 'Asia–Pacific', timing: regionMix.asia, geo: nodeGeoSplit.asia, color: 'var(--clock-gold)' },
            ].map((r) => (
              <div key={r.label}>
                <div className="flex items-center justify-between gap-2 flex-wrap text-caption mb-1">
                  <span className="text-secondary">{r.label}</span>
                  <span className="text-muted">
                    <span className="text-primary font-mono">{Math.round(r.timing * 100)}%</span> model · {hasNodes ? `${Math.round(r.geo * 100)}% nodes` : 'nodes unavailable'}
                  </span>
                </div>
                <div className="relative h-2.5 rounded-full bg-glass-3 overflow-hidden">
                  <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${r.timing * 100}%`, backgroundColor: r.color }} />
                </div>
                <div className="relative h-1.5 mt-1 rounded-full bg-glass-3 overflow-hidden" title="Share of nodes physically in this region">
                  <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${r.geo * 100}%`, backgroundColor: r.color }} />
                </div>
              </div>
            ))}
          </div>

          <p className="text-caption text-muted leading-relaxed mt-auto pt-4">
            Thick bars: fitted timing weights. Thin bars: observed node shares. Node locations can reflect hosting or VPN endpoints, rather than where people live.
          </p>
          <ChartWatermark />
        </div>
        {/* Residual */}
        <div className="rounded-xl border border-cipher-border bg-cipher-surface p-5">
          <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
            <h2 className="text-xs font-mono font-semibold text-secondary uppercase tracking-wider">Activity vs. baseline</h2>
            <div className="flex items-center gap-3 text-caption font-mono">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-cipher-orange" /> <span className="text-muted">above baseline</span></span>
              <span className="flex items-center gap-1"><span className={styles.belowKey} /> <span className="text-muted">below baseline</span></span>
            </div>
          </div>
          <p className="text-caption text-muted mb-2 leading-relaxed">
            Observed share of transactions minus a daily routine model weighted by node locations, in percentage points. A difference is not evidence of bots or automated activity.

          </p>
          {!hasNodes ? <p className={styles.empty}>Node observations are needed to calculate this baseline.</p> : <div className="h-[180px] min-w-0 overflow-hidden">
            <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height="100%">
              <BarChart data={residualBars} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <ReferenceLine y={0} stroke="var(--color-text-muted)" strokeOpacity={0.5} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fontFamily: 'var(--font-geist-mono), monospace' }} stroke="var(--color-text-muted)" interval={2} tickFormatter={(l) => `${l}h`} />
                <YAxis
                  tick={{ fontSize: 12, fontFamily: 'var(--font-geist-mono), monospace' }}
                  stroke="var(--color-text-muted)"
                  width={64}
                  tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}pt`}
                />
                <Tooltip content={<ResidualTooltip />} />
                <Bar dataKey="residual" radius={[2, 2, 0, 0]}>
                  {residualBars.map((d) => (
                    <Cell key={d.hour} fill={d.residual >= 0 ? 'var(--color-orange)' : 'var(--color-text-secondary)'} opacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>}
          <ChartWatermark />
        </div>
      </div>

      {/* Weekday/hour totals */}
      <div className="mt-5 rounded-xl border border-cipher-border bg-cipher-surface p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h2 className="text-xs font-mono font-semibold text-secondary uppercase tracking-wider">Seven days, twenty-four hours</h2>
          <span className="text-caption font-mono text-muted">Low → high · UTC</span>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[460px]">
            <div className="flex pl-9 mb-1">
              {[0, 6, 12, 18].map((h) => (
                <div key={h} className="text-caption font-mono text-muted" style={{ width: '25%' }}>{String(h).padStart(2, '0')}h</div>
              ))}
            </div>
            {heat.grid.map((row, ri) => (
              <div key={ri} className="flex items-center gap-1 mb-1">
                <div className="w-8 text-caption font-mono text-muted text-right pr-1">{DOW_LABELS[ri]}</div>
                <div className="flex gap-[2px] flex-1">
                  {row.map((v, hi) => (
                    <div
                      key={hi}
                      className={styles.heatCell}
                      tabIndex={0}
                      role="img"
                      aria-label={`${DOW_LABELS[ri]} ${String(hi).padStart(2, '0')}:00 UTC · ${v.toLocaleString('en-US')} transactions`}
                      style={{ height: 18, backgroundColor: heatColor(v / heat.max) }}
                      title={`${DOW_LABELS[ri]} ${String(hi).padStart(2, '0')}:00 UTC · ${fmt(v)} txs`}
                    ><span className={styles.heatTip}>{DOW_LABELS[ri]} {String(hi).padStart(2, '0')}:00 · {v.toLocaleString('en-US')} txs</span></div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <ChartWatermark />
      </div>

      <details className={styles.methodology}>
        <summary>How to read these charts</summary>
        <div className="space-y-3 text-sm text-secondary leading-relaxed">
          <p>Activity is grouped by UTC block timestamp across the selected period. Heatmap cells are total transactions for each weekday/hour combination, not daily averages. The dial uses a zero baseline and compares each hour with the busiest hour.</p>
          <p>The daylight layer uses today’s solar declination at the selected UTC hour. It is a simulation, not a live transaction stream or a reconstruction of historical sunlight. Node observations describe the current available network snapshot.</p>
          <p>The timing model fits three fixed routine profiles at UTC−6, UTC+1 and UTC+8 in 2% weight steps. The baseline weights the same routine by node counts, with offsets approximated from longitude. Neither model measures people’s locations; no adjustment is made for daylight saving or regional behavior.</p>
          <p>Block timestamps describe when transactions were recorded. Node geography, timing weights and baseline differences cannot identify users or distinguish human activity from automation. <Link href="/privacy" className="underline">Explore privacy metrics</Link>.</p>
        </div>
      </details>
      </>}
    </div>
  );
}
