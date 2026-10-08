'use client';

import { readApiData } from '@/lib/api-client';
import { useState, useEffect, useRef } from 'react';
import { getApiUrl } from '@/lib/api-config';
import { getCoinbaseClientEmoji, getCoinbaseClientInfo } from '@/lib/coinbase-client';
import {
  BlockPageSkeleton,
  BlockPageError,
  OrphanedBlockBanner,
  BlockPageHeader,
  NetworkUpgradeBanner,
  BlockFactsCard,
  BlockTransactionsSection,
  transformExpressBlockData,
  type BlockData,
  type BlockPageClientProps,
} from './components';

export type { BlockPageSummary } from './components';

export default function BlockPageClient({
  identifier,
  initialSummary,
}: BlockPageClientProps) {
  const height = identifier;
  const [data, setData] = useState<BlockData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<'not-found' | 'unavailable' | null>(null);
  const [showMoreDetails, setShowMoreDetails] = useState(false);
  const txSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Block request timed out', 'TimeoutError')),
      15_000,
    );

    const fetchData = async () => {
      try {
        setLoading(true);
        setLoadError(null);

        const apiUrl = `${getApiUrl()}/v1/blocks/${height}`;

        const response = await fetch(apiUrl, { signal: controller.signal });

        if (response.status === 404 || response.status === 410) {
          setData(null);
          setLoadError('not-found');
          return;
        }

        if (!response.ok) {
          throw new Error(`Block API returned ${response.status}`);
        }

        const blockData = await readApiData(response);

        setData(transformExpressBlockData(blockData));
      } catch (error) {
        // Navigation and development Strict Mode cancel obsolete requests.
        // Only a timeout or real request failure should change the page state.
        if (controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError') return;
        console.error('Error fetching block:', error);
        setData(null);
        setLoadError('unavailable');
      } finally {
        clearTimeout(timeout);
        if (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError') setLoading(false);
      }
    };

    fetchData();
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [height]);

  const scrollToTransactions = () => {
    txSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (loading) {
    return <BlockPageSkeleton identifier={identifier} initialSummary={initialSummary} />;
  }

  if (!data) {
    return (
      <BlockPageError
        identifier={identifier}
        initialSummary={initialSummary}
        loadError={loadError}
      />
    );
  }

  const coinbaseClientEmoji = getCoinbaseClientEmoji(data.coinbaseHex);
  const coinbaseClientInfo = getCoinbaseClientInfo(data.coinbaseHex);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 md:py-8 animate-fade-in">
      <OrphanedBlockBanner data={data} />
      <BlockPageHeader data={data} />
      <NetworkUpgradeBanner data={data} />
      <BlockFactsCard
        data={data}
        showMoreDetails={showMoreDetails}
        onToggleMoreDetails={() => setShowMoreDetails(!showMoreDetails)}
        onScrollToTransactions={scrollToTransactions}
        coinbaseClientEmoji={coinbaseClientEmoji}
        coinbaseClientInfo={coinbaseClientInfo}
      />
      <BlockTransactionsSection ref={txSectionRef} data={data} />
    </div>
  );
}
