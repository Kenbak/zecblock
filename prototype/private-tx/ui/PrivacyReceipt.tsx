import { useEffect, useState } from 'react';

// What the browser sent for the last search, laid out like the Network tab in
// the browser's developer tools: one line per request with its size, plus a
// check that the search text is in none of them. The page builds this from
// the worker's own log, so it points people at Inspect → Network to confirm.
export type Receipt = {
  requestId: number;
  term: string;
  kind: 'hash' | 'height' | 'address';
  termFound: boolean;
  requests: { host: string; method: string; path: string; sent: number; received: number }[];
};

const size = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const short = (term: string) => term.length > 20 ? `${term.slice(0, 10)}…${term.slice(-6)}` : term;
const name = (path: string) => path.split('/').filter(p => p && p !== '…').slice(-2).join('/') || path;

function Shield() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" />
  </svg>;
}

export function PrivacyReceipt({ receipts }: { receipts: Receipt[] }) {
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState(false);
  const latest = receipts.at(-1);

  useEffect(() => {
    if (!latest) return;
    setFresh(true);
    const id = window.setTimeout(() => setFresh(false), 2400);
    return () => window.clearTimeout(id);
  }, [latest?.requestId]);

  if (!latest) return null;
  const label = latest.termFound ? 'Check your search' : 'Searched privately';

  if (!open) {
    return <button type="button" className={`private-receipt-pill ${fresh ? 'is-fresh' : ''}`} onClick={() => setOpen(true)} aria-label={`${label}: show what your browser sent`}>
      <Shield /><span>{label}</span>
    </button>;
  }

  const sent = latest.requests.reduce((s, q) => s + q.sent, 0);
  const received = latest.requests.reduce((s, q) => s + q.received, 0);

  return <aside className="private-receipt" aria-label="What your browser sent">
    <header className="private-receipt-head">
      <span className="private-receipt-title"><Shield /> What your browser sent</span>
      <button type="button" className="private-receipt-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
    </header>

    <p className={`private-receipt-verdict ${latest.termFound ? 'is-bad' : ''}`}>
      <s>{short(latest.term)}</s>{' '}
      {latest.termFound ? 'was found in a request. Please report this.' : `is in none of these ${latest.requests.length} requests.`}
    </p>

    <table className="private-receipt-net">
      <thead><tr><th>Name</th><th>Sent</th><th>Received</th></tr></thead>
      <tbody>
        {latest.requests.map((q, i) => <tr key={i}>
          <td title={`${q.method} ${q.host}${q.path}`}><span className="private-receipt-method">{q.method}</span> {name(q.path)}</td>
          <td>{size(q.sent)}</td><td>{size(q.received)}</td>
        </tr>)}
      </tbody>
      <tfoot><tr><td>{latest.requests.length} requests · {latest.requests[0]?.host}</td><td>{size(sent)}</td><td>{size(received)}</td></tr></tfoot>
    </table>

    <p className="private-receipt-foot">
      Encrypted on your device. ZecBlock still sees your IP, the time and the kind of search. Check it yourself: Inspect → Network.
    </p>
  </aside>;
}
