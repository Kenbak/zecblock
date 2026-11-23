'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { isMainnet, isCrosslink, NETWORK } from '@/lib/config';
import type { Announcement } from '@/lib/governance';
import type { AnnouncementSnapshot } from '@/lib/governance-announcement';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ANNOUNCED_MAINNET_NU7, readUpgradeSnapshot, getPendingNu7Upgrade, estimateBlockArrival, formatUpgradeTime } from '@/lib/network-upgrades';

// Rendered as the first item of the stats bar, whose height is fixed, so an
// announcement arriving after load never pushes the page down. The data stays
// client-side: static pages keep their build-once caching.
export function GovernanceBanner() {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const dismissedKeys = useRef(new Set<string>());
  const { data, error } = useApiQuery<unknown>('/v1/network/stats', undefined, { enabled: !isCrosslink, refreshInterval: 30_000 });
  const network = NETWORK === 'crosslink' ? 'crosslink-testnet' : NETWORK;
  const lastVerifiedSnapshot = readUpgradeSnapshot(data, network);
  const snapshot = error ? null : lastVerifiedSnapshot;
  const candidate = getPendingNu7Upgrade(network, lastVerifiedSnapshot);
  // The editorial NU7 date has passed (mainnet activated at the announced block),
  // so an API outage must not resurrect the pre-activation announcement.
  const announcementLapsed = Date.now() > Date.parse(`${ANNOUNCED_MAINNET_NU7.date}T00:00:00Z`) + 7 * 86_400_000;
  const pending = candidate?.upgrade.authority === 'announcement' ? (announcementLapsed ? null : candidate) : !error ? candidate : null;
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
  if (!visible || !displayed) return null;
  const rich = !pending && announcement && (announcement.snapshotHeight !== undefined || announcement.hint) ? announcement : null;
  const snapshotHeightNow = snapshot?.height ?? null;
  const snapshotEta = rich?.snapshotHeight !== undefined && snapshot ? estimateBlockArrival(snapshot, rich.snapshotHeight) : null;
  const label = announced ? 'NU7 announced mainnet upgrade' : pending ? 'NU7 activation countdown' : 'Governance announcement';
  const detail = pending
    ? <>{announced ? <>Block <span className="tabular-nums">#{pending.height.toLocaleString('en-US')}</span> · </> : null}
        {blocksRemaining === null ? 'Live progress unavailable' : <><span className="tabular-nums">{blocksRemaining.toLocaleString('en-US')}</span> {blocksRemaining === 1 ? 'block' : 'blocks'} to go</>}</>
    : rich?.snapshotHeight !== undefined && snapshotHeightNow !== null
      ? (rich.snapshotHeight > snapshotHeightNow
        ? <><span className="tabular-nums">{(rich.snapshotHeight - snapshotHeightNow).toLocaleString('en-US')}</span> blocks to go{snapshotEta ? ` · ≈ ${formatUpgradeTime(snapshotEta.seconds)}` : ''}</>
        : 'Snapshot taken · voting opens soon')
      : null;
  return <span role="region" aria-label={label} className="flex shrink-0 items-center gap-3 sm:gap-4">
    <span className="flex items-center gap-1 whitespace-nowrap font-mono text-xs sm:text-data">
      <Link href={displayed.href} prefetch={false} className="text-brand-gold hover:underline">
        {displayed.text}{detail ? <span className="text-secondary"> · {detail}</span> : null}
        {rich?.hint ? <span className="hidden text-muted lg:inline"> · {rich.hint}</span> : null} →
      </Link>
      <button aria-label={announced ? 'Dismiss NU7 announcement' : pending ? 'Dismiss NU7 activation countdown' : 'Dismiss governance announcement'} className="flex h-6 w-6 items-center justify-center text-muted hover:text-primary" onClick={() => { dismissedKeys.current.add(displayed.key); try { sessionStorage.setItem(`governance:${displayed.key}`, '1'); } catch { /* In-memory fallback. */ } setDismissed(displayed.key); }}>×</button>
    </span>
    <span aria-hidden="true" className="h-3 border-l border-cipher-border mx-0.5 sm:mx-0" />
  </span>;
}
