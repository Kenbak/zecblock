'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { chartCsv, type ChartExportData } from '@/lib/chart-sharing';

export interface ChartShareControlProps {
  title: string;
  shareUrl: string;
  shareText?: string;
  fileName?: string;
  capture: () => Promise<Blob>;
  csvData?: ChartExportData;
  /** CSV for panels outside the chart catalog. */
  csvText?: () => string;
  disabled?: boolean;
  expanded?: boolean;
}
function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ChartShareControl({ title, shareUrl, shareText = title, fileName = 'zecblock-chart.png', capture, csvData, csvText, disabled = false, expanded = false }: ChartShareControlProps) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [status, setStatus] = useState('');
  const [nativeFile, setNativeFile] = useState<File | null>(null);
  const [nativeSupported, setNativeSupported] = useState(false);
  const [nativeFailed, setNativeFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!status || busy) return;
    const timer = setTimeout(() => setStatus(''), 4000);
    return () => clearTimeout(timer);
  }, [status, busy]);
  useEffect(() => {
    setNativeSupported(Boolean(typeof navigator.share === 'function' && navigator.canShare?.({ files: [new File([''], 'chart.png', { type: 'image/png' })] })));
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  // Prepare before the native-share click: awaiting rasterization can lose Safari's user gesture.
  useEffect(() => {
    setNativeFile(null); setNativeFailed(false);
    if (!(open || expanded) || disabled || !nativeSupported) return;
    let cancelled = false;
    capture().then(blob => { if (!cancelled) setNativeFile(new File([blob], fileName, { type: 'image/png' })); }).catch(() => { if (!cancelled) setNativeFailed(true); });
    return () => { cancelled = true; };
  }, [open, expanded, disabled, nativeSupported, capture, fileName]);
  const run = async (action: 'copy' | 'png' | 'link' | 'csv') => {
    setBusy(true); setStatus(action === 'link' ? '' : 'Preparing export…');
    try {
      if (action === 'copy') {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('clipboard');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': capture() })]);
        setStatus('Image copied.');
      } else if (action === 'png') { download(await capture(), fileName); setStatus('PNG downloaded.'); }
      else if (action === 'link') { await navigator.clipboard.writeText(shareUrl); setStatus('Chart link copied.'); }
      else if (csvData || csvText) { download(new Blob([csvData ? chartCsv(csvData) : csvText!()], { type: 'text/csv;charset=utf-8' }), fileName.replace(/\.png$/i, '.csv')); setStatus('CSV downloaded.'); }
    } catch { setStatus(action === 'copy' ? 'Copy unavailable. Use Download PNG instead.' : 'Could not complete this action. Please try again.'); }
    finally { setBusy(false); setOpen(false); }
  };
  const itemClass = 'flex min-h-11 items-center rounded-md px-3 py-2.5 text-caption text-left text-secondary hover:bg-glass-4 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold disabled:opacity-50';
  const actions = <>
    <button type="button" className={itemClass} disabled={busy || disabled} onClick={() => void run('copy')}>Copy image</button>
    <button type="button" className={itemClass} disabled={busy || disabled} onClick={() => void run('png')}>Download PNG</button>
    <button type="button" className={itemClass} disabled={busy} onClick={() => void run('link')}>Copy link</button>
    <a className={itemClass} href={`https://twitter.com/intent/tweet?${new URLSearchParams({ text: shareText.replace(/https?:\/\/\S+/g, '').trim(), url: shareUrl })}`} target="_blank" rel="noopener noreferrer">Share on X ↗</a>
    {(csvData || csvText) && <button type="button" className={itemClass} disabled={busy || disabled} onClick={() => void run('csv')}>Download CSV</button>}
    {nativeSupported && <button type="button" className={itemClass} disabled={!nativeFile || busy || disabled} onClick={() => {
      if (!nativeFile) return;
      void navigator.share({ files: [nativeFile], title, text: title, url: shareUrl }).catch(error => { if (error?.name !== 'AbortError') setStatus('Native sharing unavailable. Use Download PNG instead.'); });
    }}>{nativeFile ? 'Share image…' : nativeFailed ? 'Image sharing unavailable' : 'Preparing share image…'}</button>}
  </>;
  return <div ref={root} className={`relative ${expanded ? 'w-full min-w-0' : 'shrink-0'}`} data-html2canvas-ignore="true" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { setOpen(false); trigger.current?.focus(); event.stopPropagation(); }
  }}>
    {expanded ? <div className="flex flex-wrap gap-1" aria-label={`Share ${title}`}>{actions}</div> : <>
      <button ref={trigger} type="button" aria-label={`Share ${title}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)} className="flex h-11 w-11 sm:h-9 sm:w-9 items-center justify-center rounded-md text-muted hover:bg-glass-4 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V3m-4 4 4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>
      </button>
      {open && <div id={id} className="absolute right-0 top-full z-40 mt-1 flex w-52 flex-col rounded-lg border border-cipher-border bg-cipher-surface p-1 shadow-lg" aria-label={`Sharing options for ${title}`}>{actions}</div>}
    </>}
    {status && createPortal(<div role="status" className="pointer-events-none fixed bottom-6 left-1/2 z-[100] w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border border-cipher-border bg-cipher-surface px-4 py-3 text-center text-caption text-secondary shadow-lg">{status}</div>, document.body)}
  </div>;
}
