'use client';

import { useCallback, useState } from 'react';
import { ChartShareControl } from '@/components/charts/ChartShareControl';
import { NETWORK } from '@/lib/api-config';
import { NU7_CARD_LABELS, type Nu7CardId } from '@/lib/nu7-cards';

const SITE = NETWORK === 'testnet' ? 'https://testnet.zecblock.com' : 'https://zecblock.com';
const SHARE_PAGE: Record<Nu7CardId, string> = {
  countdown: '/network/upgrades#nu7', blocks: '/network/block-speed', nsm: '/network#nu7-accounting', readiness: '/network/nodes',
};

function CardShare({ id }: { id: Nu7CardId }) {
  const [failed, setFailed] = useState(false);
  const src = `/network/upgrades/card/${id}`;
  const capture = useCallback(async () => {
    const response = await fetch(src);
    if (!response.ok) throw new Error('NU7 card unavailable');
    return response.blob();
  }, [src]);
  // Cards without authoritative data (503) are omitted rather than shown empty.
  if (failed) return null;
  return <figure className="w-[82%] shrink-0 snap-start min-w-0 rounded-lg border border-cipher-border bg-glass-3 p-2 sm:w-auto">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={src} alt={`NU7 ${NU7_CARD_LABELS[id].toLowerCase()} card`} width={1200} height={675} loading="lazy"
      className="aspect-video w-full rounded-md" onError={() => setFailed(true)} />
    <figcaption className="flex items-center justify-between gap-2 pt-2 pl-1">
      <span className="text-caption font-mono text-secondary">{NU7_CARD_LABELS[id]}</span>
      <ChartShareControl title={`NU7 ${NU7_CARD_LABELS[id].toLowerCase()}`} shareUrl={`${SITE}${SHARE_PAGE[id]}`}
        shareText={`NU7 on Zcash: ${NU7_CARD_LABELS[id].toLowerCase()}`} fileName={`zecblock-nu7-${id}.png`} capture={capture} />
    </figcaption>
  </figure>;
}

/** Ready-made images for posting NU7 facts; each links back to its live page. */
export function Nu7ShareCards({ cards }: { cards: readonly Nu7CardId[] }) {
  return <section aria-labelledby="nu7-share-heading" className="mt-5">
    <h3 id="nu7-share-heading" className="text-sm font-semibold text-primary mb-1">Share NU7</h3>
    <p className="text-caption text-muted mb-3">Live images, ready to post. Each links back to its data.</p>
    {/* Phones swipe through the cards; wider screens see them side by side. */}
    <div className={`-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 no-scrollbar sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 ${cards.length === 3 ? 'xl:grid-cols-3' : 'xl:grid-cols-4'}`}>
      {cards.map(id => <CardShare key={id} id={id} />)}
    </div>
  </section>;
}
