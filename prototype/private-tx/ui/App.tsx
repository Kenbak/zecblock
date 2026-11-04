import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Card, CardBody } from '@/components/ui/Card';
import { TxLoadingSkeleton } from '@/app/tx/[txid]/components/TxLoadingSkeleton';
import { transformExpressTxData } from '@/app/tx/[txid]/components/transform-tx-data';
import type { TransactionData } from '@/app/tx/[txid]/components/types';
import { TransactionView } from './TransactionView';
import type { PartialView, PrivateRecord } from './TransactionView';

type Manifest = {
  schema?: string;
  publicationId?: string;
  snapshot?: { height: number; hash: string; publishedAt: string };
  sourceSummary?: { recordCount?: number };
};
type Measurements = { totalMs: number; [key: string]: number };
type View =
  | { kind: 'home' }
  | { kind: 'loading'; txid: string }
  | { kind: 'result'; record: PrivateRecord; data: TransactionData; partial: PartialView | null }
  | { kind: 'notfound'; txid: string; height: number | null }
  | { kind: 'error'; message: string };

const TXID = /^[a-f\d]{64}$/i;
const EXAMPLES = [
  { label: 'Large transaction', txid: '84dcfb4394c4420eed9de74444a875d4b8a2576e664d6a7ef9765458e96826d9' },
];

function fullRecord(value: unknown): PrivateRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as PrivateRecord;
  if (record.schema !== 'zecblock-private-tx-record-v1' || record.found !== true || record.network !== 'mainnet'
      || !TXID.test(record.txid) || !record.detail
      || (record.raw !== null && (!record.raw || typeof record.raw.hex !== 'string' || !record.raw.decoded))
      || !record.snapshot || !Number.isSafeInteger(record.snapshot.height)
      || typeof record.snapshot.publishedAt !== 'string' || !record.coverage) return null;
  return record;
}

function toTransaction(record: PrivateRecord): TransactionData | null {
  try {
    // API BIGINTs are decimal strings; the shared components expect a number height.
    const raw = record.detail.blockHeight;
    const blockHeight = typeof raw === 'number' ? raw : typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) return null;
    const data = transformExpressTxData({ ...record.detail, blockHeight });
    if (data.txid !== record.txid || !Number.isFinite(data.timestamp) || !Array.isArray(data.inputs) || !Array.isArray(data.outputs)) return null;
    return data;
  } catch { return null; }
}

function BrandLogo() {
  return <span className="brand-logo" role="img" aria-label="ZecBlock">
    <img className="brand-logo-on-dark" src="/brand/zecblock-logotype.png" alt="ZecBlock" width={422} height={98} />
    <img className="brand-logo-on-light" src="/brand/zecblock-logotype-light.png" alt="ZecBlock" width={422} height={98} />
  </span>;
}

function ThemeToggle() {
  const [light, setLight] = useState(() => document.documentElement.classList.contains('light'));
  function toggle() {
    const next = light ? 'dark' : 'light';
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(next);
    try { localStorage.setItem('theme', next); localStorage.setItem('theme-user-set', '1'); } catch { /* storage blocked */ }
    setLight(!light);
  }
  return <button type="button" onClick={toggle} className="relative p-1.5 rounded-lg theme-toggle-btn hover:opacity-80 transition duration-200 group" aria-label={`Switch to ${light ? 'dark' : 'light'} mode`} title={`Switch to ${light ? 'dark' : 'light'} mode`}>
    <svg className="w-4 h-4 text-muted group-hover:text-primary transition-colors duration-150" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      {light
        ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />}
    </svg>
  </button>;
}

const LockIcon = ({ className = 'w-3.5 h-3.5' }: { className?: string }) => <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 11V7a4 4 0 00-8 0v4m-2 0h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1v-8a1 1 0 011-1z" /></svg>;

