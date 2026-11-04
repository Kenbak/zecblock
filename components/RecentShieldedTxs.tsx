'use client';

import { readApiData } from '@/lib/api-client';
import { useState, useEffect, useRef, memo, useCallback, type ReactNode } from 'react';
import { HomeFeedTableSkeleton } from '@/components/HomeFeedTableSkeleton';
import { getApiUrl } from '@/lib/api-config';
import { useWebSocket } from '@/hooks/useWebSocket';
import { RecentShieldedTable, type ShieldedTx } from '@/components/RecentShieldedTable';

interface RecentShieldedTxsProps {
  nested?: boolean;
  initialTxs?: ShieldedTx[];
  limit?: number;
  showLegend?: boolean;
  /** Rendered inside the card, below the table/legend (e.g. a "View all" link) — same slot DataTable's own `footer` prop fills. */
  footer?: ReactNode;
}

export const RecentShieldedTxs = memo(function RecentShieldedTxs({
  nested = false,
  initialTxs = [],
  limit = 5,
  showLegend = true,
  footer,
}: RecentShieldedTxsProps) {
  const [txs, setTxs] = useState<ShieldedTx[]>(initialTxs);
  const [loading, setLoading] = useState(initialTxs.length === 0);
  const latestKey = useRef(initialTxs[0]?.txid ?? '');
  const loadedOnce = useRef(initialTxs.length > 0);
  const latestBlockHeight = useRef(initialTxs[0]?.blockHeight ?? 0);
  const fetchRef = useRef<() => void>(() => {});

  const fetchTxs = useCallback(async () => {
    try {
      const apiUrl = `${getApiUrl()}/v1/transactions/shielded-summary?limit=${limit}`;

      const response = await fetch(apiUrl);
      const data = await readApiData(response);
      if (data.transactions?.length) {
        const newTopTxid = data.transactions[0]?.txid;
        if (newTopTxid !== latestKey.current) {
          latestKey.current = newTopTxid;
          latestBlockHeight.current = data.transactions[0]?.blockHeight ?? 0;
          setTxs(data.transactions);
        }
      }
    } catch (error) {
      console.error('Error fetching shielded transactions:', error);
    } finally {
      if (!loadedOnce.current) {
        loadedOnce.current = true;
        setLoading(false);
      }
    }
  }, [limit]);

  fetchRef.current = fetchTxs;

  const handleWsMessage = useCallback((msg: any) => {
    if (msg.type === 'new_block' || msg.type === 'chain_tip') {
      const height = msg.data?.height;
      if (height && height > latestBlockHeight.current) {
        fetchRef.current();
      }
    }
  }, []);

  const { isConnected: wsConnected } = useWebSocket({ onMessage: handleWsMessage });

  useEffect(() => {
    if (initialTxs.length === 0) {
      fetchTxs();
    }

    const interval = setInterval(fetchTxs, wsConnected ? 60000 : 10000);
    return () => clearInterval(interval);
  }, [initialTxs.length, wsConnected, fetchTxs]);

  if (loading) {
    return <HomeFeedTableSkeleton rows={limit} footer={footer} nested={nested} />;
  }

  return (
    <RecentShieldedTable txs={txs} footer={footer} nested={nested} showLegend={showLegend} />
  );
});
