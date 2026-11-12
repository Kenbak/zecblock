import { useMemo, useState } from 'react';
import { Card, CardBody } from '@/components/ui/Card';
import { CopyButton } from '@/components/CopyButton';
import type { RawTxData } from '@/app/tx/[txid]/components/types';

/** Presentational raw view: data is decrypted and injected, never fetched. */
export function RawTransaction({ raw }: { raw: RawTxData }) {
  const [view, setView] = useState<'decoded' | 'hex'>('decoded');
  const decoded = useMemo(() => JSON.stringify(raw.decoded, null, 2), [raw.decoded]);
  return <div className="space-y-4 animate-fade-in-up" id="raw-transaction-view">
    <div className="flex items-center gap-3 mb-4">
      <div className="private-raw-toggle" role="tablist" aria-label="Raw transaction representation">
        <button type="button" role="tab" aria-selected={view === 'decoded'} onClick={() => setView('decoded')} className={view === 'decoded' ? 'private-raw-option active' : 'private-raw-option'}>Decoded JSON</button>
        <button type="button" role="tab" aria-selected={view === 'hex'} onClick={() => setView('hex')} className={view === 'hex' ? 'private-raw-option active' : 'private-raw-option'}>Hex</button>
      </div>
      <span className="ml-auto flex items-center gap-1 text-caption text-muted">Copy hex<CopyButton text={raw.hex} label="raw transaction hex" /></span>
    </div>
    <Card><CardBody><pre className={`text-caption font-mono text-secondary whitespace-pre-wrap max-h-[600px] overflow-y-auto leading-relaxed ${view === 'hex' ? 'break-all' : 'break-words'}`} id={view === 'hex' ? 'raw-hex' : 'raw-decoded'}>{view === 'hex' ? raw.hex : decoded}</pre></CardBody></Card>
    <p className="text-caption text-muted font-mono text-center">{(raw.hex.length / 2).toLocaleString()} bytes · {raw.hex.length.toLocaleString()} hex characters · decoded from the private response</p>
  </div>;
}
