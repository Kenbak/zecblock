'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {defaultResearchChart,fitResearchChart,shortLabel,supportsLine,cellLink,dateFormatter,chartValues} from '@/lib/ask/research-display';
import type { ResearchChart, ResearchHighlight, ResearchDocument, ResearchLibrary, ResearchResult, ResearchNarrative } from '@/lib/ask/research-contract';
import { chartSchema, researchDocumentSchema, researchNarrativeSchema } from '@/lib/ask/research-contract';
import { emptyLibrary, readLibrary, writeLibrary, readPortable, mergePortable, markdownReport, csvReport, MAX_BYTES } from '@/lib/ask/research-library';
import { queryShare, dashboardShare, compactResearchLink, sharedLibrary, type ResearchShare } from '@/lib/ask/research-share';
import styles from './research.module.css';
import { CopyButton } from '../../lib/ask/copy-button';
import askStyles from './ask.module.css';
import {catalogueFor} from '../../lib/ask/research-catalogue';
import {displaySQL} from '../../lib/ask/sql-display';

const Plot = dynamic(() => import('./ResearchPlot'), { loading: () => <p className={styles.caption}>Loading chart…</p> });
const initialSQL = 'SELECT height, transactions, bytes, fees::numeric / 100000000 AS fees_zec\nFROM blocks\nORDER BY height DESC\nLIMIT 10';
function download(name: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exactDisplay(cell: string | null, type: string) {
  if (cell === null) return 'Unavailable';
  if (type !== 'number' || !/^[-+]?\d+(?:\.\d+)?$/.test(cell)) return cell;
  const [whole, fraction] = cell.split('.'); const tail = fraction?.replace(/0+$/, '');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (tail ? '.' + tail : '');
}
function utcDate(value: string) { return new Date(value).toLocaleString(undefined, { timeZone: 'UTC' }) + ' UTC'; }

function matchingNarrative(value: ResearchNarrative | undefined | null, result?: ResearchResult | null) {
  const parsed = researchNarrativeSchema.safeParse(value);
  return parsed.success && result && parsed.data.fingerprint === result.fingerprint ? parsed.data : null;
}

export function useResearchTools(initial?: ResearchResult, initialTitle = 'My Zcash analysis', initialNarrative?: ResearchNarrative) {
  const [library, setLibrary] = useState<ResearchLibrary>(emptyLibrary);
  // Several edits can happen in one handler (save, then add to a dashboard);
  // each reads the latest written library, not the render's copy.
  const libraryRef = useRef<ResearchLibrary>(library);
  const [ready, setReady] = useState(false);
  const raw = useRef<string | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [title, setTitle] = useState(initialTitle.slice(0, 120));
  const [notes, setNotes] = useState('');
  const [sql, setSQL] = useState(initial?.query.sql || initialSQL);
  const [limit, setLimit] = useState(initial?.query.limit || 100);
  const [result, setResult] = useState<ResearchResult | null>(initial || null);
  const resultRef = useRef<ResearchResult | null>(initial || null);
  const [narrative, setNarrative] = useState<ResearchNarrative | null>(() => matchingNarrative(initialNarrative, initial));
  const narrativeRef = useRef<ResearchNarrative | null>(narrative);
  const [chart, setChart] = useState<ResearchChart>(()=>defaultResearchChart(initial));
  const [boardId, setBoardId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [shareURL, setShareURL] = useState('');
  useEffect(() => {
    try { const loaded = readLibrary(window.localStorage); raw.current = loaded.raw; libraryRef.current = loaded.library; setLibrary(loaded.library); setReady(true); }
    catch { setError('Browser storage is unavailable or contains an invalid library. Existing saves have been preserved.'); }
  }, []);
  function persist(next: ResearchLibrary) { raw.current = writeLibrary(window.localStorage, next, raw.current); libraryRef.current = next; setLibrary(next); }
  // The chart Zift chose last; a later suggestion replaces it only while the
  // person has not changed it.
  const autoChart = useRef<string | null>(null);
  const chartRef = useRef(chart); chartRef.current = chart;
  function accept(data: ResearchResult, label: string, fresh = true, context?: ResearchNarrative, suggested?: ResearchChart) {
    resultRef.current = data;
    const nextNarrative = matchingNarrative(context, data);
    narrativeRef.current = nextNarrative; setNarrative(nextNarrative);
    setResult(data); setSQL(data.query.sql); setLimit(data.query.limit); setTitle(label.slice(0, 120)); setBoardId(null); setError(''); setNotice(''); setShareURL('');
    const next = suggested || defaultResearchChart(data);
    autoChart.current = suggested ? JSON.stringify(next) : null;
    setChart(next);
    if (fresh) { setId(null); setNotes(''); }
  }
  function suggest(proposal: unknown) {
    const parsed = chartSchema.safeParse(proposal);
    const next = parsed.success ? fitResearchChart(resultRef.current, parsed.data) : null;
    if (!next) return;
    if (autoChart.current !== JSON.stringify(chartRef.current)) return;
    autoChart.current = JSON.stringify(next); setChart(next);
  }
  function annotate(context: ResearchNarrative) {
    const next = matchingNarrative(context, resultRef.current);
    if (!next) return false;
    narrativeRef.current = next; setNarrative(next);
    return true;
  }
  function open(doc: ResearchDocument, shared = false) {
    resultRef.current = doc.result;
    const nextNarrative = matchingNarrative(doc.narrative, doc.result);
    narrativeRef.current = nextNarrative; setNarrative(nextNarrative);
    setId(doc.id); setTitle(doc.title); setNotes(doc.notes); setSQL(doc.query.sql); setLimit(doc.query.limit); setChart(doc.chart); setResult(doc.result); setBoardId(null); setError('');
    setShareURL(''); setNotice(shared ? 'Shared SQL is an unverified draft. Review it before running.' : '');
  }
  function reset() { resultRef.current = null; narrativeRef.current = null; setNarrative(null); setId(null); setResult(null); setNotes(''); setTitle('My Zcash analysis'); setSQL(initialSQL); setLimit(100); setBoardId(null); setError(''); setNotice(''); setShareURL(''); }
  function document(): ResearchDocument {
    const snapshot = resultRef.current;
    const current = snapshot?.query.sql === sql && snapshot.query.limit === limit ? snapshot : null;
    const context = matchingNarrative(narrativeRef.current, current);
    return researchDocumentSchema.parse({ format: 'zecblock-research', version: 2, id: id || crypto.randomUUID(), title, notes, query: { version: 3, sql, limit }, chart, result: current, ...(context ? { narrative: context } : {}), savedAt: new Date().toISOString() });
  }
  // Unsaved work: no save yet, or the title, notes, query, chart or result
  // snapshot differ from the saved copy.
  const savedDoc = id ? library.documents.find(d => d.id === id) : undefined;
  const snapshotFingerprint = result && result.query.sql === sql && result.query.limit === limit ? result.fingerprint : null;
  const dirty = !savedDoc || savedDoc.title !== title || savedDoc.notes !== notes || savedDoc.query.sql !== sql || savedDoc.query.limit !== limit || JSON.stringify(savedDoc.chart) !== JSON.stringify(chart) || (savedDoc.result?.fingerprint ?? null) !== snapshotFingerprint;
  function save(quiet = false): string | null {
    try { const doc = document(), lib = libraryRef.current; persist({ ...lib, documents: [...lib.documents.filter(d => d.id !== doc.id), doc] }); setId(doc.id); if (!quiet) setNotice('Saved in this browser.'); setError(''); return doc.id; }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save this analysis.'); return null; }
  }
  // Dashboards hold saved analyses, so adding one saves it first.
  function ensureSaved() { return id && !dirty ? id : save(true); }
  function update(change: (lib: ResearchLibrary) => ResearchLibrary, message: string, failure: string) {
    try { persist(change(libraryRef.current)); setNotice(message); setError(''); return true; }
    catch (problem) { setError(problem instanceof Error && /tab|2 MB/.test(problem.message) ? problem.message : failure); return false; }
  }
  const cleanTitle = (value: string) => value.trim().slice(0, 120);
  function renameDocument(docId: string, value: string) {
    const next = cleanTitle(value); if (!next) return false;
    const ok = update(lib => ({ ...lib, documents: lib.documents.map(d => d.id === docId ? { ...d, title: next } : d) }), 'Renamed.', 'Could not rename this analysis.');
    if (ok && docId === id) setTitle(next);
    return ok;
  }
  function updateNotes(docId: string, value: string) {
    const ok = update(lib => ({ ...lib, documents: lib.documents.map(d => d.id === docId ? { ...d, notes: value.slice(0, 4000) } : d) }), 'Notes saved.', 'Could not save these notes.');
    if (ok && docId === id) setNotes(value.slice(0, 4000));
  }
  function removeDocument(docId: string) {
    const doc = libraryRef.current.documents.find(d => d.id === docId);
    if (!doc || !window.confirm(`Remove “${doc.title}” from this browser? It is also removed from any dashboard.`)) return;
    if (update(lib => ({ ...lib, documents: lib.documents.filter(d => d.id !== docId), dashboards: lib.dashboards.map(d => ({ ...d, items: d.items.filter(item => item !== docId) })) }), `Removed “${doc.title}”.`, 'Could not remove this saved analysis.') && docId === id) setId(null);
  }
  // Both return the saved analysis id, or null when nothing changed.
  function toggleDashboard(board: string): string | null {
    const target = libraryRef.current.dashboards.find(d => d.id === board);
    if (!target) return null;
    if (id && target.items.includes(id)) return update(lib => ({ ...lib, dashboards: lib.dashboards.map(d => d.id === board ? { ...d, items: d.items.filter(item => item !== id) } : d) }), `Removed from “${target.title}”.`, 'Could not update the dashboard.') ? id : null;
    const docId = ensureSaved(); if (!docId) return null;
    return update(lib => ({ ...lib, dashboards: lib.dashboards.map(d => d.id === board ? { ...d, items: [...new Set([...d.items, docId])] } : d) }), `Added to “${target.title}”.`, 'A dashboard holds up to 12 analyses.') ? docId : null;
  }
  function createDashboard(value: string): string | null {
    const name = cleanTitle(value); if (!name) return null;
    const docId = ensureSaved(); if (!docId) return null;
    return update(lib => ({ ...lib, dashboards: [...lib.dashboards, { id: crypto.randomUUID(), title: name, items: [docId] }] }), `Created “${name}” with this analysis.`, 'The browser library holds up to 12 dashboards.') ? docId : null;
  }
  function renameDashboard(board: string, value: string) {
    const name = cleanTitle(value); if (!name) return false;
    return update(lib => ({ ...lib, dashboards: lib.dashboards.map(d => d.id === board ? { ...d, title: name } : d) }), 'Renamed.', 'Could not rename this dashboard.');
  }
  function removeFromDashboard(board: string, docId: string) {
    update(lib => ({ ...lib, dashboards: lib.dashboards.map(d => d.id === board ? { ...d, items: d.items.filter(item => item !== docId) } : d) }), 'Removed from this dashboard. The analysis is still saved.', 'Could not update the dashboard.');
  }
  function deleteDashboard(board: string) {
    const target = libraryRef.current.dashboards.find(d => d.id === board);
    if (!target || !window.confirm(`Delete the dashboard “${target.title}”? Its saved analyses stay in your library.`)) return;
    if (update(lib => ({ ...lib, dashboards: lib.dashboards.filter(d => d.id !== board) }), `Deleted “${target.title}”.`, 'Could not delete this dashboard.') && boardId === board) setBoardId(null);
  }
  // A dashboard refresh stores a new result for the same saved SQL. The chart
  // is kept when its columns still exist; an explanation of the old data is dropped.
  function refreshDocument(docId: string, data: ResearchResult) {
    const lib = libraryRef.current, doc = lib.documents.find(d => d.id === docId);
    if (!doc || data.query.sql !== doc.query.sql || data.query.limit !== doc.query.limit) return false;
    const fits = (i: number) => i < data.columns.length;
    const chart = fits(doc.chart.x) && fits(doc.chart.y) && (doc.chart.series || []).every(fits) ? doc.chart : defaultResearchChart(data);
    const { narrative, ...rest } = doc;
    try {
      const next = researchDocumentSchema.parse({ ...rest, chart, result: data, ...(narrative && narrative.fingerprint === data.fingerprint ? { narrative } : {}), savedAt: new Date().toISOString() });
      persist({ ...lib, documents: lib.documents.map(d => d.id === docId ? next : d) });
      return true;
    } catch { return false; }
  }
  async function importFile(file: File | undefined) {
    if (!file) return;
    setImporting(true); const previous = raw.current;
    try { if (file.size > MAX_BYTES) throw Error('Too large'); const incoming = readPortable(await file.text()); const next = mergePortable(libraryRef.current, incoming, () => crypto.randomUUID()); raw.current = writeLibrary(window.localStorage, next, previous); libraryRef.current = next; setLibrary(next); setNotice('Imported saved analyses. Open one and run its query to refresh the data.'); setError(''); }
    catch { setError('Use a ZecBlock research JSON file under 2 MB. The browser library holds up to 25 analyses and 12 dashboards.'); }
    finally { setImporting(false); }
  }
  function exportFile(report: boolean) {
    try { const doc = document(); download(report ? 'zecblock-research.md' : 'zecblock-research.json', report ? markdownReport(doc) : JSON.stringify(doc, null, 2), report ? 'text/markdown' : 'application/json'); setError(''); }
    catch { setError('Give this analysis a title and valid SQL before downloading.'); }
  }
  function exportCSV() {
    try { download('zecblock-results.csv', csvReport(document()), 'text/csv;charset=utf-8'); setError(''); }
    catch { setError('Run this query before downloading its results as CSV.'); }
  }
  async function copyLink(board = false) {
    try {
      const share = board && boardId ? dashboardShare(library, boardId) : queryShare(document());
      const url = await compactResearchLink(share, window.location.origin); setShareURL(url); setError('');
      try { await navigator.clipboard.writeText(url); setNotice(board ? 'Dashboard draft link copied.' : 'Query draft link copied.'); }
      catch { setNotice('Link ready. Copy it from the field below.'); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not create this research link.'); }
  }
  function saveShared(share: ResearchShare) {
    try {
      const incoming = sharedLibrary(share, () => crypto.randomUUID(), new Date().toISOString());
      const next = mergePortable(libraryRef.current, incoming, () => crypto.randomUUID()); persist(next);
      setNotice('Shared queries saved in this browser. Review each query before running; no SQL has run.'); setError('');
      if (share.kind === 'dashboard') setBoardId(next.dashboards.at(-1)!.id);
      return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save this shared research.'); return false; }
  }
  // Opening or closing a dashboard starts with no leftover action message.
  function showDashboard(board: string | null) { setBoardId(board); setNotice(''); setError(''); setShareURL(''); }
  return { library, ready, id, title, setTitle, notes, setNotes, sql, setSQL, limit, setLimit, result, narrative, chart, setChart, suggest, boardId, setBoardId: showDashboard, notice, error, importing, shareURL, dirty, copyLink, saveShared, accept, annotate, open, reset, document, save, importFile, exportFile, exportCSV, renameDocument, updateNotes, removeDocument, toggleDashboard, createDashboard, renameDashboard, removeFromDashboard, deleteDashboard, refreshDocument, downloadLibrary: () => download('zecblock-library.json', JSON.stringify(libraryRef.current, null, 2), 'application/json') };
}
type Tools = ReturnType<typeof useResearchTools>;

// A small dropdown anchored to its button. It closes on an outside click,
// Escape, or when an action inside asks it to.
function useDismiss() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const menu = ref.current;
      if (!menu?.open) return;
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, []);
  return ref;
}
function Menu({ label, children, className = '', align = 'right', disabled = false, ariaLabel }: { label: ReactNode; children: ReactNode; className?: string; align?: 'left' | 'right'; disabled?: boolean; ariaLabel?: string }) {
  const ref = useDismiss();
  return <details ref={ref} className={`${styles.menu} ${className}`} data-align={align}>
    <summary aria-label={ariaLabel} aria-disabled={disabled || undefined} onClick={event => { if (disabled) event.preventDefault(); }}>{label}</summary>
    <div className={styles.menuBody} onClick={event => { if ((event.target as HTMLElement).closest('[data-close]')) ref.current?.removeAttribute('open'); }}>{children}</div>
  </details>;
}
// Inline rename: Enter or leaving the field saves, Escape cancels.
function RenameField({ value, label, onDone, id, autoFocus = true }: { value: string; label: string; onDone: (next: string | null) => void; id?: string; autoFocus?: boolean }) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const finish = (next: string | null) => { if (done.current) return; done.current = true; onDone(next); };
  // Outside a one-shot rename (a field kept in a menu), it stays reusable.
  const finishOnce = autoFocus ? finish : (next: string | null) => onDone(next);
  return <input id={id} autoFocus={autoFocus} aria-label={label} className={`${styles.input} ${styles.renameInput}`} maxLength={120} value={text} onChange={event => setText(event.target.value)} onFocus={event => event.currentTarget.select()} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); finishOnce(text); } if (event.key === 'Escape') { setText(value); finishOnce(null); } }} onBlur={() => finishOnce(text)} />;
}
function LibraryRow({ title, selected, disabled, kind, onOpen, onRename, onRemove }: { title: string; selected: boolean; disabled: boolean; kind: 'analysis' | 'dashboard'; onOpen: () => void; onRename: (next: string) => boolean; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <div className={styles.libraryRow}><RenameField value={title} label={`Rename ${kind}`} onDone={next => { if (next !== null && next.trim() && next.trim() !== title) onRename(next); setEditing(false); }} /></div>;
  return <div className={`${styles.libraryRow} ${selected ? styles.libraryRowSelected : ''}`}>
    <button className={`${askStyles.session} ${selected ? askStyles.selectedSession : ''}`} disabled={disabled} onClick={onOpen} title={title} aria-current={selected ? 'true' : undefined}>{title}</button>
    <Menu className={styles.rowMenu} label={<span aria-hidden="true">⋯</span>} ariaLabel={`Options for ${title}`} disabled={disabled}>
      <button type="button" data-close onClick={() => setEditing(true)}>Rename</button>
      <button type="button" data-close data-tone="danger" onClick={onRemove}>{kind === 'dashboard' ? 'Delete dashboard' : 'Remove from saved'}</button>
    </Menu>
  </div>;
}

// compact: inside the Ask sidebar, which supplies its own "Saved" heading.
export function ResearchLibrary({ tools, busy, onOpen, compact = false }: { tools: Tools; busy: boolean; onOpen: (doc: ResearchDocument) => void; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const disabled = busy || tools.importing;
  return <div className={`${styles.libraryContent} ${compact ? styles.libraryCompact : ''}`}>
    {compact ? null : <p className={styles.eyebrow}>SAVED ANALYSES</p>}
    {tools.library.documents.length ? tools.library.documents.map(doc => <LibraryRow key={doc.id} kind="analysis" title={doc.title} selected={tools.id === doc.id && !tools.boardId} disabled={disabled} onOpen={() => onOpen(doc)} onRename={next => tools.renameDocument(doc.id, next)} onRemove={() => tools.removeDocument(doc.id)} />) : <p className={styles.caption}>Save an analysis to keep exploring later.</p>}
    {tools.library.dashboards.length ? <><p className={styles.eyebrow}>DASHBOARDS</p>{tools.library.dashboards.map(board => <LibraryRow key={board.id} kind="dashboard" title={board.title} selected={tools.boardId === board.id} disabled={disabled} onOpen={() => tools.setBoardId(board.id)} onRename={next => tools.renameDashboard(board.id, next)} onRemove={() => tools.deleteDashboard(board.id)} />)}</> : null}
    <div className={styles.libraryActions}><button className={styles.textButton} disabled={!tools.ready || disabled} onClick={() => input.current?.click()} aria-label="Import research file">↑ Import</button><button className={styles.textButton} disabled={disabled || !tools.library.documents.length} onClick={tools.downloadLibrary} aria-label="Download all saved research">↓ Export all</button></div>
    {tools.error || tools.notice.startsWith('Imported') ? <ResearchStatus tools={tools} /> : null}
    <input type="file" ref={input} className="sr-only" tabIndex={-1} accept=".json,application/json" aria-label="Import research file" onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; void tools.importFile(selected); }} />
  </div>;
}

