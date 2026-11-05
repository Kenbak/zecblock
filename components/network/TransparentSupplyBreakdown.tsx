'use client';
import { SkeletonTable } from '@/components/ui/EmptyState';

import { useEffect, useState } from 'react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { Card, CardBody } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';

interface BalanceGroup { addressCount: number; totalBalance: number; percentage: number }
interface Breakdown {
  success: boolean;
  transparentTotal: number;
  categories: (BalanceGroup & { category: string })[];
  addressTypes?: (BalanceGroup & { type: string })[];
}

export function TransparentSupplyBreakdown() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const reveal = () => { if (window.location.hash === '#transparent-breakdown') setOpen(true); };
    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, []);
  const { data, loading, error } = useApiQuery<Breakdown>('/v1/network/supply/transparent-breakdown', undefined, { refreshInterval: 300_000, enabled: open });
  const rows = data ? data.categories : [];
  const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const table = (groups: (BalanceGroup & { label: string })[], caption: string) => <div className="overflow-x-auto"><table className="w-full text-sm text-left">
    <caption className="text-left font-mono text-secondary mb-3">{caption}</caption>
    <thead className="text-caption text-muted"><tr><th className="py-3 pr-4 font-medium">Group</th><th className="py-3 px-4 text-right font-medium">Addresses</th><th className="py-3 px-4 text-right font-medium">ZEC</th><th className="py-3 pl-4 text-right font-medium">Share</th></tr></thead>
    <tbody>{groups.map(row => <tr key={row.label} className="border-t border-cipher-border hover:bg-glass-3"><th scope="row" className="py-3 pr-4 font-normal text-primary capitalize">{row.label.replaceAll('_', ' ')}</th><td className="py-3 px-4 text-right font-mono text-secondary">{row.addressCount.toLocaleString()}</td><td className="py-3 px-4 text-right font-mono text-primary whitespace-nowrap">{number(row.totalBalance)}</td><td className="py-3 pl-4 text-right font-mono text-secondary">{data && data.transparentTotal > 0 ? `${number(row.percentage)}%` : '—'}</td></tr>)}</tbody>
  </table></div>;
  return <section id="transparent-breakdown" className="scroll-mt-36 mb-8">
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="border-y border-cipher-border py-4">
      <summary className="text-sm font-mono text-primary cursor-pointer">Transparent balance groups <span className="font-sans text-muted text-caption">· categories &amp; script types</span></summary>
    {open && <Card className="mt-4"><CardBody>
      <SectionHeader label="TRANSPARENT_BALANCES" />
      <p className="text-sm text-secondary mb-5">Positive indexed address balances grouped by known labels and script type. Labels describe addresses, not verified beneficial ownership. Shares use the node’s transparent pool balance; observations can differ in time.</p>
      {loading && !rows.length ? <div className="grid xl:grid-cols-2 gap-8"><SkeletonTable rows={5} columns={3} /><SkeletonTable rows={4} columns={3} label={null} /></div> : rows.length ? <div className="grid xl:grid-cols-2 gap-8">
        {table(rows.map(row => ({ ...row, label: row.category })), 'Address categories')}
        {table((data?.addressTypes ?? []).map(row => ({ ...row, label: row.type })), 'Script types')}
      </div> : <p className="text-sm text-muted">{loading ? 'Loading transparent balance groups…' : 'Transparent balance groups are unavailable.'}</p>}
      {error && rows.length > 0 && <p role="status" className="text-caption text-warning mt-3">Could not refresh. Last received balance groups are shown.</p>}
    </CardBody></Card>}
    </details>
  </section>;
}
