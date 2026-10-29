import { useCallback, useEffect, useRef, useState } from 'react';
import { TxHeaderBadges } from '@/app/tx/[txid]/components/TxHeaderBadges';
import { TxHeroCard } from '@/app/tx/[txid]/components/TxHeroCard';
import { TxOverview } from '@/app/tx/[txid]/components/TxOverview';
import { InputsOutputsSection } from '@/app/tx/[txid]/components/InputsOutputsSection';
import { classifyTransaction } from '@/app/tx/[txid]/components/tx-classification';
import { Tabs } from '@/components/ui/Tabs';
import { CopyButton } from '@/components/CopyButton';
import type { ActiveTab, RawTxData, TransactionData } from '@/app/tx/[txid]/components/types';
import { RawTransaction } from './RawTransaction';

export interface PrivateRecord {
  schema: string;
  found: boolean;
  publicationId: string;
  network: 'mainnet';
  snapshot: { height: number; hash: string; publishedAt: string };
  coverage: { startHeight: number; endHeight: number; [key: string]: unknown };
  txid: string;
  detail: Record<string, unknown>;
  raw: RawTxData;
  price?: { price_usd?: number | null; exact?: boolean; actual_date?: string; [key: string]: unknown } | null;
}

export function TransactionView({ record, data }: { record: PrivateRecord; data: TransactionData }) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('summary');
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const copyToClipboard = useCallback(async (text: string, label: string) => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(label);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedText(null), 1500);
    } catch { setCopyError(true); }
  }, []);
  const classification = classifyTransaction(data);
  const price = record.price?.price_usd;
  const priceUsd = typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;

  return <section id="result-section" className="private-transaction animate-fade-in" aria-labelledby="transaction-title">
    <div className="flex flex-wrap items-center gap-2 mb-2">
      <h2 className="text-section font-medium text-primary" id="transaction-title">Transaction</h2>
      <span className="private-local-status">DECRYPTED LOCALLY</span>
    </div>
    <div className="private-full-hash mb-5"><code id="result-txid">{record.txid}</code><CopyButton text={record.txid} label="transaction ID" /></div>
    <div className="private-snapshot-notice">
      <span>Confirmed mainnet snapshot</span>
      <span>Block {record.snapshot.height.toLocaleString()} · {new Date(record.snapshot.publishedAt).toLocaleString(undefined, { timeZoneName: 'short' })}</span>
      <span>Confirmation counts and available enrichments are fixed at export.</span>
    </div>
    <TxHeaderBadges data={data} classification={classification} />
    <TxHeroCard data={data} classification={classification} priceUsd={priceUsd} />
    {!priceUsd && <p className="text-caption text-muted mb-5">Historical USD price is unavailable in this publication.</p>}
    {priceUsd && record.price?.exact !== true && <p className="text-caption text-muted mb-5">USD estimates use the nearest bundled price observation{record.price?.actual_date ? ` from ${new Date(record.price.actual_date).toLocaleString(undefined, { timeZoneName: 'short' })}` : ''}; this is not an exact transaction-time quote.</p>}
    <div className="mb-6" id="tx-tabs"><Tabs tabs={[{ id: 'summary', label: 'Overview' }, { id: 'io', label: 'Inputs / Outputs' }, { id: 'raw', label: 'Raw' }]} active={activeTab} onChange={setActiveTab} /></div>
    {copyError && <p className="text-caption text-danger mb-4" role="status">Could not copy. Select and copy the value manually.</p>}
    <div id="result-facts" role="tabpanel" aria-label={activeTab === 'summary' ? 'Overview' : activeTab === 'io' ? 'Inputs / Outputs' : 'Raw'}>
      {activeTab === 'summary' && <TxOverview data={data} classification={classification} />}
      {activeTab === 'io' && <InputsOutputsSection data={data} classification={classification} copiedText={copiedText} onCopy={copyToClipboard} />}
      {activeTab === 'raw' && <RawTransaction raw={record.raw} />}
    </div>
    <p className="private-boundary-note">Addresses, previous transactions and block references are displayed locally. Navigation to public detail pages is disabled in this private prototype.</p>
  </section>;
}
