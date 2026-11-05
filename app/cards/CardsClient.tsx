'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChartShareControl } from '@/components/charts/ChartShareControl';
import { CARD_CATEGORIES, searchFactCards, type FactCardDef } from '@/lib/fact-cards';

function embedCode(site: string, card: FactCardDef) {
  return `<a href="${site}${card.href}"><img src="${site}/cards/${card.id}/image" alt="${card.title}: ${card.description} Live data from ZecBlock." width="1200" height="675" loading="lazy" style="max-width:100%;height:auto"></a>`;
}

function CardTile({ card, site }: { card: FactCardDef; site: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [copied, setCopied] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  // A server-rendered image can finish before hydration attaches onLoad/onError.
  useEffect(() => {
    const el = img.current;
    if (el?.complete) setState(el.naturalWidth > 0 ? 'ready' : 'unavailable');
  }, []);
  const src = `/cards/${card.id}/image`;
  const capture = useCallback(async () => {
    const response = await fetch(src);
    if (!response.ok) throw new Error('Card unavailable');
    return response.blob();
  }, [src]);
  const copyEmbed = async () => {
    try { await navigator.clipboard.writeText(embedCode(site, card)); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { setCopied(false); }
  };
  return <li id={card.id} className="scroll-mt-36 flex flex-col rounded-lg border border-cipher-border bg-glass-3 p-2">
    <div className="relative aspect-video w-full overflow-hidden rounded-md bg-cipher-surface">
      {state !== 'unavailable'
        // eslint-disable-next-line @next/next/no-img-element
        ? <img ref={img} src={src} alt={`${card.title}: ${card.description}`} width={1200} height={675} loading="lazy"
          className={`h-full w-full transition-opacity ${state === 'ready' ? 'opacity-100' : 'opacity-0'}`}
          onLoad={() => setState('ready')} onError={() => setState('unavailable')} />
        : <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-caption text-muted">Live data for this card is unavailable right now. Nothing is shown rather than a guess.</p>}
    </div>
    <div className="flex flex-1 flex-col gap-2 px-1 pt-3 pb-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-caption font-mono uppercase text-muted">{card.category}</p>
          <h2 className="text-sm font-semibold text-primary">{card.title}</h2>
        </div>
        <ChartShareControl title={card.title} shareUrl={`${site}${card.href}`} shareText={`${card.title} on Zcash, live from ZecBlock`}
          fileName={`zecblock-${card.id}.png`} capture={capture} disabled={state !== 'ready'} />
      </div>
      <p className="text-caption text-secondary">{card.description}</p>
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-caption">
        <Link href={card.href} className="font-mono text-muted hover:text-primary">Open the data →</Link>
        <button type="button" onClick={copyEmbed} className="font-mono text-muted hover:text-primary" aria-live="polite">{copied ? 'Embed code copied' : 'Copy embed code'}</button>
      </div>
    </div>
  </li>;
}

/** Searchable gallery of live, branded Zcash cards anyone can post or embed. */
export function CardsClient({ cards, site }: { cards: FactCardDef[]; site: string }) {
  const categories = useMemo(() => ['All', ...CARD_CATEGORIES.filter(c => cards.some(card => card.category === c))], [cards]);
  const [category, setCategory] = useState('All');
  const [query, setQuery] = useState('');
  const shown = searchFactCards(cards, query, category);
  return <>
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-cipher-border pb-5 mb-8">
      <div className="flex flex-wrap gap-2" aria-label="Card categories">
        {categories.map(c => <button type="button" key={c} aria-pressed={category === c} onClick={() => setCategory(c)} className={`filter-btn ${category === c ? 'filter-btn-active' : ''}`}>{c}</button>)}
      </div>
      <label className="flex w-full items-center gap-3 text-caption text-muted sm:w-auto">
        <span className="sr-only">Search cards</span>
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search: privacy, halving, maya…"
          className="w-full sm:w-64 rounded-lg border border-cipher-border bg-cipher-surface px-3 py-2 text-sm text-primary" />
      </label>
    </div>
    <p role="status" className="mb-5 text-caption text-muted">{shown.length} {shown.length === 1 ? 'card' : 'cards'}{category === 'All' ? '' : ` · ${category}`}</p>
    {shown.length
      ? <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{shown.map(card => <CardTile key={card.id} card={card} site={site} />)}</ul>
      : <p className="py-16 text-center text-muted">No cards match. Try another word or category.</p>}
  </>;
}
