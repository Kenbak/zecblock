import type { CSSProperties } from 'react';
import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadBlockSpeedSnapshot } from '@/lib/block-speed-server';
import { confirmationSeconds, formatDay, formatWait, nu7Average, SPENDABLE_CONFIRMATIONS, type SpeedPoint } from '@/lib/block-speed';
import { EXPORT_SIZE } from '@/lib/chart-sharing';
import { getChartColors } from '@/lib/chart-theme';
import { getNetwork } from '@/lib/seo';

export const runtime = 'nodejs';

const PLOT_WIDTH = 1020;
const PLOT_HEIGHT = 310;
const TOP = 28;
const MUTED = '#565D68';
const minutes = (seconds: number, blocks = SPENDABLE_CONFIRMATIONS) => seconds * blocks / 60;

function barStyle(point: SpeedPoint, color: string) {
  if (point.kind === 'projected') return { fill: 'none', stroke: color, strokeDasharray: '4 3', strokeWidth: 1.5 };
  if (point.kind === 'irregular') return { fill: color, fillOpacity: 0.35 };
  return { fill: color };
}

/** Same template as the catalog chart cards (`ChartExport`), drawn from the block-speed story. */
export async function GET() {
  const network = getNetwork();
  if (network === 'crosslink-testnet') return new Response('Not found', { status: 404 });
  const { host, story } = await loadBlockSpeedSnapshot(network);
  const after = story ? nu7Average(story) : null;
  // Do not cache an outage as a chart or manufacture values.
  if (!host || !story || after == null || !story.points.length) {
    return new Response('Block speed data temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
  }
  const colors = getChartColors('dark');
  const points = story.points;
  const before = story.network === 'mainnet' ? story.before?.averageSeconds ?? null : null;
  const wait = (seconds: number | null) => formatWait(confirmationSeconds(seconds, SPENDABLE_CONFIRMATIONS));
  // Lead with the one comparison people share; the chart and description carry the detail.
  const title = before != null ? `With NU7, received funds spendable in ${wait(after)}, not ${wait(before)}` : `With NU7, received funds spendable in ${wait(after)}`;
  const peak = Math.max(...points.map(point => minutes(point.averageSeconds)), ...points.map(point => minutes(point.targetSeconds ?? 0)));
  const step = [1, 2, 5, 10, 15, 20].find(s => peak / s <= 4) ?? Math.ceil(peak / 40) * 10;
  const max = Math.ceil(peak * 1.08 / step) * step;
  const y = (value: number) => TOP + (PLOT_HEIGHT - TOP) * (1 - value / max);
  const slot = PLOT_WIDTH / points.length;
  const barWidth = Math.max(3, slot * 0.68);
  const ticks = Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  const nu7Index = points.findIndex(p => p.nu7);
  const projectedIndex = points.findIndex(p => p.kind === 'projected');
  const targets = points.flatMap((p, i) => p.targetSeconds != null && points[i - 1]?.targetSeconds !== p.targetSeconds ? [i] : []);
  const legend: { label: string; style: CSSProperties }[] = [
    { label: 'First confirmation', style: { background: colors.gold } },
    { label: `${SPENDABLE_CONFIRMATIONS - 1} more confirmations`, style: { background: MUTED } },
    points.some(p => p.kind === 'projected') && { label: 'Target projection', style: { border: `1px dashed ${MUTED}` } },
  ].filter(item => item !== false);
  const description = story.network === 'mainnet'
    ? story.phase === 'active'
      ? before != null
        ? `${SPENDABLE_CONFIRMATIONS} confirmations: ${wait(before)} before NU7 → ${wait(after)} with NU7, both measured.`
        : `${SPENDABLE_CONFIRMATIONS} confirmations: ${wait(after)} measured with NU7.`
      : before != null
        ? `${SPENDABLE_CONFIRMATIONS} confirmations: ${wait(before)} measured (7-day average) → ${wait(after)} at the NU7 target.`
        : `${SPENDABLE_CONFIRMATIONS} confirmations at the NU7 target: ${wait(after)}.`
    : `${SPENDABLE_CONFIRMATIONS} confirmations: ${wait(after)} measured with NU7. Pre-NU7 minimum-difficulty days are not comparable.`;
  const footnote = 'Assumes next-block inclusion and unchanged ZIP 315 counts. Wallet policies can differ.';
  const activationLabel = 'NU7';
  const activationLabelFits = nu7Index * slot + activationLabel.length * 8 + 10 < PLOT_WIDTH;
  const observed = new Date(host.observedAt).toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC');
  const [logo, font] = await Promise.all([
    readFile(join(process.cwd(), 'public/brand/zecblock-logotype.png')),
    readFile(join(process.cwd(), 'public/fonts/chart-export/Geist-Regular.ttf')),
  ]);
  return new ImageResponse(<div style={{ width: 1200, height: 675, padding: '36px 44px', background: '#0B0C0E', color: '#F1F3F5', display: 'flex', flexDirection: 'column', fontFamily: 'ZecBlock Export' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div style={{ display: 'flex', fontSize: 30, fontWeight: 400, maxWidth: 850 }}>{title}</div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`data:image/png;base64,${logo.toString('base64')}`} alt="ZecBlock" width={155} height={36} />
    </div>
    <div style={{ display: 'flex', marginTop: 10, fontSize: 17, color: '#9CA4B0' }}>{formatDay(points[0].date)} – {formatDay(points.at(-1)!.date)} UTC · expected minutes · {network}</div>
    <div style={{ display: 'flex', gap: 22, marginTop: 19, height: 32, fontSize: 16 }}>
      {legend.map(item => <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 9, height: 9, ...item.style }} />{item.label}</div>)}
    </div>
    <div style={{ display: 'flex', position: 'relative', height: 350, marginTop: 18 }}>
      {ticks.map(tick => <div key={tick} style={{ position: 'absolute', display: 'flex', top: y(tick) - 9, left: 0, width: 76, justifyContent: 'flex-end', fontSize: 14, color: '#9CA4B0' }}>{tick} min</div>)}
      <svg width={PLOT_WIDTH} height={PLOT_HEIGHT} viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`} style={{ position: 'absolute', left: 90, top: 0 }}>
        {ticks.map(tick => <line key={tick} x1={0} x2={PLOT_WIDTH} y1={y(tick)} y2={y(tick)} stroke="#20242A" />)}
        {points.map((point, i) => {
          const first = y(minutes(point.averageSeconds, 1));
          const total = y(minutes(point.averageSeconds));
          const x = i * slot + (slot - barWidth) / 2;
          return <g key={point.key}>
            <rect x={x} y={first} width={barWidth} height={Math.max(0, y(0) - first)} {...barStyle(point, colors.gold)} />
            <rect x={x} y={total} width={barWidth} height={Math.max(0, first - total)} {...barStyle(point, MUTED)} />
          </g>;
        })}
        {targets.map((from, k) => {
          const to = targets[k + 1] ?? points.length;
          const level = y(minutes(points[from].targetSeconds!));
          return <line key={from} x1={from * slot} x2={to * slot} y1={level} y2={level} stroke="#9CA4B0" strokeDasharray="4 4" />;
        })}
        {projectedIndex > 0 && projectedIndex !== nu7Index && <line x1={projectedIndex * slot} x2={projectedIndex * slot} y1={TOP - 6} y2={PLOT_HEIGHT} stroke={MUTED} />}
        {nu7Index > 0 && <line x1={nu7Index * slot} x2={nu7Index * slot} y1={TOP - 6} y2={PLOT_HEIGHT} stroke={colors.gold} strokeDasharray="3 4" />}
      </svg>
      {targets.map((from, k) => {
        const to = targets[k + 1] ?? points.length;
        if ((to - from) * slot <= 72) return null;
        const target = points[from].targetSeconds!;
        const tallest = y(Math.max(...points.slice(from, to).map(point => minutes(point.averageSeconds))));
        const labelAtProjection = projectedIndex >= from && projectedIndex < to && (to - projectedIndex) * slot > 80;
        return <span key={from} style={{ position: 'absolute', top: Math.min(y(minutes(target)), tallest) - 22, ...(labelAtProjection ? { left: 90 + projectedIndex * slot + 6 } : { right: PLOT_WIDTH - to * slot + 6 }), fontSize: 14, color: '#C2C7CF' }}>{target}s blocks</span>;
      })}
      {projectedIndex > 0 && (nu7Index <= 0 || (nu7Index - projectedIndex) * slot > 175) && <span style={{ position: 'absolute', top: 0, left: 90 + projectedIndex * slot + 6, fontSize: 14, color: '#9CA4B0' }}>Projection starts</span>}
      {nu7Index > 0 && <span style={{ position: 'absolute', top: 0, ...(activationLabelFits ? { left: 90 + nu7Index * slot + 6 } : { right: PLOT_WIDTH - nu7Index * slot + 8 }), fontSize: 14, color: colors.gold }}>{activationLabel}</span>}
      <div style={{ display: 'flex', position: 'absolute', top: 325, left: 90, width: PLOT_WIDTH, justifyContent: 'space-between', color: '#9CA4B0', fontSize: 14 }}>
        <span>{formatDay(points[0].date)}</span>
        {nu7Index > 0 && nu7Index * slot > 75 && nu7Index * slot < PLOT_WIDTH - 100 && <span style={{ position: 'absolute', left: nu7Index * slot + 6, color: colors.gold }}>{formatDay(points[nu7Index].date)}</span>}
        <span>{formatDay(points.at(-1)!.date)}</span>
      </div>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 15, color: '#C2C7CF', marginTop: 9, height: 42 }}>
      <span>{description}</span>
      <span>{footnote}</span>
    </div>
    <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #2C3037', paddingTop: 15, marginTop: 'auto', fontSize: 14, color: '#9CA4B0' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span>Source: canonical block-header timestamps · {network}</span><span>Latest observation · {observed}</span></div>
      <span style={{ color: '#F1F3F5', alignSelf: 'flex-end', fontSize: 18 }}>zecblock.com</span>
    </div>
  </div>, {
    ...EXPORT_SIZE,
    fonts: [{ name: 'ZecBlock Export', data: font, weight: 400, style: 'normal' }],
    headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600', 'X-Robots-Tag': 'noindex' },
  });
}
