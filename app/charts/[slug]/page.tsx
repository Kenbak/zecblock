import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { buildPageMetadata, getBaseUrl } from '@/lib/seo';
import { findShareChart, chartPublicTitle, chartSource, normalizeChartRange, selectedChartSeries, chartSharePath, chartImagePath, chartRangeRows, chartDateRange, EXPORT_SIZE } from '@/lib/chart-sharing';
import { delayedChartSnapshotLabel, loadShareChart } from '@/lib/chart-share-server';
import { CatalogCard } from '../ChartsClient';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
export async function generateMetadata({ params, searchParams }: Props) {
  const chart = findShareChart((await params).slug);
  if (!chart) notFound();
  const query = await searchParams;
  const range = normalizeChartRange(query.range);
  const selected = selectedChartSeries(chart, query.series);
  const path = chartSharePath(chart.id, range, selected.series.length === chart.series.length ? undefined : selected.series.map(s => s.key));
  const metadata = buildPageMetadata({ title: `${chartPublicTitle(chart)} | ZecBlock`, description: chart.description, path: `/charts/${chart.id}`, networks: ['mainnet'] });
  const image = { url: `${getBaseUrl()}${chartImagePath(path)}`, ...EXPORT_SIZE, alt: `${chartPublicTitle(chart)} · ${chart.unit} · ZecBlock` };
  return { ...metadata, openGraph: { ...metadata.openGraph, url: `${getBaseUrl()}${path}`, images: [image] }, twitter: { ...metadata.twitter, card: 'summary_large_image' as const, images: [image] } };
}
export default async function ChartPage({ params, searchParams }: Props) {
  const chart = findShareChart((await params).slug);
  if (!chart) notFound();
  const query = await searchParams;
  const range = normalizeChartRange(query.range);
  const selected = selectedChartSeries(chart, query.series);
  const snapshot = await loadShareChart(chart);
  const rows = snapshot ? chartRangeRows(chart, snapshot.rows, range) : [];
  const delayedSnapshot = snapshot ? delayedChartSnapshotLabel(snapshot.fetchedAt, snapshot.meta.freshness) : undefined;
  const url = `${getBaseUrl()}/charts/${chart.id}`;
  const schema = { '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${url}#webpage`, url, name: chartPublicTitle(chart), description: chart.description, isPartOf: { '@id': `${getBaseUrl()}/#website` }, publisher: { '@id': 'https://zecblock.com/#organization' } };
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }}/>
    <Link href="/charts" className="text-caption text-muted hover:text-primary">← All charts</Link>
    <PageHeader eyebrow="CHART_LIBRARY" title={chartPublicTitle(chart)} subtitle={chart.description}/>
    <p className="mb-5 text-caption text-muted">Source: {chartSource(chart)} · {chart.unit} · {rows.length ? chartDateRange(chart, rows) : chart.window}. {rows.length ? `${rows.length.toLocaleString('en-US')} observations.` : 'Observations are currently unavailable; this page will retry.'}</p>
    <CatalogCard chart={chart} initialData={snapshot?.payload} initialFetchedAt={snapshot?.fetchedAt} initialSnapshotNotice={delayedSnapshot} initialRange={range} initialSeries={selected.series.map(s => s.key)} standalone/>
  </div>;
}