export function ResearchEditor({ tools, extended=false }: { extended?:boolean; tools: Tools; busy: boolean; onOpen: (doc: ResearchDocument) => void }) {
  return <details className={styles.disclosure}>
    <summary>Data catalogue</summary>
    <div className={styles.advanced}>
      <p className={styles.caption}>Use SQL mode in the composer to write a query or edit the query behind your analysis.</p>
      <details className={styles.catalogue}><summary>Browse available data</summary>
        {catalogueFor(extended).map(dataset=><div key={dataset.id}><h3 className={styles.dataset}>{dataset.title}</h3><p className={styles.caption}>{dataset.description}</p><pre className={styles.schema} translate="no">{dataset.id+'('+dataset.columns+')'}</pre></div>)}
        {extended?<p className={styles.caption}>Added datasets are checked for copy and refresh readiness on each query. An unfinished or stale source returns an error, never an empty history. Daily summaries cover completed UTC days.</p>:null}
        <p className={styles.caption}>{extended ? 'Dates are UTC. Block, transaction and address timestamps use Unix seconds; swap timestamps are date/time values. Swap valuations use USD. ' : 'Timestamps: Unix seconds, UTC. '}Amounts/fees: zatoshis; divide by 100000000 for ZEC. Join transactions.height to blocks.height, flows.txid to transactions.txid. Aggregate flows before joining to avoid double counting. Blocks include coinbase. Missing measures remain unavailable. Flow-history completeness is unverified.</p>
      </details>
      <ResearchStatus tools={tools} />
    </div>
  </details>;
}
// except: notices already shown where the action happened (the dashboard menu).
export function ResearchStatus({ tools, except }: { tools: Tools; except?: RegExp }) { return <>{tools.error ? <p className={styles.error} role="alert">{tools.error}</p> : null}{tools.notice && !except?.test(tools.notice) ? <p className={styles.caption} role="status">{tools.notice}</p> : null}</>; }

