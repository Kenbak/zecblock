'use client';
import { CURRENCY } from '@/lib/config';
import { type EmissionResponse } from '@/lib/issuance-curve';
import { SupplyIssuanceChart } from './SupplyIssuanceChart';
import { Skeleton } from '@/components/ui/Skeleton';

import { useApiQuery } from '@/hooks/useApiQuery';
import { Card, CardBody } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { HalvingPanel, type HalvingInfo } from './HalvingPanel';

function formatAmount(value: number | null | undefined, decimals = 8) {
  return value != null && Number.isFinite(value)
    ? value.toLocaleString('en-US', { maximumFractionDigits: decimals }) : '—';
}

export function MiningIssuance({ initialHalving, initialEmission, initialFetchedAt }: { initialHalving?: HalvingInfo | null; initialEmission?: EmissionResponse | null; initialFetchedAt?: number }) {
  const { data, loading, error } = useApiQuery<HalvingInfo & { success: boolean }>('/v1/network/halving', undefined, { refreshInterval: 300_000, initialData: initialHalving ?? undefined, initialFetchedAt });
  const emission = useApiQuery<EmissionResponse>('/v1/network/emission', undefined, { refreshInterval: 300_000, initialData: initialEmission ?? undefined, initialFetchedAt });
  const halving = data ? data : null;
  return <section id="issuance" className="network-section mb-6">
    <SectionHeader label="ISSUANCE" />
    <SupplyIssuanceChart data={emission.data} loading={emission.loading} error={emission.error} />
    <div className="grid md:grid-cols-2 gap-5 items-start">
      {halving ? <HalvingPanel halving={halving} /> : loading ? <Card><CardBody><p className="text-sm font-mono text-primary mb-5">Next halving</p><Skeleton className="h-10 w-48 mx-auto mb-3" /><Skeleton className="h-4 w-32 mx-auto mb-6" /><Skeleton className="h-2.5 w-full mb-6" /><div className="space-y-4">{[0,1,2,3,4].map(i => <div key={i} className="flex justify-between gap-4"><Skeleton className="h-4 w-36" /><Skeleton className="h-4 w-24" /></div>)}</div></CardBody></Card> : <Card><CardBody><p className="text-sm text-muted">{loading ? 'Loading halving observations…' : 'Halving observations are unavailable.'}</p></CardBody></Card>}
      <Card><CardBody>
        <h3 className="font-mono text-sm text-primary mb-5">Issuance per block</h3>
        <table className="w-full text-sm">
          <caption className="sr-only">Block subsidy and miner allocation in {CURRENCY}, currently and after the next halving</caption>
          <thead><tr className="border-b border-cipher-border text-caption text-muted">
            <th scope="col" className="text-left font-normal pb-3 pr-2">{CURRENCY} / block</th>
            <th scope="col" className="text-right font-normal pb-3 px-2">Current</th>
            <th scope="col" className="text-right font-normal pb-3 pl-2">After halving</th>
          </tr></thead>
          <tbody>
            {([
              ['Total subsidy', halving?.currentSubsidy, halving?.nextSubsidy],
              ['Miner allocation', halving?.minerReward, halving?.nextMinerReward],
            ] as const).map(([label, current, next]) => <tr key={label} className="border-b border-cipher-border">
              <th scope="row" className="text-left text-muted font-normal py-3 pr-2">{label}</th>
              <td className="text-right font-mono text-primary tabular-nums py-3 px-2">{formatAmount(current)}</td>
              <td className="text-right font-mono text-primary tabular-nums py-3 pl-2">{formatAmount(next)}</td>
            </tr>)}
          </tbody>
        </table>
      </CardBody></Card>
    </div>
    {error && halving && <p role="status" className="text-caption text-warning mt-3">Could not refresh issuance data. Last received values are shown.</p>}
  </section>;
}
