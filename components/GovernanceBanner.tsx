'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { isMainnet, isCrosslink, NETWORK } from '@/lib/config';
import type { Announcement } from '@/lib/governance';
import type { AnnouncementSnapshot } from '@/lib/governance-announcement';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ANNOUNCED_MAINNET_NU7, readUpgradeSnapshot, getPendingNu7Upgrade, estimateBlockArrival, formatUpgradeTime } from '@/lib/network-upgrades';

export function GovernanceBanner() {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const dismissedKeys = useRef(new Set<string>());
  const ref = useRef<HTMLDivElement>(null);
  const { data, error } = useApiQuery<unknown>('/v1/network/stats', undefined, { enabled: !isCrosslink, refreshInterval: 30_000 });
  const network = NETWORK === 'crosslink' ? 'crosslink-testnet' : NETWORK;
  const lastVerifiedSnapshot = readUpgradeSnapshot(data, network);
  const snapshot = error ? null : lastVerifiedSnapshot;
  const candidate = getPendingNu7Upgrade(network, lastVerifiedSnapshot);
  const pending = candidate?.upgrade.authority === 'announcement' || !error ? candidate : null;
  const announced = pending?.upgrade.authority === 'announcement';
  const estimate = pending ? estimateBlockArrival(snapshot, pending.height) : null;
  const blocksRemaining = pending && snapshot ? pending.height - snapshot.height : null;
  const displayed = pending ? {
    key: `nu7:${network}:${pending.height}:${pending.upgrade.authority}`,
    href: `/block/${pending.height}`,
    text: announced ? `NU7 announced · ${ANNOUNCED_MAINNET_NU7.dateLabel}`
      : estimate ? `NU7 arrives in about ${formatUpgradeTime(estimate.seconds)}` : 'NU7 is on its way',
  } : announcement;
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
    let inFlight = false;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      const startedAt = performance.now();
      try {
        const response = await fetch('/api/governance/announcement', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        if (!response.ok) throw new Error('Unavailable');
        const { announcement: next, generatedAt, nextChangeAt } = await response.json() as AnnouncementSnapshot;
        if (controller.signal.aborted) return;
        clearTimeout(expiryTimer);
        // A CDN hit must retain the original deadline. Account for its Age and
        // transfer time as well as the wall clock, so polling cannot extend a
        // closing vote or a results announcement past its known window.
        const age = Math.max(0, Number(response.headers.get('Age')) || 0) * 1000;
        const remaining = nextChangeAt === null ? null : Math.min(
          nextChangeAt - Date.now(),
          nextChangeAt - generatedAt - age - (performance.now() - startedAt),
        );
        if (remaining !== null && (!Number.isFinite(remaining) || remaining <= 0)) {
          setAnnouncement(null);
          return;
        }
        setAnnouncement(next);
        if (remaining !== null) expiryTimer = setTimeout(() => {
          setAnnouncement(null);
          void refresh();
        }, Math.min(remaining, 2_147_483_647));
      } catch {
        if (!controller.signal.aborted) {
          clearTimeout(expiryTimer);
          setAnnouncement(null);
        }
      } finally { inFlight = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { controller.abort(); clearInterval(timer); clearTimeout(expiryTimer); document.removeEventListener('visibilitychange', refresh); };
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
  return <div ref={ref} role="region" aria-label={announced ? 'NU7 announced mainnet upgrade' : pending ? 'NU7 activation countdown' : 'Governance announcement'} className="ironwood-banner sticky top-[calc(var(--app-nav-height,4rem)+var(--app-stats-height,2.75rem))] z-40 border-b border-cipher-border/50 backdrop-blur-xl">
    <div className="relative mx-auto flex min-h-12 max-w-7xl items-center justify-center px-4 pr-12 py-2.5 sm:px-12">
      <Link href={displayed.href} prefetch={false} className={pending ? 'group flex items-center gap-3' : 'text-center font-mono text-xs text-brand-gold hover:underline'}>
        {pending ? <>
          <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cipher-gold/20 bg-cipher-gold/10 text-cipher-gold">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
          </span>
          <span className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-4">
            <span className="text-sm font-medium text-primary group-hover:text-cipher-gold transition-colors">{displayed.text}</span>
            <span className="text-xs text-secondary">
              {announced ? <>Block <span className="tabular-nums">#{pending.height.toLocaleString('en-US')}</span> · </> : null}
              {blocksRemaining === null ? 'Live progress unavailable' : <><span className="tabular-nums">{blocksRemaining.toLocaleString('en-US')}</span> {blocksRemaining === 1 ? 'block' : 'blocks'} to go</>}
            </span>
          </span>
          <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-cipher-gold transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14m-6-6 6 6-6 6" /></svg>
        </> : <>{displayed.text} →</>}
      </Link>
      <button aria-label={announced ? 'Dismiss NU7 announcement' : pending ? 'Dismiss NU7 activation countdown' : 'Dismiss governance announcement'} className="absolute right-3 flex h-8 w-8 items-center justify-center text-muted hover:text-primary" onClick={() => { dismissedKeys.current.add(displayed.key); try { sessionStorage.setItem(`governance:${displayed.key}`, '1'); } catch { /* In-memory fallback. */ } setDismissed(displayed.key); }}>×</button>
    </div>
  </div>;
}