export function ResearchData({ result, chart, sources, showDetails = true, savedSnapshot = false, settings }: { result: ResearchResult; chart: ResearchChart; sources?: ReactNode; showDetails?: boolean; savedSnapshot?: boolean; settings?: ReactNode }) {
  const dates = result.columns.map((_, i) => dateFormatter(result, i));
  const rowCount = `${result.rows.length} ${result.rows.length === 1 ? 'row' : 'rows'}${result.truncated ? ' (limited)' : ''}`;
  const text = (cell: string | null, i: number) => cell !== null && dates[i] ? dates[i]!(cell) : cell && /^(?:txid|hash|miner|address)$/.test(result.columns[i].label.toLowerCase()) ? shortLabel(cell) : exactDisplay(cell, result.columns[i].type);
  const table = <div className={styles.scroll} tabIndex={0} role="region" aria-label="Scrollable query results"><table className={styles.table}><caption className="sr-only">Query results, preserving exact decimals</caption><thead><tr>{result.columns.map(column => <th key={column.key} scope="col" data-numeric={column.type === 'number'}>{column.label.replaceAll('_', ' ')}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index}>{row.map((cell, i) => <td key={i} data-numeric={result.columns[i].type === 'number'}>{cellLink(result.columns[i].label.toLowerCase(),cell) ? <Link href={cellLink(result.columns[i].label.toLowerCase(),cell)!} title={cell || undefined} aria-label={cell || undefined}>{result.columns[i].type==='number' ? exactDisplay(cell,'number') : shortLabel(cell)}</Link> : <span title={cell || undefined}>{result.columns[i].type==='number' ? exactDisplay(cell,'number') : text(cell, i)}</span>}</td>)}</tr>)}</tbody></table>{!result.rows.length ? <p className={styles.caption}>No matching records were returned.</p> : null}</div>;
  return <>
    {/* Charts carry the row count on View data, keeping the chart header to its value. */}
    {chart.view === 'table' ? <><p className={styles.caption}>{rowCount}</p>{table}</> : <><Plot result={result} chart={chart} />{settings}<details className={styles.exactTable}><summary>View data · {rowCount}</summary>{table}</details></>}
    {showDetails ? <details className={styles.disclosure}><summary>Sources &amp; details</summary><div className={styles.provenance}>
      {savedSnapshot ? <p className={styles.snapshotNote}>Saved snapshot. Run the query to refresh its data.</p> : null}
      <dl className={styles.provRows}>
        <div><dt>Data</dt><dd>Indexed through {utcDate(result.indexedThrough)} · Retrieved {utcDate(result.retrievedAt)}</dd></div>
        {sources ? <div><dt>Guide</dt><dd>{sources}</dd></div> : null}
        <div><dt>Coverage</dt><dd>{result.coverage}</dd></div>
        <div><dt>Units</dt><dd>{result.units}{chart.view !== 'table' ? ' Charts are approximate; the table is exact.' : ''}</dd></div>
        <div><dt>Query fingerprint</dt><dd><span className={styles.fingerprint} title={result.fingerprint}>{result.fingerprint.slice(0, 16)}…</span></dd></div>
      </dl>
      {result.query?.sql ? <details className={styles.sqlDetails}><summary>SQL query</summary><div className={styles.codeBlock}><pre className={styles.shareSQL} translate="no" tabIndex={0} aria-label="SQL behind this result">{displaySQL(result.query.sql)}</pre><span className={styles.codeCopy}><CopyButton text={displaySQL(result.query.sql)} label="SQL" className={styles.copyButton} /></span></div></details> : null}
    </div></details> : null}
  </>;
}

