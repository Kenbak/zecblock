'use client';

import { readApiData } from '@/lib/api-client';
import { useCallback, useEffect, useRef, useState, memo, type ReactNode } from 'react';
import { getApiUrl } from '@/lib/api-config';
import { SkeletonTable } from '@/components/ui';
import { PoolLogo } from '@/components/PoolLogo';

interface PoolRankingEntry {
  rank: number;
  name: string;
  url: string | null;
  blocks: number;
  share: number;
}

/**
 * Homepage-sized "top miners" widget — same card/table/footer shape as the
 * other Customize options. /v1/mining/pool-ranking has no server-side
 * `limit`, so the top 5 are sliced client-side (same as /mining itself would
 * need to for any "top N" view).
 */
export const TopMiners = memo(function TopMiners({ footer }: { footer?: ReactNode } = {}) {
  const [pools, setPools] = useState<PoolRankingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const loadedOnce = useRef(false);

  const fetchRanking = useCallback(async () => {
    try {
      const apiUrl = `${getApiUrl()}/v1/mining/pool-ranking?period=24h`;

      const response = await fetch(apiUrl);
      const data = await readApiData(response);
      if (Array.isArray(data.ranking)) {
        setPools(data.ranking.slice(0, 5));
      }
    } catch (error) {
      console.error('Error fetching pool ranking:', error);
    } finally {
      if (!loadedOnce.current) {
        loadedOnce.current = true;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchRanking();
    // Ranking is a 24h rollup cached server-side for 5 minutes — no need for
    // websocket-driven refresh like the per-block/per-tx feeds.
    const interval = setInterval(fetchRanking, 60000);
    return () => clearInterval(interval);
  }, [fetchRanking]);

  if (loading) {
    return (
      <div className="card p-0 overflow-hidden">
        <SkeletonTable rows={5} rowHeight="h-12" headers={["Rank", "Pool", "Blocks", "Share"]} />
        {footer && <div className="px-4 py-3 border-t border-cipher-border text-center">{footer}</div>}
      </div>
    );
  }

  if (pools.length === 0) {
    return (
      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-8 text-center text-sm text-muted font-mono">
          No mining activity in the last 24h
        </div>
        {footer && <div className="px-4 py-3 border-t border-cipher-border text-center">{footer}</div>}
      </div>
    );
  }

  return (
    <div className="card p-0 overflow-hidden">
      <div className="overflow-x-auto no-scrollbar">
        <table className="w-full min-w-[380px]">
          <thead>
            <tr>
              <th className="px-4 sm:px-5 py-3.5 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border w-8">#</th>
              <th className="px-4 sm:px-5 py-3.5 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Pool</th>
              <th className="px-4 sm:px-5 py-3.5 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Blocks</th>
              <th className="px-4 sm:px-5 py-3.5 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Share</th>
            </tr>
          </thead>
          <tbody>
            {pools.map((pool, i) => (
              <tr
                key={`${pool.rank}-${pool.name}`}
                className="group transition-colors duration-100 hover:bg-cipher-hover animate-fade-in-up"
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <td className="px-4 sm:px-5 h-12 border-b border-cipher-border">
                  <span className="font-mono text-xs text-muted tabular-nums">{pool.rank}</span>
                </td>
                <td className="px-4 sm:px-5 h-12 border-b border-cipher-border">
                  <div className="flex items-center gap-2">
                    <PoolLogo name={pool.name} />
                    {pool.url ? (
                      <a
                        href={pool.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-w-0 font-mono text-sm font-medium text-primary hover:underline transition-colors truncate"
                      >
                        {pool.name}
                      </a>
                    ) : (
                      <span className="min-w-0 font-mono text-sm font-medium text-primary truncate">{pool.name}</span>
                    )}
                  </div>
                </td>
                <td className="px-4 sm:px-5 h-12 border-b border-cipher-border text-right">
                  <span className="font-mono text-sm text-secondary tabular-nums">{pool.blocks.toLocaleString()}</span>
                </td>
                <td className="px-4 sm:px-5 h-12 border-b border-cipher-border text-right">
                  <span className="font-mono text-sm text-primary tabular-nums">{(pool.share * 100).toFixed(1)}%</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer && <div className="px-4 py-3 border-t border-cipher-border text-center">{footer}</div>}
    </div>
  );
});
