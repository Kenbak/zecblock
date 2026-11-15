'use client';

import { useMemo, useState } from 'react';
import { GRANTS_REPO, GRANT_CATEGORIES, formatUsd, type GrantCategory, type GrantProposal } from '@/lib/grant-rounds';

type Sort = 'largest' | 'smallest' | 'newest';
const SORTS: { id: Sort; label: string }[] = [
  { id: 'largest', label: 'Largest first' },
  { id: 'smallest', label: 'Smallest first' },
  { id: 'newest', label: 'Newest first' },
];

/** Full list is server rendered; filters only narrow what is visible. */
export function GrantProposalCatalog({ proposals, source }: { proposals: readonly GrantProposal[]; source: string }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<GrantCategory | 'all'>('all');
  const [sort, setSort] = useState<Sort>('largest');
  const categories = useMemo(() => [...new Set(proposals.map(p => p.category))], [proposals]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...proposals]
      .filter(p => category === 'all' || p.category === category)
      .filter(p => !q || `${p.title} ${p.applicant} ${p.summary} ${p.github ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => sort === 'largest' ? b.requestedUsd - a.requestedUsd : sort === 'smallest' ? a.requestedUsd - b.requestedUsd : (b.github ?? 0) - (a.github ?? 0));
  }, [proposals, query, category, sort]);
  const visibleTotal = visible.reduce((sum, p) => sum + p.requestedUsd, 0);

  return <section id="proposal-catalog" className="mt-6 scroll-mt-48" aria-labelledby="proposal-catalog-title">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <h2 id="proposal-catalog-title" className="font-mono text-xs uppercase tracking-wider text-muted">Proposals · {proposals.length}</h2>
      <p className="text-caption text-muted" aria-live="polite">Showing {visible.length} · {formatUsd(visibleTotal)} requested</p>
    </div>
    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
      <label className="flex-1"><span className="sr-only">Search proposals</span>
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search proposals, applicants or #issue" className="w-full rounded-lg border border-cipher-border bg-cipher-surface px-3 py-2 text-sm text-primary placeholder:text-muted focus:border-brand-gold/50 focus:outline-none" />
      </label>
      <label><span className="sr-only">Sort proposals</span>
        <select value={sort} onChange={e => setSort(e.target.value as Sort)} className="w-full rounded-lg border border-cipher-border bg-cipher-surface px-3 py-2 text-sm text-primary sm:w-auto">
          {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
    </div>
    <div className="no-scrollbar mt-2 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter by category">
      {(['all', ...categories] as const).map(c => <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}
        className={`shrink-0 rounded-full border px-3 py-1 text-xs transition-colors ${category === c ? 'border-brand-gold/40 bg-brand-gold/10 text-brand-gold' : 'border-cipher-border text-secondary hover:text-primary'}`}>
        {c === 'all' ? 'All' : GRANT_CATEGORIES[c].short}
      </button>)}
    </div>
    {visible.length === 0 && <p className="py-6 text-sm text-muted">No proposals match your search.</p>}
    <ul className="mt-3 grid gap-3 lg:grid-cols-2">
      {visible.map(p => <li key={`${p.github}-${p.title}`} className="flex flex-col rounded-xl border border-cipher-border bg-cipher-surface p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-caption">
              {p.github !== null && <span className="text-muted">#{p.github}</span>}
              <span className="rounded border border-cipher-border px-1.5 py-0.5 text-secondary">{GRANT_CATEGORIES[p.category].short}</span>
              {p.ownApplication && <span className="rounded border border-brand-gold/30 px-1.5 py-0.5 text-brand-gold">ZecBlock’s application</span>}
            </div>
            <h3 className="mt-2 text-sm font-semibold leading-snug text-primary">{p.title}</h3>
            <p className="mt-0.5 text-xs text-muted">{p.applicant}</p>
          </div>
          <p className="shrink-0 text-right"><span className="block font-mono text-base font-semibold tabular-nums text-primary">{formatUsd(p.requestedUsd)}</span><span className="text-caption text-muted">requested</span></p>
        </div>
        <p className="mt-2 flex-1 text-xs leading-relaxed text-secondary">{p.summary}</p>
        <a href={p.github !== null ? `${GRANTS_REPO}/issues/${p.github}` : source} target="_blank" rel="noopener noreferrer" className="mt-3 self-start text-xs text-brand-gold hover:underline">
          {p.github !== null ? 'Read the application ↗' : 'Read the announcement ↗'}
        </a>
      </li>)}
    </ul>
    <p className="mt-3 text-xs leading-relaxed text-muted">Summaries condense the organizer’s review-period descriptions of each applicant’s own claims; read the full application and forum thread before voting. Requests are in US dollars and, if approved, paid in ZEC. Grants above $50,000 require KYC before payment.</p>
  </section>;
}
