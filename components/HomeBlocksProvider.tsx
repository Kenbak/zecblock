'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { readApiData } from '@/lib/api-client';
import { getApiUrl } from '@/lib/api-config';
import { fetchLiveResponse, startLiveRefresh } from '@/lib/live-refresh';
import { useWebSocket } from '@/hooks/useWebSocket';

export interface HomeBlock {
  height: number;
  hash: string;
  timestamp: number;
  transactions: number;
  size: number;
}

function parseBlock(value: Record<string, unknown>): HomeBlock {
  const block = {
    height: Number(value.height ?? value.block_height),
    hash: typeof value.hash === 'string' ? value.hash.toLowerCase() : '',
    timestamp: Number(value.timestamp ?? value.block_time),
    transactions: Number(value.transaction_count ?? value.transactions ?? 0),
    size: Number(value.size ?? 0),
  };
  if (!/^[a-f0-9]{64}$/.test(block.hash) || !Number.isSafeInteger(block.height) || block.height < 0 ||
      !Number.isFinite(block.timestamp) || block.timestamp <= 0 ||
      !Number.isSafeInteger(block.transactions) || block.transactions < 0 || !Number.isFinite(block.size) || block.size < 0) {
    throw new Error('Invalid block snapshot');
  }
  return block;
}

const CONNECT_REFRESH_GRACE_MS = 5_000;

const HomeBlocksContext = createContext<{ blocks: HomeBlock[]; loading: boolean } | null>(null);

/** One accepted API snapshot for the hero and every customizable block card. */
export function HomeBlocksProvider({ initialBlocks, children }: { initialBlocks: HomeBlock[]; children: ReactNode }) {
  const [blocks, setBlocks] = useState(initialBlocks);
  const [loading, setLoading] = useState(initialBlocks.length === 0);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const lastSuccessAt = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const fetchLatest = useCallback(async () => {
    if (inFlight.current || document.hidden) return;
    inFlight.current = true;
    try {
      const data = await fetchLiveResponse(`${getApiUrl()}/v1/blocks?limit=5`, readApiData<unknown>);
      if (!Array.isArray(data) || data.length === 0) throw new Error('Block data unavailable');
      const snapshot = data.map(value => {
        if (!value || typeof value !== 'object') throw new Error('Invalid block snapshot');
        return parseBlock(value);
      });
      lastSuccessAt.current = Date.now();
      if (mounted.current) setBlocks(snapshot);
    } catch (error) {
      // Keep the same last-good snapshot in both surfaces during upstream failures.
      console.error('Error fetching blocks:', error);
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  useWebSocket({
    onMessage: message => {
      if (message.type === 'new_block' || message.type === 'chain_tip') void fetchLatest();
    },
    // The mount refresh usually lands just before the socket connects; new
    // blocks always refetch, so a snapshot from the last few seconds is current.
    onConnect: () => {
      if (Date.now() - lastSuccessAt.current > CONNECT_REFRESH_GRACE_MS) void fetchLatest();
    },
  });
  useEffect(() => startLiveRefresh(fetchLatest), [fetchLatest]);

  const value = useMemo(() => ({ blocks, loading }), [blocks, loading]);
  return <HomeBlocksContext.Provider value={value}>{children}</HomeBlocksContext.Provider>;
}

export function useHomeBlocks() {
  const value = useContext(HomeBlocksContext);
  if (!value) throw new Error('HomeBlocksProvider is required');
  return value;
}