function SearchForm({ hero, idSuffix = '', value, onChange, onSubmit, disabled, inputRef }: {
  hero: boolean; idSuffix?: string; value: string; onChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  disabled: boolean; inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const common = {
    ref: inputRef, value, disabled, type: 'text', name: 'private-record', autoComplete: 'off', spellCheck: false, autoCapitalize: 'off', maxLength: 64,
    'aria-label': 'Transaction ID', onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
  } as const;
  if (!hero) return <form onSubmit={onSubmit} className="w-full" autoComplete="off" role="search">
    <div className="relative">
      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-cipher-gold font-mono text-xs">{'>'}</div>
      <input {...common} id={`txid-compact${idSuffix ? `-${idSuffix}` : ''}`} placeholder="Search a transaction privately" className="w-full pl-7 pr-3 py-2 text-xs font-mono search-input" />
    </div>
  </form>;
  return <form id="lookup-form" onSubmit={onSubmit} className="max-w-3xl mr-auto relative z-50" autoComplete="off" role="search">
    <div className="relative">
      <div className="absolute left-4 sm:left-5 top-1/2 -translate-y-1/2 text-cipher-gold font-mono text-lg sm:text-xl font-semibold">{'>'}</div>
      <input {...common} id="txid" placeholder="Search a transaction ID..." className="w-full pl-10 sm:pl-12 pr-14 py-3 sm:py-3.5 text-data sm:text-sm font-mono search-input-hero border rounded-md text-primary placeholder:text-muted transition duration-300 border-cipher-border hover:border-cipher-gold/50 focus:border-cipher-gold focus:outline-none" />
      <button type="submit" id="lookup-button" aria-label="Search privately" disabled={disabled} className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-lg text-primary border border-cipher-border hover:border-cipher-gold/50 hover:bg-cipher-hover transition duration-150 disabled:opacity-50">
        <svg className="w-4 h-4 sm:w-[18px] sm:h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" /></svg>
      </button>
    </div>
  </form>;
}

export function App() {
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editedRef = useRef(false);
  const [query, setQuery] = useState('');
  const [ready, setReady] = useState(false);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [view, setView] = useState<View>({ kind: 'home' });
  const [inputError, setInputError] = useState('');
  const [loadingFull, setLoadingFull] = useState(false);
  const [measurements, setMeasurements] = useState<Measurements | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  function start(txid: string) {
    setView({ kind: 'loading', txid });
    setMeasurements(null);
    workerRef.current?.postMessage({ type: 'lookup', requestId: ++requestRef.current, txid });
    window.scrollTo({ top: 0 });
  }

  useEffect(() => {
    const workerUrl = document.querySelector<HTMLMetaElement>('meta[name="private-worker"]')?.content || '/worker.js';
    const worker = new Worker(workerUrl, { type: 'module' });
    let fragmentHandled = false;
    workerRef.current = worker;
    worker.addEventListener('message', ({ data }) => {
      if (data.type === 'ready') {
        setReady(true);
        setManifest(data.manifest ?? null);
        if (!fragmentHandled) {
          fragmentHandled = true;
          const match = /^#tx=([a-f\d]{64})$/i.exec(window.location.hash);
          // The fragment never reaches a server; drop it from history too.
          if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
          if (match && !editedRef.current) { const txid = match[1].toLowerCase(); setQuery(txid); start(txid); }
        }
        return;
      }
      if (data.type === 'tip') { setManifest(data.manifest ?? null); return; }
      if (data.type === 'publication-warning') return;
      if (data.requestId !== undefined && data.requestId !== requestRef.current) return;
      if (data.type === 'result') {
        setLoadingFull(false);
        const record = fullRecord(data.result?.record ?? data.result);
        const transaction = record && toTransaction(record);
        if (!record || !transaction) { setView({ kind: 'error', message: 'This transaction could not be decoded safely.' }); return; }
        setView({ kind: 'result', record, data: transaction, partial: data.partial ?? null });
        setMeasurements(data.measurements ?? null);
      } else if (data.type === 'notfound') {
        const current = viewRef.current;
        setView({ kind: 'notfound', txid: current.kind === 'loading' ? current.txid : '', height: Number.isSafeInteger(data.snapshotHeight) ? data.snapshotHeight : null });
      } else if (data.type === 'error') {
        setLoadingFull(false);
        setView({ kind: 'error', message: typeof data.message === 'string' ? data.message : 'The private lookup could not complete.' });
      }
    });
    worker.addEventListener('error', event => {
      event.preventDefault();
      setReady(false);
      setView({ kind: 'error', message: 'The private client stopped. Reload the page to restart it.' });
    });
    worker.postMessage({ type: 'initialize' });
    return () => { workerRef.current = null; worker.terminate(); };
  }, []);

  const busy = view.kind === 'loading' || loadingFull;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) return;
    const txid = query.trim().toLowerCase();
    if (!TXID.test(txid)) { setInputError('Enter a 64-character transaction ID.'); return; }
    setInputError('');
    start(txid);
  }

  function loadFull() {
    if (!ready || busy || view.kind !== 'result' || !view.partial) return;
    setLoadingFull(true);
    workerRef.current?.postMessage({ type: 'loadFull', requestId: requestRef.current });
  }

  function home() {
    if (busy) return;
    setView({ kind: 'home' }); setQuery(''); setInputError(''); setMeasurements(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  const onQuery = (value: string) => {
    editedRef.current = true; setQuery(value); setInputError('');
    // Encrypt ahead in the worker once the ID is complete; nothing is sent until submit.
    const txid = value.trim().toLowerCase();
    if (ready && TXID.test(txid)) workerRef.current?.postMessage({ type: 'prepare', txid });
  };
  const height = manifest?.snapshot?.height;
  const count = manifest?.sourceSummary?.recordCount;

  return <>
    <nav aria-label="Main navigation" className="navbar-container backdrop-blur-xl sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16 gap-3">
          <a href="/" onClick={event => { event.preventDefault(); home(); }} className="shrink-0 py-2 flex items-center gap-2.5" aria-label="ZecBlock Private home">
            <BrandLogo />
            <span className="private-pill"><LockIcon className="w-3 h-3" />Private</span>
          </a>
          {view.kind !== 'home' && <div className="hidden md:block flex-1 max-w-md ml-auto">
            <SearchForm hero={false} value={query} onChange={onQuery} onSubmit={submit} disabled={!ready || busy} />
          </div>}
          <div className={`flex items-center gap-2 ${view.kind === 'home' ? 'ml-auto' : ''}`}>
            <ThemeToggle />
          </div>
        </div>
        {view.kind !== 'home' && <div className="md:hidden pb-3">
          <SearchForm hero={false} idSuffix="mobile" value={query} onChange={onQuery} onSubmit={submit} disabled={!ready || busy} />
        </div>}
      </div>
    </nav>

    <main id="main-content" className="private-main">
      {view.kind === 'home' && <section className="home-hero-band">
        <div className="home-hero relative z-30 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="home-introduction">
            <h1 className="text-primary">The Zcash Private Explorer</h1>
            <p className="home-hero-intro text-secondary">Look up any Zcash transaction without revealing which one. Your search is encrypted in your browser, so not even ZecBlock can see it.</p>
          </div>
          <div className="home-command">
            <SearchForm hero value={query} onChange={onQuery} onSubmit={submit} disabled={!ready || busy} inputRef={inputRef} />
            <div className="search-examples mt-2 sm:mt-2.5 flex flex-wrap gap-1.5 sm:gap-2 items-center">
              <span className="text-caption text-muted font-mono uppercase tracking-wider">Try:</span>
              {EXAMPLES.map(example => <button key={example.txid} type="button" className="example-tag example-tag-default" disabled={!ready || busy} onClick={() => { onQuery(example.txid); start(example.txid); }}>{example.label}</button>)}
            </div>
            {inputError && <p className="text-xs text-danger mt-3" id="lookup-error" role="alert">{inputError}</p>}
            <p className="private-status" id="runtime-status" role="status" aria-live="polite">
              <span className={`private-dot ${ready ? 'ready' : ''}`} aria-hidden="true" />
              {ready
                ? <>Mainnet{count ? ` · ${count.toLocaleString()} transactions` : ''}{height ? ` · up to block ${height.toLocaleString()}` : ''}</>
                : 'Preparing private search…'}
            </p>
          </div>
        </div>
      </section>}

      {view.kind === 'loading' && <div aria-busy="true">
        <p className="sr-only" role="status">Searching privately</p>
        <TxLoadingSkeleton />
      </div>}

      {view.kind === 'result' && <TransactionView key={`${view.record.publicationId}:${view.record.txid}`} record={view.record} data={view.data} partial={view.partial} loadingFull={loadingFull} onLoadFull={loadFull} />}

      {(view.kind === 'notfound' || view.kind === 'error') && <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-12 animate-fade-in">
        <Card role="alert"><CardBody><div className="text-center py-12">
          <div className="w-14 h-14 mx-auto mb-5 rounded-xl bg-cipher-surface border border-white/[0.04] flex items-center justify-center">
            <svg className="w-7 h-7 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          </div>
          <h1 className="text-lg font-semibold text-primary mb-2">{view.kind === 'notfound' ? 'Transaction Not Found' : 'Lookup Failed'}</h1>
          <p className="text-sm text-secondary mb-6 max-w-md mx-auto" id="lookup-error">{view.kind === 'notfound'
            ? `No confirmed transaction with this ID${view.height ? ` up to block ${view.height.toLocaleString()}` : ''}.`
            : view.message}</p>
          {view.kind === 'notfound' && view.txid && <p className="text-xs font-mono text-muted break-all max-w-xl mx-auto mb-6">{view.txid}</p>}
          <button type="button" onClick={home} className="text-cipher-gold hover:text-cipher-yellow transition-colors font-mono text-sm">&larr; New search</button>
        </div></CardBody></Card>
      </div>}
    </main>

    <footer className="private-footer">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <span className="inline-flex items-center gap-1.5"><LockIcon />Searches are private by design{measurements ? <span id="metrics" className="text-muted"> · {(measurements.totalMs / 1000).toFixed(2)} s</span> : null}</span>
        <span>{height ? `Up to block ${height.toLocaleString()}` : ''}</span>
        <a href="https://zecblock.com" rel="noopener noreferrer" className="hover:text-primary transition-colors">zecblock.com</a>
      </div>
    </footer>
  </>;
}
