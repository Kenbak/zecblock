'use client';

import { readApiData } from '@/lib/api-client';
import { useState, useEffect, useRef, memo, useCallback, type ReactNode } from 'react';
import { parseTransactionListItems, type TransactionListItem as Tx } from '@/lib/transaction-list';
import { HomeFeedTableSkeleton } from '@/components/HomeFeedTableSkeleton';
import { getApiUrl } from '@/lib/api-config';
import { useWebSocket } from '@/hooks/useWebSocket';
import { RecentTransactionsTable } from '@/components/RecentTransactionsTable';


/**
 * Homepage-sized "recent transactions" widget — TxID / Flow / Amount / Age,
 * deliberately matching RecentShieldedTxs's own column layout (not the
 * fuller Type+Flow+Block+Size /txs uses) so the two homepage cards read as
 * one coherent design, not two differently-shaped tables.
 */
export const RecentTransactions = memo(function RecentTransactions({
  limit = 5,
  footer,
}: {
  limit?: number;
  /** Rendered inside the card, below the table (e.g. a "View all" link) — same slot DataTable's own `footer` prop fills. */
  footer?: ReactNode;
}) {
  const [txs, setTxs] = useState<Tx[]>([]);
  const [loading, setLoading] = useState(true);
  const latestKey = useRef('');
  const loadedOnce = useRef(false);
  const fetchRef = useRef<() => void>(() => {});

  const fetchLatest = useCallback(async () => {
    try {
      const apiUrl = `${getApiUrl()}/v1/transactions?limit=${limit}`;

      const response = await fetch(apiUrl);
      const transactions = parseTransactionListItems(await readApiData(response));
      if (transactions.length) {
        const newTop = transactions[0].txid;
        if (newTop !== latestKey.current) {
          latestKey.current = newTop;
          setTxs(transactions);
        }
      }
    } catch (error) {
      console.error('Error fetching recent transactions:', error);
    } finally {
      if (!loadedOnce.current) {
        loadedOnce.current = true;
        setLoading(false);
      }
    }
  }, [limit]);

  fetchRef.current = fetchLatest;

  const handleWsMessage = useCallback((msg: any) => {
    if (msg.type === 'new_block' || msg.type === 'chain_tip') {
      fetchRef.current();
    }
  }, []);

  const { isConnected: wsConnected } = useWebSocket({ onMessage: handleWsMessage });

  useEffect(() => {
    fetchLatest();
    const interval = setInterval(fetchLatest, wsConnected ? 60000 : 10000);
    return () => clearInterval(interval);
  }, [wsConnected, fetchLatest]);

  if (loading) {
    return <HomeFeedTableSkeleton rows={limit} footer={footer} />;
  }

  return (
    <RecentTransactionsTable txs={txs} footer={footer} />
  );
});
