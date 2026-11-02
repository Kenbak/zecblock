import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody } from '@/components/ui/Card';
import { transformExpressTxData } from '@/app/tx/[txid]/components/transform-tx-data';
import type { TransactionData } from '@/app/tx/[txid]/components/types';
import { TransactionView } from './TransactionView';
import type { PrivateRecord } from './TransactionView';

type Snapshot = { height: number; hash: string; publishedAt: string };
type PublishedRange = { startHeight: number; endHeight: number; transactionCount?: number };
type Manifest = {
  schema?: string;
  publicationId?: string;
  collectionId?: string;
  network?: string;
  snapshot?: Snapshot;
  coverage?: { startHeight: number; endHeight: number; complete?: boolean; ranges?: PublishedRange[]; [key: string]: unknown };
};
type Sample = { txid: string; label?: string; height?: number };
type Measurements = { queryBytes: number; responseBytes: number; encryptMs: number; requestMs: number; decodeMs: number; totalMs: number; [key: string]: number };
const TXID = /^[a-f\d]{64}$/i;

function fullRecord(value: unknown): PrivateRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as PrivateRecord;
  if (record.schema !== 'zecblock-private-tx-record-v1' || record.found !== true || record.network !== 'mainnet'
      || !TXID.test(record.txid) || !record.detail || !record.raw || typeof record.raw.hex !== 'string'
      || !record.raw.decoded || !record.snapshot || !Number.isSafeInteger(record.snapshot.height)
      || typeof record.snapshot.publishedAt !== 'string' || !record.coverage) return null;
  return record;
}

function formatMs(value: number | undefined) { return Number.isFinite(value) ? `${Math.round(value!).toLocaleString()} ms` : '—'; }

