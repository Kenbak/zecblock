'use client';

import { useState } from 'react';
import type { Proposal } from '@/lib/governance';

export function ProposalList({ proposals, published, zecPerUnit }: { proposals: Proposal[]; published: boolean; zecPerUnit: number | null }) {
  const [query, setQuery] = useState('');
  const visible = proposals.filter(p => `${p.title} ${p.description}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="mt-6" aria-label={published ? 'Results by proposal' : 'Ballot proposals'}>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h2 className="font-mono text-xs uppercase tracking-wider text-muted">{published ? 'Results' : 'Proposals'} · {proposals.length}</h2>
      {proposals.length > 8 && <label className="flex items-center gap-2 text-xs text-muted">Search proposals<input type="search" value={query} onChange={e => setQuery(e.target.value)} className="w-48 rounded-md border border-cipher-border bg-cipher-surface px-3 py-2 text-sm text-primary" /></label>}
    </div>
    {visible.length === 0 && <p className="py-5 text-sm text-muted">No proposals match your search.</p>}
    <div className="space-y-2">{visible.map(p => {
      const total = p.options.reduce((n, o) => n + o.total_value, 0);
      return <details key={p.id} className="group rounded-xl border border-cipher-border bg-cipher-card">
        <summary className="cursor-pointer px-4 py-3 text-sm text-primary"><span className="mr-3 font-mono text-xs text-muted">{String(p.id).padStart(2, '0')}</span><span className="font-medium">{p.title}</span>{published && <span className="ml-3 inline-block font-mono text-xs text-secondary">{(total * (zecPerUnit ?? 1)).toLocaleString('en-US', { maximumFractionDigits: 3 })} {zecPerUnit === null ? 'vote-weight units' : 'ZEC'} participating</span>}</summary>
        <div className="border-t border-cipher-border-subtle px-4 py-4"><p className="mb-4 whitespace-pre-line text-sm leading-relaxed text-secondary">{p.description}</p>
          <div className="space-y-3">{p.options.map(o => {
            const share = total > 0 ? o.total_value / total * 100 : 0;
            return <div key={o.index} className="rounded-lg border border-cipher-border-subtle px-3 py-3">
              <div className="flex items-start justify-between gap-3"><span className="text-sm font-medium text-primary">{o.label}</span>{published && <span className="shrink-0 font-mono text-sm text-brand-gold">{share.toFixed(2)}%</span>}</div>
              {o.description && <p className="mt-1 text-xs leading-relaxed text-secondary">{o.description}</p>}
              {published && <><div className="mt-3 h-1 overflow-hidden rounded-full bg-cipher-border"><div className="h-full bg-brand-gold/70" style={{ width: `${share}%` }} /></div><p className="mt-1.5 font-mono text-caption text-muted">{(o.total_value * (zecPerUnit ?? 1)).toLocaleString('en-US', { maximumFractionDigits: 3 })} {zecPerUnit === null ? 'vote-weight units' : 'ZEC'}</p></>}
            </div>;
          })}</div>
        </div>
      </details>;
    })}</div>
    {published && <p className="mt-3 text-xs leading-relaxed text-muted">Percentages include all options, including abstentions. Participation is per proposal; totals must not be added together as unique ZEC. The largest option alone does not establish grant approval.</p>}
  </section>;
}
