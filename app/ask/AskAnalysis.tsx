'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import type { AnalysisSpec } from '@/lib/ask/contract';
import { fetchEvidence, formatValue, summarizeEvidence, type Evidence } from '@/lib/ask/evidence';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { describeMetric, formatChain } from '@/lib/ask/data';
import styles from './ask.module.css';
import research from './research.module.css';
import { CopyButton } from '../../lib/ask/copy-button';

const AskChart = dynamic(() => import('./AskChart'), { ssr: false, loading: () => <div className="h-80 grid place-items-center text-sm text-muted" role="status">Loading chart…</div> });

/** Each reply owns its view and observations; expanding does not refetch them. */
export function AskAnalysis({ spec, changed, onChange, onExplain, canExplain, busy, sources }: { sources?: ReactNode; spec: AnalysisSpec; changed: boolean; onChange: (spec: AnalysisSpec) => void; onExplain: () => void; canExplain: boolean; busy: boolean }) {
  const [fetchedEvidence, setEvidence] = useState<Evidence | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [tablePage, setTablePage] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const info = describeMetric(spec.metric);
  const ranking = spec.metric.startsWith('chain_');
  const poolMetric = ['balances', 'flows', 'activity'].includes(spec.metric);
  const evidence = fetchedEvidence?.key === `${spec.metric}:${spec.period}:${spec.pool}` ? fetchedEvidence : null;
  const start = spec.start || '', end = spec.end || '';
  const summary = evidence ? summarizeEvidence(evidence, spec, start, end) : null;
  const invalidDates = Boolean(start && end && start > end);
  const { metric, period, pool } = spec;
  useEffect(() => {
    setEvidence(null); setError(''); setTablePage(0); setLoadingData(true);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    fetchEvidence({ version: 1, metric, period, pool, view: metric.startsWith('chain_') ? 'bar' : 'line', start: null, end: null }, signal)
      .then(result => { if (!signal.aborted) setEvidence(result); })
      .catch(() => { if (!controller.signal.aborted) setError('Source data is temporarily unavailable. Retry or open the source page.'); })
      .finally(() => { if (!controller.signal.aborted) setLoadingData(false); });
    return () => controller.abort();
  }, [metric, period, pool, refresh]);
  useEffect(() => { setTablePage(0); }, [start, end, spec.view]);
  useEffect(() => { if (expanded && !dialog.current?.open) dialog.current?.showModal(); else if (!expanded && dialog.current?.open) dialog.current.close(); }, [expanded]);
  function exportCsv() {
    if (!summary || !evidence) return;
    const rows = [[evidence.dimension === 'chain' ? 'chain' : 'date_utc', ...evidence.series.map(series => `${series.key}_${evidence.csvUnit}`)], ...summary.points.map(point => [point.date, ...evidence.series.map(series => point.values[series.key] ?? '')])];
    const url = URL.createObjectURL(new Blob([rows.map(row => row.join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `zecblock-${spec?.metric}-${ranking ? spec?.period : `${summary.start}-${summary.end}`}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const content = <div className="p-4 sm:p-5">
            <h3 className="text-xl text-primary font-medium tracking-tight">{info?.title}</h3>
            <p className="mt-2 text-caption font-mono text-muted">MAINNET · {ranking ? 'LAST 30 DAYS · BY CHAIN' : 'DAILY'} · {spec.metric === 'activity' ? 'FLOW RECORDS' : info?.unit.toUpperCase()}</p>
            <details className={styles.viewCustomization}><summary>Customize view</summary>
            <div className={`${styles.controls} ${!poolMetric ? styles.twoControls : ''}`}>
              <label>Period<select disabled={ranking || busy} value={spec.period} onChange={event => onChange({ ...spec, period: event.target.value as AnalysisSpec['period'] })}><option value="30d">Last 30 days</option>{!ranking ? <option value="90d">Last 90 days</option> : null}{!ranking && !spec.metric.startsWith('swap_') ? <option value="1y">Last year</option> : null}</select></label>
              {poolMetric ? <label>Pool<select disabled={busy} value={spec.pool} onChange={event => onChange({ ...spec, pool: event.target.value as AnalysisSpec['pool'] })}><option value="all">All pools</option><option value="orchard">Orchard</option><option value="ironwood">Ironwood</option><option value="sapling">Sapling</option></select></label> : null}
              <label>View<select disabled={busy} value={spec.view} onChange={event => onChange({ ...spec, view: event.target.value as AnalysisSpec['view'] })}>{!ranking ? <option value="line">Line chart</option> : null}<option value="bar">Bar chart</option><option value="table">Table</option></select></label>
            </div>
              {evidence ? <>{!ranking ? <div className={styles.dateRange}><label>From (UTC)<input disabled={busy} type="date" value={start || evidence.points[0]?.date || ''} min={evidence.points[0]?.date} max={end || evidence.points.at(-1)?.date} onChange={event => { if (event.target.validity.valid) onChange({ ...spec, start: event.target.value || null }); }} /></label><label>To (UTC)<input disabled={busy} type="date" value={end || evidence.points.at(-1)?.date || ''} min={start || evidence.points[0]?.date} max={evidence.points.at(-1)?.date} onChange={event => { if (event.target.validity.valid) onChange({ ...spec, end: event.target.value || null }); }} /></label></div> : null}</> : null}
            </details>
            {loadingData ? <div className="h-80 grid place-items-center text-sm text-muted" role="status">Reading indexed observations…</div> : error ? <div className="py-20 text-center text-sm text-secondary" role="alert"><p>{error}</p><button onClick={() => setRefresh(value => value + 1)} className="mt-4 text-cipher-gold hover:underline">Retry</button><Link href={describeMetric(spec.metric).source} className="ml-5 text-cipher-gold hover:underline">Open source ↗</Link></div> : evidence && summary ? <>

              {invalidDates ? <p role="alert" className="py-8 text-sm text-warning">Choose an end date on or after the start date.</p> : !summary.points.length ? <p className="py-20 text-sm text-muted text-center" role="status">{spec.metric === 'pulse' ? 'No recorded alerts are available for this window. This does not establish that every detector ran or that the network was healthy.' : 'No observations are available for this window.'}</p> : <>
                <div className={styles.metrics}>{summary.totals.map(item => <div key={item.key}><p className="flex gap-2 items-center text-caption text-muted"><span className="w-1.5 h-1.5 inline-block" style={{ backgroundColor: colors[item.color as keyof typeof colors] }} />{item.label}</p><p className="mt-2 font-mono text-lg tabular-nums text-primary">{formatValue(item.value, evidence.unit)}{evidence.unit === '%' ? '%' : ''}</p><p className="mt-1 text-caption text-muted">{spec.metric === 'migration_share' ? item.change === null ? 'Change unavailable' : `${formatValue(item.change, '%', true)} percentage points` : spec.metric === 'balances' ? item.change === null ? 'Change unavailable' : `${formatValue(item.change, evidence.unit, true)} ZEC change` : `${evidence.unit} ${ranking ? 'across ranked chains' : 'in returned days'}`}</p></div>)}</div>
                {spec.view === 'table' ? <div className="overflow-x-auto"><table className={styles.table}><caption className="sr-only">{ranking ? 'Chain rankings' : 'Daily observations'} in {evidence.unit}; displayed ZEC rounded to two decimal places. CSV uses {evidence.csvUnit}; USD valuations are approximate.</caption><thead><tr><th>{ranking ? 'Chain' : 'Date (UTC)'}</th>{evidence.series.map(series => <th key={series.key}>{series.label} ({evidence.unit})</th>)}</tr></thead><tbody>{summary.points.slice(tablePage * 15, (tablePage + 1) * 15).map(point => <tr key={point.date}><th>{ranking ? formatChain(point.date) : point.date}</th>{evidence.series.map(series => <td key={series.key}>{formatValue(point.values[series.key], evidence.unit)}</td>)}</tr>)}</tbody></table><div className="flex justify-between gap-3 py-4 text-caption text-muted"><button disabled={tablePage === 0} onClick={() => setTablePage(value => value - 1)} className="disabled:opacity-40">← Previous</button><span>Page {tablePage + 1} of {Math.ceil(summary.points.length / 15)}</span><button disabled={(tablePage + 1) * 15 >= summary.points.length} onClick={() => setTablePage(value => value + 1)} className="disabled:opacity-40">Next →</button></div></div> : <AskChart points={summary.points} evidence={evidence} view={spec.view} />}
                <div className="flex justify-between gap-3 text-caption font-mono text-muted pt-2"><span>{ranking ? 'Rolling past 30 days' : `${summary.start} — ${summary.end} UTC`}</span><span>zecblock.com</span></div>

              </>}
              <p className="mt-4 text-caption text-muted">{evidence.meta.freshness?.status === 'stale' ? <span role="status" className="text-warning">Source marked stale · </span> : null}{ranking ? `Retrieved ${new Date(evidence.receivedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : `Observations through ${summary.end} UTC`}</p>
              <details className={research.disclosure}><summary>Sources &amp; details</summary><div className={research.provenance}>
                <dl className={research.provRows}>
                  <div><dt>Data</dt><dd><Link href={evidence.source}>{evidence.sourceLabel} · Indexed public data</Link> <span className={research.inlineCopy}><CopyButton text={`https://zecblock.com${evidence.source}`} label="source link" className={research.copyButton} /></span></dd></div>
                  {sources ? <div><dt>Guide</dt><dd>{sources}</dd></div> : null}
                  <div><dt>Retrieved</dt><dd>{evidence.receivedAt.replace('T', ' ').slice(0, 19)} UTC{evidence.meta.source?.observedAt ? ` · Source observed ${evidence.meta.source.observedAt}` : ''}</dd></div>
                  <div><dt>Coverage</dt><dd>{ranking ? `${summary.points.length} chains ranked by tracked swap volume. The bar chart shows the top 10; the table and CSV include every chain.` : spec.metric === 'migration_share' ? `Latest observed share ${summary.end}. Percentages compare pool balances on each returned day.` : spec.metric === 'balances' ? `${summary.points.length} daily snapshots. Headline balances are from ${summary.end}; changes compare the first and last observations.` : `${summary.points.length} daily buckets. Boundary days may be partial; absent days are not assumed to be zero.`}</dd></div>
                  {evidence.note ? <div><dt>Notes</dt><dd>{evidence.note}</dd></div> : null}
                  <div><dt>Units</dt><dd>CSV exports use {evidence.csvUnit}. ZEC values retain exact zatoshis; USD valuations are approximate.</dd></div>
                </dl>
              </div></details>
            </> : null}
  </div>;
  const explanation = canExplain ? <button onClick={() => { dialog.current?.close(); onExplain(); }} disabled={busy || loadingData || !summary?.points.length || invalidDates} className={styles.explainAction}>{changed || refresh > 0 ? 'Explain updated view' : 'Explain this view'}</button> : null;
  // One action row, styled like the SQL result toolbar (no hidden "More").
  const actions = (includeExpand = false) => <div className={styles.chartActions}>
    {!changed && refresh === 0 ? explanation : null}
    <button className={styles.toolButton} onClick={() => setRefresh(value => value + 1)} disabled={loadingData || busy}>Refresh data</button>
    <button className={styles.toolButton} onClick={exportCsv} disabled={!summary?.points.length || invalidDates}>Export CSV</button>
    {includeExpand ? <button className={styles.toolButton} aria-haspopup="dialog" onClick={() => setExpanded(true)}>Expand results ↗</button> : null}
  </div>;
  return <article className={styles.resultCard} aria-label={`${info.title} results`} aria-busy={loadingData}>
    {actions(true)}
    {!expanded ? <>{changed || refresh > 0 ? <p className="px-5 pt-4 text-caption text-muted">{changed ? 'View updated. The reply above describes the original settings.' : 'Chart refreshed. The reply above uses the observations available when it was written.'}</p> : null}{content}</> : <p className="p-5 text-sm text-muted">Viewing expanded results. <button className="text-cipher-gold" onClick={() => dialog.current?.close()}>Back to conversation</button></p>}
    {changed || refresh > 0 ? <div className="px-5 pb-5">{explanation}</div> : null}
    <dialog ref={dialog} className={styles.resultDialog} aria-labelledby={titleId} onClose={() => setExpanded(false)}>
      {expanded ? <><div className={styles.dialogHeader}><h2 id={titleId}>{info.title}</h2><button autoFocus onClick={() => dialog.current?.close()}>Back to conversation ×</button></div>{actions()}{content}</> : null}
    </dialog>
  </article>;
}
