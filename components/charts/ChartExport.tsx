import { chartGeometry } from '@/lib/chart-geometry';
import { formatCatalogValue } from '@/lib/chart-catalog';
import { chartPublicTitle, chartSource, chartDateRange, chartObservationLabel, type ChartExportData } from '@/lib/chart-sharing';
import { getChartColors } from '@/lib/chart-theme';

/** One viewport-independent template for browser PNGs and server social cards. */
export function ChartExport({ data, logo = '/brand/zecblock-logotype.png' }: { data: ChartExportData; logo?: string }) {
  const { chart, rows, source = chartSource(chart), network = 'mainnet' } = data;
  const colors = getChartColors('dark');
  const hasSummaries = chart.series.some(series => series.summary);
  const plotHeight = hasSummaries ? 294 : 310;
  const g = chartGeometry(chart, rows, 1020, plotHeight);
  const category = chart.axis === 'category';
  const latest = rows.at(-1);
  const asOf = data.asOf || (latest && !category ? `Latest observation · ${chartObservationLabel(chart, latest.x)}` : 'Observation time unavailable');
  const tickRows = [...new Set([0, Math.floor((rows.length - 1) / 3), Math.floor((rows.length - 1) * 2 / 3), rows.length - 1])].filter(i => i >= 0);
  return <div style={{ width: 1200, height: 675, padding: '36px 44px', background: '#0B0C0E', color: '#F1F3F5', display: 'flex', flexDirection: 'column', fontFamily: 'ZecBlock Export' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div style={{ display: 'flex', fontSize: 30, fontWeight: 400, maxWidth: 850 }}>{chartPublicTitle(chart)}</div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logo} alt="ZecBlock" width={155} height={36} />
    </div>
    <div style={{ display: 'flex', marginTop: 10, fontSize: 17, color: '#9CA4B0' }}>{chartDateRange(chart, rows)} · {chart.unit}</div>
    <div style={{ display: 'flex', gap: 22, marginTop: 19, height: hasSummaries ? 48 : 32, fontSize: hasSummaries ? 14 : 16 }}>
      {chart.series.map(s => <div key={s.key} data-series-summary={s.summary ? s.key : undefined} style={{ display: 'flex', ...(hasSummaries ? { flex: 1 } : {}), minWidth: 0, flexDirection: 'column', gap: 2, justifyContent: hasSummaries ? 'flex-start' : 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...(hasSummaries ? { height: 18 } : {}) }}>{s.marker === 'diamond' ? <svg width={12} height={12} viewBox="0 0 12 12"><path d="M6 1 L11 6 L6 11 L1 6 Z" stroke={colors[s.color]} strokeWidth={1.5} fill="#0B0C0E"/></svg> : <span style={{ width: 9, height: 9, background: colors[s.color] }}/>} {s.label}</div>
        {s.summary ? <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 22, lineHeight: 1.1 }}>{s.summary.primary}</span>
          <span style={{ fontSize: 13, lineHeight: 1.25, color: '#9CA4B0' }}>({s.summary.secondary})</span>
        </div> : null}
      </div>)}
    </div>
    <div style={{ display: 'flex', position: 'relative', height: plotHeight + 40, marginTop: 18 }}>
      {!rows.length ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', color: '#9CA4B0', fontSize: 24 }}>Observations unavailable</div> : category ?
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 5 }}>
          {g.rows.map((row, i) => <div key={i} style={{ display: 'flex', alignItems: 'center', height: 19, fontSize: 14, gap: 12 }}>
            <span style={{ width: 190, overflow: 'hidden', whiteSpace: 'nowrap' }}>{String(row.x).slice(0, 27)}</span>
            <div style={{ display: 'flex', flexDirection: 'column', width: 690, gap: 2 }}>{chart.series.map(s => typeof row[s.key] === 'number' ? <div key={s.key} style={{ display: 'flex', height: chart.series.length > 1 ? 5 : 9, width: Math.max(0, Number(row[s.key])) / g.max * 690, background: colors[s.color] }}/> : null)}</div>
            <span style={{ display: 'flex', width: 205, justifyContent: 'flex-end', color: '#C2C7CF' }}>{chart.series.map(s => row[s.key] == null ? '—' : formatCatalogValue(Number(row[s.key]), chart.unit, true)).join(' / ')}</span>
          </div>)}
          {rows.length > g.rows.length && <div style={{ display: 'flex', fontSize: 14, color: '#9CA4B0' }}>First {g.rows.length} of {rows.length} categories · complete data in CSV</div>}
        </div> : <>
          {g.ticks.map(tick => <div key={tick} style={{ position: 'absolute', display: 'flex', top: g.y(tick) - 9, left: 0, width: 76, justifyContent: 'flex-end', fontSize: 14, color: '#9CA4B0' }}>{formatCatalogValue(tick, chart.unit, true)}</div>)}
          <svg width={1020} height={plotHeight} viewBox={`0 0 1020 ${plotHeight}`} style={{ position: 'absolute', left: 90, top: 0 }}>
            {g.ticks.map(tick => <line key={tick} x1={0} x2={1020} y1={g.y(tick)} y2={g.y(tick)} stroke="#20242A"/>)}
            {chart.reference != null && <line x1={0} x2={1020} y1={g.y(chart.reference)} y2={g.y(chart.reference)} stroke="#565D68" strokeDasharray="4 4"/>}
            {g.paths.map(({ series, line, area, segments, markers }, si) => <g key={series.key}>
              {chart.kind === 'bar' ? g.rows.map((row, i) => {
                const value = row[series.key]; if (typeof value !== 'number') return null;
                const width = Math.min(16, 850 / Math.max(1, rows.length) / chart.series.length);
                return <rect key={i} x={g.x(row, i) - width * chart.series.length / 2 + width * si} y={Math.min(g.y(0), g.y(value))} width={width} height={Math.abs(g.y(0) - g.y(value))} fill={colors[series.color]}/>;
              }) : <g>
                {chart.kind === 'area' && <path d={area || 'M0 0'} fill={colors[series.color]} fillOpacity={.28}/>}
                <path d={line || 'M0 0'} stroke={colors[series.color]} strokeWidth={series.strokeWidth ?? 2.5} fill="none"/>
                {series.marker === 'diamond'
                  ? markers.map(point => <path key={point.index} data-marker="diamond" d={`M${point.x},${point.top - 4} l4,4 l-4,4 l-4,-4 Z`} stroke={colors[series.color]} strokeWidth={1.5} fill="#0B0C0E"/>)
                  : segments.filter(segment => segment.length === 1).map((segment, i) => <circle key={i} cx={segment[0].x} cy={segment[0].top} r={3} fill={colors[series.color]}/>)}
              </g>}
            </g>)}
          </svg>
          <div style={{ display: 'flex', position: 'absolute', top: plotHeight + 15, left: 90, width: 1020, justifyContent: 'space-between', color: '#9CA4B0', fontSize: 14 }}>{tickRows.map(i => <span key={i}>{chartObservationLabel(chart, rows[i].x)}</span>)}</div>
        </>}
    </div>
    <div style={{ display: 'flex', fontSize: hasSummaries ? 14 : 15, ...(hasSummaries ? { lineHeight: 1.4, minHeight: 32 } : {}), color: '#C2C7CF', marginTop: 9, height: 38 }}>{chart.description}</div>
    <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #2C3037', paddingTop: 15, marginTop: 'auto', fontSize: 14, color: '#9CA4B0' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span>Source: {source} · {network}</span><span>{asOf}</span></div>
      <span style={{ color: '#F1F3F5', alignSelf: 'flex-end', fontSize: 18 }}>zecblock.com</span>
    </div>
  </div>;
}
