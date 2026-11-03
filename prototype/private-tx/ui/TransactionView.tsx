import { useCallback, useEffect, useRef, useState } from 'react';
import { TxHeaderBadges } from '@/app/tx/[txid]/components/TxHeaderBadges';
import { TxHeroCard } from '@/app/tx/[txid]/components/TxHeroCard';
import { TxOverview } from '@/app/tx/[txid]/components/TxOverview';
import { InputsOutputsSection } from '@/app/tx/[txid]/components/InputsOutputsSection';
import { classifyTransaction } from '@/app/tx/[txid]/components/tx-classification';
import { Tabs } from '@/components/ui/Tabs';
import { CopyButton } from '@/components/CopyButton';
import { Card, CardBody } from '@/components/ui/Card';
import { FactBox } from '@/components/ui/FactBox';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { ExportButton } from '@/components/ExportButton';
import type { ActiveTab, RawTxData, TransactionData } from '@/app/tx/[txid]/components/types';
import { RawTransaction } from './RawTransaction';
import { PrivateRecordContext } from './private-record-context';
import { exactZec } from './private-record-facts';

export interface PrivateRecord {
  schema: string;
  found: boolean;
  publicationId: string;
  network: 'mainnet';
  snapshot: { height: number; hash: string; publishedAt: string };
  coverage: { startHeight: number; endHeight: number; [key: string]: unknown };
  txid: string;
  detail: Record<string, unknown>;
  raw: RawTxData | null;
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
  const joinsplitCount = typeof record.detail.sproutJoinsplitCount === 'number' && Number.isSafeInteger(record.detail.sproutJoinsplitCount)
    ? record.detail.sproutJoinsplitCount : null;
  const hasSprout = record.detail.hasSprout === true || joinsplitCount !== null && joinsplitCount > 0;
  const sproutBalance = exactZec(record.detail.valueBalanceSproutZat, true);
  const otherSproutComponents = [
    data.inputs.some(input => !input.coinbase) || data.outputs.length > 0 ? 'transparent components' : null,
    data.saplingSpendCount > 0 || data.saplingOutputCount > 0 || record.detail.hasSapling === true ? 'Sapling' : null,
    (data.orchardActions ?? 0) > 0 || record.detail.hasOrchard === true ? 'Orchard' : null,
    (data.ironwoodActions ?? 0) > 0 || record.detail.hasIronwood === true ? 'Ironwood' : null,
  ].filter((component): component is string => component !== null);

  return <PrivateRecordContext value={record}><section id="result-section" className="private-transaction animate-fade-in" aria-labelledby="transaction-title">
    <div className="flex flex-wrap items-center gap-2 mb-2">
      <h2 className="text-section font-medium text-primary" id="transaction-title">Transaction</h2>
      <span className="private-local-status">DECRYPTED LOCALLY</span>
    </div>
    <div className="private-full-hash mb-5"><code id="result-txid">{record.txid}</code><CopyButton text={record.txid} label="transaction ID" /></div>
    <div className="private-snapshot-notice">
      <span>Confirmed mainnet snapshot</span>
      <span>Block {record.snapshot.height.toLocaleString()}{record.snapshot.publishedAt && new Date(record.snapshot.publishedAt).getTime() > 0 ? ` · ${new Date(record.snapshot.publishedAt).toLocaleString(undefined, { timeZoneName: 'short' })}` : ''}</span>
      <span>Confirmation counts and available enrichments are fixed at export.</span>
    </div>
    {hasSprout ? <>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex flex-wrap items-center gap-2"><Badge color="muted" variant="subtle">MAINNET</Badge><StatusBadge status="confirmed" variant="subtle" /><Badge color="muted" variant="subtle">{otherSproutComponents.length ? 'MIXED · SPROUT' : 'SPROUT'}</Badge></div>
        <ExportButton data={record} filename={`tx-${record.txid.slice(0, 16)}`} type="json" label="Export" />
      </div>
      <Card className="mb-6"><CardBody><p className="text-sm text-primary" id="private-sprout-summary">This transaction contains Sprout JoinSplits{otherSproutComponents.length ? ` alongside ${otherSproutComponents.join(', ')}` : ''}.</p><p className="text-caption text-muted mt-3">Captured public value balances and any transparent inputs or outputs are shown below. Shielded note values, senders and recipients are unavailable from public data.</p></CardBody></Card>
    </> : <><TxHeaderBadges data={data} classification={classification} /><TxHeroCard data={data} classification={classification} priceUsd={priceUsd} /></>}
    {!priceUsd && <p className="text-caption text-muted mb-5">Historical USD price is unavailable in this publication.</p>}
    {priceUsd && record.price?.exact !== true && <p className="text-caption text-muted mb-5">USD estimates use the nearest bundled price observation{record.price?.actual_date ? ` from ${new Date(record.price.actual_date).toLocaleString(undefined, { timeZoneName: 'short' })}` : ''}; this is not an exact transaction-time quote.</p>}
    <div className="mb-6" id="tx-tabs"><Tabs tabs={[{ id: 'summary', label: 'Overview' }, { id: 'io', label: 'Inputs / Outputs' }, ...(record.raw ? [{ id: 'raw' as const, label: 'Raw' }] : [])]} active={activeTab} onChange={setActiveTab} /></div>
    {copyError && <p className="text-caption text-danger mb-4" role="status">Could not copy. Select and copy the value manually.</p>}
    <div id="result-facts" role="tabpanel" aria-label={activeTab === 'summary' ? 'Overview' : activeTab === 'io' ? 'Inputs / Outputs' : 'Raw'}>
      {activeTab === 'summary' && <>
        <TxOverview data={data} classification={classification} />
        {hasSprout && <Card className="mb-6"><CardBody><div className="flex flex-wrap items-start gap-3" id="private-sprout-facts">
          <FactBox hug label="Sprout JoinSplits"><span className="text-sm font-mono text-primary">{joinsplitCount ?? 'Unavailable'}</span></FactBox>
          <FactBox hug label="Sprout value balance"><span className="text-sm font-mono text-primary">{sproutBalance === null ? 'Unavailable' : `${sproutBalance} ZEC`}</span></FactBox>
        </div></CardBody></Card>}
      </>}
      {activeTab === 'io' && <InputsOutputsSection data={data} classification={classification} copiedText={copiedText} onCopy={copyToClipboard} />}
      {activeTab === 'raw' && record.raw && <RawTransaction raw={record.raw} />}
    </div>
    <p className="private-boundary-note">Addresses, previous transactions and block references are displayed locally. Navigation to public detail pages is disabled in this private prototype.</p>
  </section></PrivateRecordContext>;
}
