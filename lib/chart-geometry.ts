import type { CatalogChart, ChartRow } from './chart-catalog';

/** Space markers across the window, retaining its last and isolated observations. */
export function chartMarkerIndices(rows: ChartRow[], key: string): Set<number> {
  const valid = rows.map(row => typeof row[key] === 'number' && Number.isFinite(row[key]));
  const stride = Math.max(1, Math.ceil(rows.length / 24));
  const indices = new Set<number>();
  let lastValid = -1;
  valid.forEach((available, index) => {
    if (!available) return;
    lastValid = index;
    if (index % stride === 0 || (!valid[index - 1] && !valid[index + 1])) indices.add(index);
  });
  if (lastValid >= 0) indices.add(lastValid);
  return indices;
}

export function chartGeometry(chart: CatalogChart, input: ChartRow[], width = 1020, height = 310) {
  const category = chart.axis === 'category';
  const rows = category ? input.slice(0, 14) : input;
  const values = rows.flatMap(row => chart.stack
    ? [chart.series.reduce((sum, s) => sum + (typeof row[s.key] === 'number' ? Math.max(0, Number(row[s.key])) : 0), 0), chart.series.reduce((sum, s) => sum + (typeof row[s.key] === 'number' ? Math.min(0, Number(row[s.key])) : 0), 0)]
    : chart.series.map(s => row[s.key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
  const min = chart.percent ? 0 : Math.min(0, ...values);
  const max = chart.percent ? 100 : Math.max(0, ...values);
  const top = max === min ? min + 1 : max;
  const markerPadding = chart.kind !== 'bar' && chart.series.some(series => series.marker) ? 5 : 0;
  const y = (value: number) => height - markerPadding - (value - min) / (top - min) * (height - 2 * markerPadding);
  const xMin = Number(rows[0]?.x ?? 0), xMax = Number(rows.at(-1)?.x ?? 1);
  const x = (row: ChartRow, index: number) => category ? (index + .5) / Math.max(rows.length, 1) * width : xMax === xMin ? width / 2 : (Number(row.x) - xMin) / (xMax - xMin) * (width - 12) + 6;
  const paths = chart.series.map((series, si) => {
    const segments: { x: number; top: number; bottom: number; index: number }[][] = [];
    let segment: { x: number; top: number; bottom: number; index: number }[] = [];
    rows.forEach((row, i) => {
      const value = row[series.key];
      const valid = typeof value === 'number' && Number.isFinite(value) && (!chart.stack || chart.series.every(s => typeof row[s.key] === 'number'));
      if (!valid) { if (segment.length) segments.push(segment); segment = []; return; }
      const bottom = chart.stack ? chart.series.slice(0, si).reduce((sum, s) => sum + Number(row[s.key]), 0) : 0;
      segment.push({ x: x(row, i), top: y(bottom + value), bottom: y(bottom), index: i });
    });
    if (segment.length) segments.push(segment);
    const line = segments.map(points => points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.top.toFixed(2)}`).join(' ')).join(' ');
    const area = segments.map(points => `${points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.top.toFixed(2)}`).join(' ')} ${[...points].reverse().map(p => `L${p.x.toFixed(2)},${p.bottom.toFixed(2)}`).join(' ')} Z`).join(' ');
    const markerIndices = series.marker ? chartMarkerIndices(rows, series.key) : new Set<number>();
    const markers = segments.flat().filter(point => markerIndices.has(point.index));
    return { series, line, area, segments, markers };
  });
  return { rows, min, max: top, y, x, paths, ticks: Array.from({ length: 5 }, (_, i) => min + (top - min) * i / 4) };
}