export function App() {
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  const publicationRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [txid, setTxid] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Preparing the browser client and public setup.');
  const [stage, setStage] = useState<string | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [publicationWarning, setPublicationWarning] = useState('');
  const [samples, setSamples] = useState<Sample[]>([]);
  const [record, setRecord] = useState<PrivateRecord | null>(null);
  const [transaction, setTransaction] = useState<TransactionData | null>(null);
  const [measurements, setMeasurements] = useState<Measurements | null>(null);

  useEffect(() => {
    const worker = new Worker('/worker.js', { type: 'module' });
    workerRef.current = worker;
    worker.addEventListener('message', ({ data }) => {
      if (data.type === 'ready') {
        setReady(true);
        setManifest(data.manifest ?? null);
        const publication = typeof data.manifest?.publicationId === 'string' ? data.manifest.publicationId : null;
        const changed = publicationRef.current !== null && publication !== null && publicationRef.current !== publication;
        publicationRef.current = publication;
        if (changed) {
          setRecord(null);
          setTransaction(null);
          setMeasurements(null);
          setError('');
        }
        const catalogue = data.samples ?? data.catalogue ?? data.manifest?.catalogue ?? [];
        setSamples(Array.isArray(catalogue) ? catalogue.filter((sample: Sample | null) => sample !== null && typeof sample === 'object' && typeof sample.txid === 'string' && TXID.test(sample.txid)) : []);
        setStatus(changed ? 'The publication changed. Previous results were cleared; enter a transaction from the new coverage.' : 'Ready. The selected transaction ID stays in your browser.');
        return;
      }
      if (data.type === 'publication-warning') {
        setPublicationWarning(typeof data.message === 'string' ? data.message : '');
        return;
      }
      if (data.requestId !== undefined && data.requestId !== requestRef.current) return;
      if (data.type === 'stage') {
        setStage(data.stage);
        const part = Number.isSafeInteger(data.chunk) && Number.isSafeInteger(data.chunks) ? ` (${data.chunk} of ${data.chunks})` : '';
        setStatus(data.stage === 'server' ? `Retrieving the encrypted record from the PIR service${part}.` : data.stage === 'decode' ? `Decoding and checking the record in this browser${part}.` : 'Preparing the private lookup in this browser.');
      } else if (data.type === 'result') {
        const decoded = fullRecord(data.result?.record ?? data.result);
        setBusy(false);
        setStage(null);
        if (!decoded) {
          setError('The private response is not a supported full transaction record. No public API lookup was attempted.');
          setStatus('Stopped safely.');
          return;
        }
        let transformed: TransactionData;
        try {
          // API BIGINTs are decimal strings. Normalize the bounded block
          // height for the existing presentation components while retaining
          // the exact original detail/raw objects in the decrypted record.
          const rawHeight = decoded.detail.blockHeight;
          const blockHeight = typeof rawHeight === 'number' ? rawHeight
            : typeof rawHeight === 'string' && /^(0|[1-9]\d*)$/.test(rawHeight) ? Number(rawHeight) : NaN;
          if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) throw new Error('Invalid snapshot block height');
          transformed = transformExpressTxData({ ...decoded.detail, blockHeight });
        } catch {
          setError('The decoded transaction metadata could not be rendered safely. No public API lookup was attempted.');
          setStatus('Stopped safely.');
          return;
        }
        if (transformed.txid !== decoded.txid || !Number.isFinite(transformed.blockHeight) || !Number.isFinite(transformed.timestamp)
            || !Array.isArray(transformed.inputs) || !Array.isArray(transformed.outputs)) {
          setError('The decoded record is inconsistent with its transaction metadata. No public API lookup was attempted.');
          setStatus('Stopped safely.');
          return;
        }
        setRecord(decoded);
        setTransaction(transformed);
        setMeasurements(data.measurements);
        setStatus('Lookup complete. Transaction data was decoded locally.');
      } else if (data.type === 'error') {
        setBusy(false);
        setStage(null);
        setRecord(null);
        setTransaction(null);
        setError(typeof data.message === 'string' ? data.message : 'The private lookup could not complete. No public lookup was attempted.');
        setStatus('Stopped safely. No ordinary transaction lookup was attempted.');
      }
    });
    worker.addEventListener('error', event => {
      event.preventDefault();
      setReady(false);
      setBusy(false);
      setRecord(null);
      setTransaction(null);
      setStage(null);
      setError('The browser worker could not continue. Reload this local page to restart it.');
      setStatus('Stopped safely. No ordinary transaction lookup was attempted.');
    });
    worker.postMessage({ type: 'initialize' });
    return () => { workerRef.current = null; worker.terminate(); };
  }, []);

  function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) return;
    setError('');
    const selected = txid.trim().toLowerCase();
    if (!TXID.test(selected)) {
      setRecord(null);
      setTransaction(null);
      setMeasurements(null);
      setError('Enter exactly 64 hexadecimal characters. Validation stays in this browser.');
      return;
    }
    setBusy(true);
    setRecord(null);
    setTransaction(null);
    setMeasurements(null);
    setStage('query');
    setStatus('Preparing the private lookup in this browser.');
    workerRef.current?.postMessage({ type: 'lookup', requestId: ++requestRef.current, txid: selected });
  }

  function clear() {
    if (busy) return;
    setTxid('');
    setRecord(null);
    setTransaction(null);
    setMeasurements(null);
    setError('');
    setStatus('Ready. The selected transaction ID stays in your browser.');
    inputRef.current?.focus();
  }

  const coverage = manifest?.coverage;
  const snapshot = manifest?.snapshot;
  const collection = manifest?.schema === 'zecblock-private-tx-collection-v1';
  const coverageLabel = coverage && (collection
    ? `Published ranges: ${coverage.ranges?.map(range => range.startHeight === range.endHeight
      ? range.startHeight.toLocaleString()
      : `${range.startHeight.toLocaleString()}–${range.endHeight.toLocaleString()}`).join(' · ') || 'unavailable'}`
    : `Blocks ${coverage.startHeight.toLocaleString()}–${coverage.endHeight.toLocaleString()}`);

  return <>
    <header className="private-header"><div className="private-shell private-header-inner"><span className="private-brand">ZecBlock<span>.</span></span><div className="flex items-center gap-2"><Badge color="gold" variant="subtle">PRIVATE</Badge><span className="private-header-local">ISOLATED PILOT</span></div></div></header>
    <main className="private-shell private-main">
      <div className="private-page-heading"><div><p className="text-caption text-muted font-mono uppercase tracking-widest mb-2">EXPLORER / PRIVATE LOOKUP</p><h1>Private transaction explorer</h1><p className="private-intro">Explore a confirmed mainnet publication with browser-side private information retrieval.</p></div><span className={`private-runtime ${ready ? 'ready' : ''}`} id="runtime-status">{ready ? 'Browser client ready' : 'Loading client'}</span></div>

      <section className="private-search" aria-labelledby="lookup-title"><Card><CardBody>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4"><h2 className="text-sm font-medium text-primary" id="lookup-title">Transaction lookup</h2>{coverageLabel && <span className="text-caption text-muted font-mono" id="publication-coverage">{coverageLabel}</span>}</div>
        <form id="lookup-form" onSubmit={lookup} autoComplete="off"><label className="sr-only" htmlFor="txid">Transaction ID</label><div className="private-search-row"><input ref={inputRef} id="txid" name="private-record" value={txid} onChange={event => setTxid(event.target.value)} disabled={busy} type="text" inputMode="text" spellCheck={false} autoCapitalize="off" autoComplete="off" maxLength={64} placeholder="Search a transaction ID in this publication" aria-describedby="input-help" aria-invalid={error && !TXID.test(txid.trim()) ? true : undefined} /><button className="btn btn-primary btn-md" id="lookup-button" type="submit" disabled={!ready || busy}>{busy ? 'Retrieving privately…' : 'Look up privately'}<svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M5 12h14m-5-5 5 5-5 5" /></svg></button></div></form>
        <p className="text-caption text-muted mt-3" id="input-help">Lookup uses this page's pinned publication. The identifier stays in browser memory; no public API fallback.</p>
        {collection && coverage?.complete === false && <p className="text-caption text-muted mt-3" id="coverage-warning">Only the listed ranges are published. Transactions in the gaps are unavailable in this publication.</p>}
        <div className="flex flex-wrap items-center justify-between gap-3 mt-3"><p className="text-caption text-muted">Publication pinned for this page. All encrypted replies arrive before decoding; refresh is manual.</p><button type="button" id="refresh-publication" className="private-clear" disabled={busy} onClick={() => window.location.reload()}>Refresh publication</button></div>
        <div className="private-search-status"><span id="lookup-status" role="status" aria-live="polite">{status}</span>{record && <button type="button" id="clear-button" className="private-clear" onClick={clear}>Clear</button>}</div>
        {error && <p className="private-error" id="lookup-error" role="alert">{error}</p>}
        {busy && <div className="private-query-stages" aria-label="Lookup progress"><span className={stage === 'query' ? 'active' : ''}>Encrypt locally</span><span className={stage === 'server' ? 'active' : ''}>Retrieve privately</span><span className={stage === 'decode' ? 'active' : ''}>Decode locally</span></div>}
        {samples.length > 0 && !record && !busy && <div id="sample-area" className="private-samples"><span className="private-sample-label">PUBLIC CATALOGUE</span><div id="samples" className="flex flex-wrap gap-2">{samples.slice(0, 8).map(sample => <button key={sample.txid} type="button" className="private-sample" onClick={() => { setTxid(sample.txid); setError(''); inputRef.current?.focus(); }} title={sample.txid}>{sample.txid.slice(0, 8)}…{sample.txid.slice(-6)}{sample.height ? <span>#{sample.height.toLocaleString()}</span> : null}</button>)}</div><p>Every browser receives the same catalogue. Only the encrypted query depends on your selection.</p></div>}
      </CardBody></Card></section>

      {publicationWarning && <p className="private-publication-warning" id="publication-warning" role="status" aria-live="polite">{publicationWarning} Displayed records remain tied to their captured snapshot.</p>}
      {collection && <p className="text-caption text-muted mb-4" id="collection-snapshot-warning">{snapshot ? 'The collection head is the newest segment snapshot. Older segments retain their captured observations; each result shows its own snapshot.' : 'The collection snapshot is unavailable.'} Current confirmation counts and spent status are unavailable.</p>}
      {snapshot && !record && <div className="private-publication"><span>{collection ? 'Collection head snapshot' : 'Publication snapshot'}</span><span>Block {snapshot.height.toLocaleString()}</span><span>{new Date(snapshot.publishedAt).toLocaleString(undefined, { timeZoneName: 'short' })}</span></div>}
      {record && transaction && <TransactionView key={`${record.publicationId}:${record.txid}`} record={record} data={transaction} />}
      {measurements && <details className="private-measurements" id="metrics"><summary>Private retrieval measurements · {formatMs(measurements.totalMs)}</summary><dl>{[['Encrypted upload', `${measurements.queryBytes.toLocaleString()} bytes`], ['Encrypted download', `${measurements.responseBytes.toLocaleString()} bytes`], ['Browser encryption', formatMs(measurements.encryptMs)], ['PIR service', formatMs(measurements.requestMs)], ['Browser decoding', formatMs(measurements.decodeMs)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>}

      <aside className="private-footer-note"><p><strong>Isolated pilot.</strong> Coverage is limited to this page's pinned publication. Complete fixed-size request batches are dispatched before replies are decoded. This does not provide live mempool or full-history search. Connection operators can still observe IP, timing and sizes.</p><p>Your browser trusts the delivered client code. Public blockchain data and bundled enrichments remain publisher-supplied facts, not a cryptographic proof of completeness.</p></aside>
    </main>
  </>;
}
