import { CHART_CATALOG, type CatalogChart, type ChartRow } from './chart-catalog';

/** Dedicated pages and exports need context when seen outside the chart hub. */
export function chartPublicTitle(chart: Pick<CatalogChart, 'title'>): string {
  return /\bzcash\b/i.test(chart.title) ? chart.title : `${chart.title} — Zcash`;
}

export const EXPORT_SIZE = { width: 1200, height: 675 } as const;
export const CHART_RANGES = ['7d', '30d', '90d', '1y', 'all'] as const;
export type ChartRange = typeof CHART_RANGES[number];
export interface ChartExportData {
  chart: CatalogChart;
  rows: ChartRow[];
  source?: string;
  asOf?: string;
  network?: string;
}
export function findShareChart(id: string) { return CHART_CATALOG.find(chart => chart.id === id); }
export function normalizeChartRange(value: unknown): ChartRange {
  return CHART_RANGES.includes(value as ChartRange) ? value as ChartRange : '30d';
}
export function chartRangeRows(chart: CatalogChart, rows: ChartRow[], range: ChartRange): ChartRow[] {
  if (chart.axis || range === 'all' || !rows.length) return rows;
  const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[range];
  // Anchor to actual observations, not the render time. Never invent older data.
  const cutoff = Number(rows.at(-1)!.x) - days * 86400000;
  return rows.filter(row => Number(row.x) > cutoff);
}
export function selectedChartSeries(chart: CatalogChart, value: unknown): CatalogChart {
  if (typeof value !== 'string') return chart;
  const selected = new Set(value.split(','));
  const series = chart.series.filter(item => selected.has(item.key));
  return series.length ? { ...chart, series } : chart;
}
export function chartSharePath(id: string, range: ChartRange = '30d', series?: string[]): string {
  const query = new URLSearchParams();
  query.set('range', range);
  if (series?.length) query.set('series', series.join(','));
  return `/charts/${id}${query.size ? `?${query}` : ''}`;
}
export function chartImagePath(path: string): string {
  const [base, query] = path.split('?');
  return `${base}/image${query ? `?${query}` : ''}`;
}
export function chartEndpoint(chart: CatalogChart): string {
  return chart.endpoint;
}
export function chartObservationLabel(chart: CatalogChart, x: string | number): string {
  if (chart.axis === 'category') return String(x);
  if (chart.axis === 'height') return `Block ${Number(x).toLocaleString('en-US')}`;
  return new Date(Number(x)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
export function chartDateRange(chart: CatalogChart, rows: ChartRow[]): string {
  if (chart.axis === 'category' || !rows.length) return chart.window;
  return `${chartObservationLabel(chart, rows[0].x)} – ${chartObservationLabel(chart, rows.at(-1)!.x)}${chart.axis ? '' : ' UTC'}`;
}
/** Raw values and explicit columns; missing cells stay empty. Prevent spreadsheet formulas. */
export function chartCsv({ chart, rows, source = chartSource(chart), asOf = '' }: ChartExportData): string {
  const cell = (value: unknown) => {
    const text = value == null ? '' : String(value);
    const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const records: unknown[][] = [
    ['Chart', chartPublicTitle(chart)], ['Source', source], ['Window', chartDateRange(chart, rows)], ['As of', asOf],
    [chart.axis === 'height' ? 'Block height' : chart.axis === 'category' ? 'Category' : 'Date (UTC)', ...chart.series.map(s => `${s.label} (${chart.unit})`)],
    ...rows.map(row => [chart.axis ? row.x : new Date(Number(row.x)).toISOString(), ...chart.series.map(s => row[s.key])]),
  ];
  return records.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function chartSource(chart: CatalogChart): string {
  return chart.id === 'search-interest' ? 'Google Trends CSV · imported by ZecBlock' : 'ZecBlock analytics API';
}
export function chartSnapshotLabel(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const generatedAt = (payload as { generatedAt?: unknown }).generatedAt;
  if (typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt))) return undefined;
  return `Source snapshot · ${new Date(generatedAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}`;
}
