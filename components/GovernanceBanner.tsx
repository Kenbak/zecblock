'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { isMainnet, isCrosslink, NETWORK } from '@/lib/config';
import type { Announcement } from '@/lib/governance';
import { useApiQuery } from '@/hooks/useApiQuery';
import { readUpgradeSnapshot, estimateBlockArrival, formatUpgradeTime } from '@/lib/network-upgrades';

export function GovernanceBanner() {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const dismissedKeys = useRef(new Set<string>());
  const ref = useRef<HTMLDivElement>(null);
  const { data, error } = useApiQuery<unknown>('/v1/network/stats', undefined, { enabled: !isCrosslink, refreshInterval: 30_000 });
  const network = NETWORK === 'crosslink' ? 'crosslink-testnet' : NETWORK;
  const snapshot = error ? null : readUpgradeSnapshot(data, network);
  const activationHeight = snapshot?.schedule.nu7Height;
  const pending = snapshot && activationHeight != null && snapshot.height < activationHeight;
  const estimate = pending ? estimateBlockArrival(snapshot, activationHeight) : null;
  const displayed = pending ? {
    key: `nu7:${network}:${activationHeight}`,
    href: `/block/${activationHeight}`,
    text: estimate ? `in about ${formatUpgradeTime(estimate.seconds)}` : 'on its way',
  } : announcement;
  const blocksLeft = pending ? activationHeight - snapshot.height : 0;
  const displayedKey = displayed?.key;
  const visible = Boolean(displayed && dismissed !== displayedKey);
  useEffect(() => {
    if (!displayedKey) return;
    let stored = false;
    try { stored = sessionStorage.getItem(`governance:${displayedKey}`) === '1'; } catch { /* Storage can be disabled. */ }
    setDismissed(stored || dismissedKeys.current.has(displayedKey) ? displayedKey : null);
  }, [displayedKey]);
  useEffect(() => {
    if (!isMainnet || isCrosslink) return;
    const controller = new AbortController();
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const response = await fetch('/api/governance/announcement', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        if (!response.ok) throw new Error('Unavailable');
        const { announcement: next } = await response.json() as { announcement: Announcement | null };
        if (controller.signal.aborted) return;
        setAnnouncement(next);
      } catch { if (!controller.signal.aborted) setAnnouncement(null); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  useEffect(() => {
    const element = ref.current;
    if (!visible || !element) { document.documentElement.style.setProperty('--app-ironwood-height', '0px'); return; }
    const sync = () => document.documentElement.style.setProperty('--app-ironwood-height', `${element.offsetHeight}px`);
    sync();
    const observer = new ResizeObserver(sync); observer.observe(element);
    return () => { observer.disconnect(); document.documentElement.style.setProperty('--app-ironwood-height', '0px'); };
  }, [visible]);
  if (!visible || !displayed) return null;
  const dismiss = () => { dismissedKeys.current.add(displayed.key); try { sessionStorage.setItem(`governance:${displayed.key}`, '1'); } catch { /* In-memory fallback. */ } setDismissed(displayed.key); };
  const dismissButton = (label: string, className: string) => <button type="button" aria-label={label} className={className} onClick={dismiss}>
    <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
  </button>;
  if (pending) return <div ref={ref} role="region" aria-label="NU7 activation countdown" className="ironwood-banner sticky top-[calc(var(--app-nav-height,4rem)+var(--app-stats-height,2.75rem))] z-40 backdrop-blur-xl">
    <div className="relative mx-auto flex h-9 max-w-7xl items-center px-4 pr-12 sm:h-10 sm:justify-center sm:px-14">
      <Link href={displayed.href} title={`NU7 activates at block #${activationHeight.toLocaleString('en-US')}`} className="group flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap font-mono text-xs text-muted transition-colors sm:flex-none sm:text-data">
        <span aria-hidden="true" className="relative flex h-1.5 w-1.5 shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-cipher-gold opacity-50 motion-safe:animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cipher-gold" />
        </span>
        <span className="font-medium text-cipher-gold">NU7</span>
        <span className="truncate text-secondary transition-colors group-hover:text-primary">{displayed.text}</span>
        <span aria-hidden="true" className="mx-1 hidden h-3 border-l border-cipher-border sm:inline" />
        <span className="hidden sm:inline"><span className="tabular-nums text-secondary">{blocksLeft.toLocaleString('en-US')}</span> {blocksLeft === 1 ? 'block' : 'blocks'} to go</span>
        <span className="ml-auto shrink-0 text-caption transition-colors group-hover:text-cipher-gold sm:ml-2">Details<span aria-hidden="true" className="ml-1 inline-block transition-transform group-hover:translate-x-0.5">→</span></span>
      </Link>
      {dismissButton('Dismiss NU7 activation countdown', 'absolute right-3 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors hover:text-primary sm:right-6 lg:right-8')}
    </div>
  </div>;
  return <div ref={ref} role="region" aria-label="Governance announcement" className="ironwood-banner sticky top-[calc(var(--app-nav-height,4rem)+var(--app-stats-height,2.75rem))] z-40 border-b border-cipher-border/50 backdrop-blur-xl">
    <div className="relative mx-auto flex min-h-10 max-w-7xl items-center justify-center px-4 pr-12 py-2 sm:px-12">
      <Link href={displayed.href} className="text-center font-mono text-xs text-brand-gold hover:underline">{displayed.text} →</Link>
      {dismissButton('Dismiss governance announcement', 'absolute right-3 flex h-8 w-8 items-center justify-center text-muted hover:text-primary')}
    </div>
  </div>;
}
