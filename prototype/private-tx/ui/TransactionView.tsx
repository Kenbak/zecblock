import { useCallback, useEffect, useRef, useState } from 'react';
import { TxHeaderBadges } from '@/app/tx/[txid]/components/TxHeaderBadges';
import { TxHeroCard } from '@/app/tx/[txid]/components/TxHeroCard';
import { TxOverview } from '@/app/tx/[txid]/components/TxOverview';
import { InputsOutputsSection } from '@/app/tx/[txid]/components/InputsOutputsSection';
import { classifyTransaction } from '@/app/tx/[txid]/components/tx-classification';
import { Tabs } from '@/components/ui/Tabs';
import { Card, CardBody } from '@/components/ui/Card';
import { FactBox } from '@/components/ui/FactBox';
import type { ActiveTab, RawTxData, TransactionData } from '@/app/tx/[txid]/components/types';
import { CopyButton } from '@/components/CopyButton';
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

export type PartialView = { rows: number; shownInputs: number; shownOutputs: number; totalInputs: number; totalOutputs: number };

const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

function zec(exact: string | null | undefined, approx: number) {
  const value = exactZec(exact ?? null);
  return value === null ? approx.toFixed(4) : value.replace(/\.?0+$/, '');
}

// The shared hero counts only the inputs/outputs present in data, which in a
// preview are the first few. This hero uses the record's complete totals.
function PreviewHero({ data, partial, loadingFull, onLoadFull }: { data: TransactionData; partial: PartialView; loadingFull: boolean; onLoadFull: () => void }) {
  return <div className="mb-6 animate-fade-in-up"><Card><CardBody><div className="space-y-4">
    <div className="flex flex-col items-center gap-2 py-2 font-mono text-center">
      <span className="text-sm text-secondary">{plural(partial.totalInputs, 'input')}</span>
      <span className="text-muted" aria-hidden="true">↓</span>
      <span className="text-lg font-semibold text-primary">{zec(data.totalOutputZat, data.totalOutput)} ZEC</span>
      <span className="text-muted" aria-hidden="true">↓</span>
      <span className="text-sm text-secondary">{plural(partial.totalOutputs, 'output')}</span>
    </div>
    <p className="text-sm text-muted leading-relaxed">
      A large transaction with {plural(partial.totalInputs, 'input')} and {plural(partial.totalOutputs, 'output')}.
      {data.blockHeight > 0 && <> Included in canonical Zcash block <span className="text-primary">#{data.blockHeight.toLocaleString()}</span>.</>}
    </p>
    <div id="partial-warning" className="private-partial" role="status">
      <span>Showing the first {partial.shownInputs < partial.totalInputs ? `${partial.shownInputs.toLocaleString()} inputs and ` : ''}{partial.shownOutputs.toLocaleString()} outputs.</span>
      <button type="button" id="load-full" className="private-partial-action" disabled={loadingFull} onClick={onLoadFull}
        title={`Fetches ${partial.rows} more encrypted rows. The server still can't see which transaction, only that it is a large one.`}>
        {loadingFull ? 'Loading…' : 'Load all'}
      </button>
    </div>
  </div></CardBody></Card></div>;
}

// Mirrors app/tx/[txid]/components/TxDetailClient so the private page reads
// exactly like the public transaction page, fed by the locally decoded record.
export function TransactionView({ record, data, partial, loadingFull, onLoadFull }: {
  record: PrivateRecord;
  data: TransactionData;
  partial: PartialView | null;
  loadingFull: boolean;
  onLoadFull: () => void;
}) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('summary');
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(label);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedText(null), 1500);
    } catch { /* clipboard unavailable; the value stays selectable */ }
  }, []);
  const classification = classifyTransaction(data);
  const price = record.price?.price_usd;
  const priceUsd = typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
  const joinsplitCount = typeof record.detail.sproutJoinsplitCount === 'number' && Number.isSafeInteger(record.detail.sproutJoinsplitCount)
    ? record.detail.sproutJoinsplitCount : null;
  const hasSprout = record.detail.hasSprout === true || joinsplitCount !== null && joinsplitCount > 0;
  const sproutBalance = exactZec(record.detail.valueBalanceSproutZat, true);

  return <PrivateRecordContext value={record}>
    <div id="result-section" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-6 sm:pt-6 sm:pb-12 animate-fade-in">
      <section className="mb-6" aria-labelledby="transaction-heading">
        <p className="text-xs font-mono text-muted tracking-wider">&gt; TX_LOOKUP</p>
        <h1 id="transaction-heading" className="type-page mt-2">
          <span className="block type-page text-primary">Zcash Transaction</span>{' '}
          <span className="mt-2 flex items-center gap-2 min-w-0">
            <span id="result-txid" className="text-sm sm:text-base font-mono font-normal text-primary break-all">{record.txid}</span>
            <CopyButton text={record.txid} size="sm" className="shrink-0" />
          </span>
        </h1>
      </section>
      <TxHeaderBadges data={data} classification={classification} />
      {partial
        ? <PreviewHero data={data} partial={partial} loadingFull={loadingFull} onLoadFull={onLoadFull} />
        : <TxHeroCard data={data} classification={classification} priceUsd={priceUsd} />}

      <div className="mb-6 animate-fade-in-up stagger-2" id="tx-tabs">
        <Tabs tabs={[{ id: 'summary', label: 'Overview' }, { id: 'io', label: 'Inputs / Outputs' }, ...(record.raw ? [{ id: 'raw' as const, label: 'Raw' }] : [])]} active={activeTab} onChange={setActiveTab} />
      </div>

      <div id="result-facts" role="tabpanel">
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
    </div>
  </PrivateRecordContext>;
}
