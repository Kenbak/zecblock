'use client';

import { readApiData } from '@/lib/api-client';
import { useState, useEffect, useCallback } from 'react';
import { getApiUrl } from '@/lib/api-config';
import { isCrosslink } from '@/lib/config';
import { isCurrentCrosslinkBlockList } from '@/lib/crosslink-freshness';

const STALE_THRESHOLD_SECONDS = 30 * 60; // 30 minutes
const POLL_INTERVAL = 60_000;

export function MaintenanceBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [status, setStatus] = useState<'checking' | 'fresh' | 'stale' | 'unavailable'>('checking');
  const [latestAge, setLatestAge] = useState<number | null>(null);

  const checkStaleness = useCallback(async () => {
    try {
      const API_URL = getApiUrl();
      const res = await fetch(`${API_URL}/v1/blocks?limit=1`);
      if (!res.ok) {
        setStatus('unavailable');
        return;
      }
      const data = await readApiData(res);
      const latest = data?.[0];
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
        const healthResponse = await fetch(`${API_URL}/health/deep`);
        if (healthResponse.ok) {
          const health = await healthResponse.json();
          if (isCurrentCrosslinkBlockList(health, latest.height)) {
            setStatus('fresh');
            return;
          }
        }
      }
      setStatus(ageSec > STALE_THRESHOLD_SECONDS ? 'stale' : 'fresh');
    } catch {
      setStatus('unavailable');
    }
  }, []);

  useEffect(() => {
    checkStaleness();
    const id = setInterval(checkStaleness, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [checkStaleness]);

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
