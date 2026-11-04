import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChartExport } from '@/components/charts/ChartExport';
import { EXPORT_SIZE, chartSnapshotLabel, findShareChart, normalizeChartRange, selectedChartSeries, chartRangeRows } from '@/lib/chart-sharing';
import { delayedChartSnapshotLabel, loadShareChart } from '@/lib/chart-share-server';
import { getNetwork } from '@/lib/seo';

export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const chart = findShareChart((await params).slug);
  if (!chart) return new Response('Chart not found', { status: 404 });
  const query = new URL(request.url).searchParams;
  // Social crawlers cannot retry through the browser chart; allow the bounded
  // cache refresh to finish without extending the page's foreground budget.
  const snapshot = await loadShareChart(chart, 10_000);
  // Do not cache an outage as a chart or manufacture zeros.
  if (!snapshot || !snapshot.rows.some(row => chart.series.some(s => typeof row[s.key] === 'number'))) {
    return new Response('Chart data temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
  }
  const rows = chartRangeRows(chart, snapshot.rows, normalizeChartRange(query.get('range')));
  const [logo, font] = await Promise.all([readFile(join(process.cwd(), 'public/brand/zecblock-logotype.png')), readFile(join(process.cwd(), 'public/fonts/chart-export/Geist-Regular.ttf'))]);
  return new ImageResponse(<ChartExport data={{ chart: selectedChartSeries(chart, query.get('series')), rows, network: getNetwork(), asOf: delayedChartSnapshotLabel(snapshot.fetchedAt, snapshot.meta.freshness) ?? (chart.axis === 'category' ? chartSnapshotLabel(snapshot.payload) : undefined) }} logo={`data:image/png;base64,${logo.toString('base64')}`}/>, {
    ...EXPORT_SIZE,
    fonts: [{ name: 'ZecBlock Export', data: font, weight: 400, style: 'normal' }],
    headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600', 'X-Robots-Tag': 'noindex' },
  });
}