// Toolbar: view switch (with chart columns when charting) on the left; on the
// right the caller's actions (Explain), Edit SQL, Save, Dashboard, Share, then
// trailing (Expand). Each control does one thing.
export function ResearchPanel({ tools, result, busy, titleId, embedded = false, actions, trailing, editAction, sources, saved, onSaved }: { tools: Tools; result: ResearchResult; busy: boolean; titleId?: string; embedded?: boolean; actions?: ReactNode; trailing?: ReactNode; editAction?: ReactNode; sources?: ReactNode; saved?: boolean; onSaved?: (id: string) => void }) {
  const generatedTitleId = useId();
  const analysisTitleId = titleId || generatedTitleId;
  const lineAllowed = supportsLine(result, tools.chart.x);
  const numeric = result.columns.some(column => column.type === 'number');
  const disabled = busy || tools.importing;
  const hasSnapshot = tools.result?.fingerprint === result.fingerprint && tools.sql === result.query?.sql && tools.limit === result.query?.limit;
  const isSaved = Boolean(tools.id) && !tools.dirty;
  const [newBoard, setNewBoard] = useState('');
  const saveNow = () => { const savedId = tools.save(); if (savedId) onSaved?.(savedId); };
  // Every toolbar change is refitted: lines and areas need an ordered axis,
  // and a highlight or stack that no longer fits is dropped.
  const update = (next: ResearchChart) => tools.setChart(next.view === 'table' ? next : fitResearchChart(result, next) || next);
  const columnSelect = (axis: 'x' | 'y') => <label className={styles.inlineField}>{axis === 'x' ? 'Labels' : 'Values'}<span className={styles.selectWrap}><select className={styles.input} disabled={axis === 'y' && !numeric} value={tools.chart[axis]} onChange={event => update({ ...tools.chart, [axis]: Number(event.target.value) })}>{result.columns.map((column, index) => axis === 'y' && column.type !== 'number' ? null : <option key={column.key} value={index}>{column.label.replaceAll('_', ' ')}</option>)}</select></span></label>;
  // Values: one or up to five numeric columns, drawn together; the first stays primary.
  const measures = result.columns.map((column, index) => ({ column, index })).filter(({ column }) => column.type === 'number');
  const chosen = chartValues(result, tools.chart);
  const toggleValue = (index: number) => {
    const next = chosen.includes(index) ? chosen.filter(i => i !== index) : [...chosen, index].sort((a, b) => a - b);
    if (!next.length || next.length > 5) return;
    update({ ...tools.chart, y: next[0], series: next.length > 1 ? next.slice(1) : undefined });
  };
  const valueLabel = (index: number) => result.columns[index].label.replaceAll('_', ' ');
  const valuePicker = measures.length > 1 ? <div className={styles.inlineField}>Values<Menu label={<span className={styles.valueText}>{chosen.map(valueLabel).join(', ') || 'Choose'}</span>} ariaLabel={`Chart values: ${chosen.map(valueLabel).join(', ')}`} align="left">
    <p className={styles.menuHeading}>Draw these columns</p>
    <div className={styles.checkList}>{measures.map(({ column, index }) => <label key={column.key} className={styles.checkRow}><input type="checkbox" checked={chosen.includes(index)} disabled={chosen.includes(index) ? chosen.length === 1 : chosen.length >= 5} onChange={() => toggleValue(index)} /><span>{valueLabel(index)}</span></label>)}</div>
    <p className={styles.menuNote}>Up to five. Very different sizes use a second axis.</p>
  </Menu></div> : columnSelect('y');
  const chartSettings = <div className={styles.chartColumns}>{columnSelect('x')}{valuePicker}
      <label className={styles.inlineField}>Highlight<span className={styles.selectWrap}><select className={styles.input} value={tools.chart.highlight || 'none'} onChange={event => update({ ...tools.chart, highlight: event.target.value === 'none' ? undefined : event.target.value as ResearchHighlight })}>
        <option value="none">None</option>{lineAllowed ? <><option value="latest">Latest</option><option value="change">Change</option></> : null}<option value="peak">Peak</option><option value="low">Low</option>
      </select></span></label>
      {chosen.length > 1 && tools.chart.view !== 'line' ? <label className={styles.checkRow}><input type="checkbox" checked={!!tools.chart.stacked} onChange={event => update({ ...tools.chart, stacked: event.target.checked || undefined })} /><span>Stack</span></label> : null}
    </div>;
  return <div className={`${styles.panelBody} ${embedded ? styles.embeddedPanel : ''}`}>
    {!embedded ? <h2 className={styles.resultTitle}>{tools.title}</h2> : null}
    <div className={`${styles.resultToolbar} ${embedded ? styles.embeddedToolbar : ''}`}>
      <div className={styles.viewSwitch} role="group" aria-label="Result view">{([['table', 'Table', true], ['bar', 'Bar', numeric], ['area', 'Area', lineAllowed], ['line', 'Line', lineAllowed]] as const).map(([view, label, allowed]) => <button type="button" key={view} aria-pressed={tools.chart.view === view} disabled={!allowed} onClick={() => update({ ...tools.chart, view })}>{label}</button>)}</div>
      <div className={styles.resultActions}>
        {actions}
        {editAction}
        {isSaved ? <Menu label={<><span aria-hidden="true">✓ </span>Saved</>} ariaLabel="Saved analysis options">
          <p className={styles.menuHeading}>Saved in this browser</p>
          <label className={styles.field} htmlFor={analysisTitleId}>Name<RenameField id={analysisTitleId} autoFocus={false} key={tools.title} value={tools.title} label="Analysis name" onDone={next => { if (next !== null && next.trim() && next.trim() !== tools.title) tools.renameDocument(tools.id!, next); }} /></label>
          <label className={styles.field}>Notes<textarea id={analysisTitleId + '-notes'} name="notes" autoComplete="off" className={styles.input} maxLength={4000} defaultValue={tools.notes} key={tools.id + tools.notes} rows={3} onBlur={event => { if (event.target.value !== tools.notes) tools.updateNotes(tools.id!, event.target.value); }} placeholder="Optional" /></label>
          <button type="button" data-close data-tone="danger" className={styles.menuItem} onClick={() => tools.removeDocument(tools.id!)}>Remove from saved</button>
        </Menu> : <button className={styles.button} disabled={!tools.ready || disabled} onClick={saveNow}>{tools.id ? 'Save changes' : 'Save'}</button>}
        <Menu label={<><span className={styles.wideOnly}>Add to dashboard</span><span className={styles.narrowOnly}>Dashboard</span></>} ariaLabel="Add to dashboard" disabled={!tools.ready || disabled}>
          <p className={styles.menuHeading}>Dashboards</p>
          {tools.library.dashboards.length ? <div className={styles.checkList}>{tools.library.dashboards.map(board => <label key={board.id} className={styles.checkRow}><input type="checkbox" checked={Boolean(tools.id && board.items.includes(tools.id))} onChange={() => { const savedId = tools.toggleDashboard(board.id); if (savedId) onSaved?.(savedId); }} /><span>{board.title}</span><span className={styles.checkCount}>{board.items.length}</span></label>)}</div> : <p className={styles.caption}>No dashboards yet.</p>}
          <form className={styles.newBoard} onSubmit={event => { event.preventDefault(); const savedId = tools.createDashboard(newBoard); if (savedId) { setNewBoard(''); onSaved?.(savedId); } }}>
            <input aria-label="New dashboard name" className={styles.input} maxLength={120} value={newBoard} onChange={event => setNewBoard(event.target.value)} placeholder="New dashboard name" />
            <button type="submit" className={styles.button} disabled={!newBoard.trim()}>Create</button>
          </form>
          {!tools.id || tools.dirty ? <p className={styles.caption}>Adding also saves this analysis in your library.</p> : null}
          {/^(?:Added to|Removed from|Created)/.test(tools.notice) ? <p className={styles.menuStatus} role="status">{tools.notice}</p> : null}
        </Menu>
        <Menu label="Share">
          <button type="button" data-close className={styles.menuItem} disabled={disabled} onClick={() => void tools.copyLink()}>Copy query link</button>
          <p className={styles.menuNote}>Shares the SQL, name and chart settings, not results. It never runs automatically.</p>
          <p className={styles.menuHeading}>Download</p>
          <button type="button" data-close className={styles.menuItem} disabled={disabled || !hasSnapshot} onClick={tools.exportCSV}>Results as CSV</button>
          <button type="button" data-close className={styles.menuItem} disabled={disabled} onClick={() => tools.exportFile(true)}>Report (Markdown)</button>
          <button type="button" data-close className={styles.menuItem} disabled={disabled} onClick={() => tools.exportFile(false)}>Research file (JSON)</button>
        </Menu>
      </div>
      {trailing ? <div className={styles.resultActions}>{trailing}</div> : null}
    </div>
    <ShareLinkField tools={tools} />
    <ResearchStatus tools={tools} except={/^(?:Added to|Removed from “|Created)/} />
    {/* Chart settings sit under the chart: the value and chart lead, adjustments follow. */}
    <ResearchData result={result} chart={tools.chart} sources={sources} savedSnapshot={saved === true} settings={chartSettings} />
  </div>;
}
export type DashboardRefresh = { run: (docs: ResearchDocument[]) => void; stop: () => void; running: boolean; available: boolean; status: string; challenge?: ReactNode };
export function ResearchDashboard({ tools, busy, onOpen, refresh }: { tools: Tools; busy: boolean; onOpen: (doc: ResearchDocument) => void; refresh?: DashboardRefresh }) {
  const [renaming, setRenaming] = useState(false);
  const board = tools.library.dashboards.find(d => d.id === tools.boardId);
  if (!board) return null;
  const docs = board.items.map(id => tools.library.documents.find(d => d.id === id)).filter((doc): doc is ResearchDocument => Boolean(doc));
  return <section aria-label="Saved dashboard">
    <div className={styles.toolbar}>
      {renaming ? <RenameField value={board.title} label="Dashboard name" onDone={next => { if (next !== null && next.trim() && next.trim() !== board.title) tools.renameDashboard(board.id, next); setRenaming(false); }} /> : <h2 className={styles.resultTitle}>{board.title}</h2>}
      <div className={styles.actions}>
        {refresh?.available && docs.length ? refresh.running ? <button className={styles.button} onClick={refresh.stop}>Stop refresh</button> : <button className={styles.button} disabled={busy} onClick={() => refresh.run(docs)} title={`Runs ${docs.length} saved ${docs.length === 1 ? 'query' : 'queries'} again; each uses one of your SQL runs`}>Refresh all</button> : null}
        <Menu label="Share"><button type="button" data-close className={styles.menuItem} onClick={() => void tools.copyLink(true)}>Copy dashboard link</button><p className={styles.menuNote}>Shares each query, name and chart setting, not results. Nothing runs automatically.</p><button type="button" data-close className={styles.menuItem} onClick={tools.downloadLibrary}>Download all saved research</button></Menu>
        <Menu label="⋯" ariaLabel="Dashboard options" className={styles.iconMenu}><button type="button" data-close className={styles.menuItem} onClick={() => setRenaming(true)}>Rename</button><button type="button" data-close data-tone="danger" className={styles.menuItem} onClick={() => tools.deleteDashboard(board.id)}>Delete dashboard</button></Menu>
        <button className={styles.button} onClick={() => tools.setBoardId(null)}>Close</button>
      </div>
    </div>
    <p className={styles.caption}>{docs.length} {docs.length === 1 ? 'analysis' : 'analyses'} · {refresh?.available ? `Refresh all runs ${docs.length === 1 ? 'its query' : 'each query'} again (one SQL run each)` : 'saved results'}</p>
    {refresh?.status ? <p className={styles.caption} role="status">{refresh.status}</p> : null}
    {refresh?.challenge}
    <ShareLinkField tools={tools} /><ResearchStatus tools={tools} />
    {docs.length ? <div className={styles.dashboard}>{docs.map(doc => <article key={doc.id} className={`${askStyles.analysis} ${styles.dashboardCard}`} data-wide={doc.chart.view === 'table' && (doc.result?.columns.length ?? 0) > 3 ? 'true' : undefined}>
      <div className={styles.panelBody}>
        <div className={styles.cardHeader}><button className={styles.cardTitle} disabled={busy} onClick={() => onOpen(doc)}>{doc.title} <span aria-hidden="true">→</span></button>{refresh?.available && !refresh.running ? <button type="button" className={styles.iconButton} disabled={busy} aria-label={`Refresh ${doc.title}`} title="Run this query again (one SQL run)" onClick={() => refresh.run([doc])}>↻</button> : null}<button type="button" className={styles.iconButton} aria-label={`Remove ${doc.title} from this dashboard`} title="Remove from dashboard" onClick={() => tools.removeFromDashboard(board.id, doc.id)}>×</button></div>
        {doc.result ? <p className={styles.caption}>Data as of {new Date(doc.result.retrievedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p> : null}
        {doc.result ? <ResearchData result={doc.result} chart={doc.chart} savedSnapshot /> : <p className={styles.caption}>{refresh?.available ? 'No results yet. Use ↻ to run this query.' : 'Run this query to add its results.'}</p>}
      </div>
    </article>)}</div> : <p className={styles.emptyBoard}>This dashboard is empty. Open a saved analysis and choose Add to dashboard.</p>}
  </section>;
}

function ShareLinkField({ tools }: { tools: Tools }) {
  return tools.shareURL ? <div className={styles.field}><label htmlFor="research-link">Research link</label><div className={styles.shareRow}><input id="research-link" readOnly name="research-link" type="url" autoComplete="off" spellCheck={false} className={`${styles.input} ${styles.shareInput}`} value={tools.shareURL} onFocus={event => event.currentTarget.select()} /><CopyButton text={tools.shareURL} label="link" className={styles.copyButton} /></div></div> : null;
}
export function SharedResearchDraft({ share, tools, busy, enabled, onOpen, onDismiss }: { share: ResearchShare; tools: Tools; busy: boolean; enabled: boolean; onOpen: (doc: ResearchDocument) => void; onDismiss: () => void }) {
  return <section className={styles.sharedDraft} aria-label="Shared research draft">
    <div className={styles.toolbar}><div><p className={styles.eyebrow}>{share.kind === 'dashboard' ? 'SHARED DASHBOARD' : 'SHARED QUERY'}</p><h2 className={styles.resultTitle}>{share.title}</h2></div><button className={styles.button} onClick={onDismiss}>Dismiss</button></div>
    <p className={styles.caption}>Unverified query drafts · no SQL has run. Review before running. Your existing saves have not changed.</p>
    {share.queries.map((item, index) => <article className={styles.sharedItem} key={index}>
      {share.kind === 'dashboard' ? <h3 className={styles.dataset}>{item.title}</h3> : null}
      <details className={styles.catalogue}><summary>Review SQL</summary><pre className={styles.shareSQL} translate="no" tabIndex={0} aria-label="SQL draft">{item.query.sql}</pre></details>
      <div className={styles.actions}><button className={styles.button} disabled={busy || tools.importing || !enabled} onClick={() => onOpen(sharedLibrary({ ...share, kind: 'query', title: item.title, queries: [item] }, () => crypto.randomUUID(), new Date().toISOString()).documents[0])}>Open query draft</button></div>
    </article>)}
    {!enabled ? <p className={styles.caption}>SQL research is not enabled on this connection. You can still inspect these drafts.</p> : null}
    <div className={styles.actions}><button className={styles.button} disabled={!tools.ready || busy || tools.importing} onClick={() => { if (tools.saveShared(share)) onDismiss(); }}>Save {share.kind === 'dashboard' ? 'dashboard' : 'query'} in this browser</button></div>
    <ResearchStatus tools={tools} />
  </section>;
}
