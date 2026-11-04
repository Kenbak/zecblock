'use client';

import { useState, useEffect } from 'react';
import { getApiUrl } from '@/lib/api-config';
import { isCrosslink } from '@/lib/config';
import { isCurrentCrosslinkBlockList } from '@/lib/crosslink-freshness';
import { useApiQuery } from '@/hooks/useApiQuery';

const STALE_THRESHOLD_SECONDS = 30 * 60; // 30 minutes
const POLL_INTERVAL = 60_000;

export function MaintenanceBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [status, setStatus] = useState<'checking' | 'fresh' | 'stale' | 'unavailable'>('checking');
  const [latestAge, setLatestAge] = useState<number | null>(null);
  // Shares the stats bar's tip poll instead of requesting the same block again.
  const blocksQuery = useApiQuery<Array<{ height: number | string; timestamp?: number }>>(
    '/v1/blocks',
    { limit: 1 },
    { refreshInterval: 30_000 },
  );
  // Re-evaluate age between polls so an unchanged tip still becomes stale.
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClock(value => value + 1), POLL_INTERVAL);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const evaluate = async () => {
      if (blocksQuery.error) {
        setStatus('unavailable');
        return;
      }
      const latest = blocksQuery.data?.[0];
      if (!blocksQuery.data) return;
      if (!latest?.timestamp) {
        setStatus('unavailable');
        return;
      }
      const ageSec = Math.floor(Date.now() / 1000) - latest.timestamp;
      setLatestAge(ageSec);
      if (isCrosslink && ageSec > STALE_THRESHOLD_SECONDS) {
        // Crosslink's persisted tip normally trails its live PoW tip by 100
        // blocks. Suppress this warning only when fresh health evidence proves
        // that the indexer and the displayed list match the durable state.
        try {
          const healthResponse = await fetch(`${getApiUrl()}/health/deep`);
          if (healthResponse.ok) {
            const health = await healthResponse.json();
            if (isCurrentCrosslinkBlockList(health, Number(latest.height))) {
              if (!cancelled) setStatus('fresh');
              return;
            }
          }
        } catch {
          // Fall through to the age-based state.
        }
      }
      if (!cancelled) setStatus(ageSec > STALE_THRESHOLD_SECONDS ? 'stale' : 'fresh');
    };
    void evaluate();
    return () => { cancelled = true; };
  }, [blocksQuery.data, blocksQuery.error, clock]);

  if ((status !== 'stale' && status !== 'unavailable') || dismissed) return null;

  const ageMin = latestAge ? Math.floor(latestAge / 60) : null;
  const ageStr = ageMin && ageMin >= 60
    ? `${Math.floor(ageMin / 60)}h ${ageMin % 60}m`
    : `${ageMin}m`;

  return (
    <div
      className="border-b border-warning/30 bg-warning/10 text-primary px-12 py-3 text-center text-sm font-medium relative"
      role="status"
      aria-live="polite"
    >
      <span>
        {status === 'stale'
          ? `Block data is stale — latest block is ${ageStr} old. The node may be syncing or undergoing maintenance.`
          : 'Live data freshness is unavailable. Explorer data may be stale until the API reconnects.'}
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="absolute right-1 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center text-secondary hover:text-primary transition-colors"
        aria-label="Dismiss"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
