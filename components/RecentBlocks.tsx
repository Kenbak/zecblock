'use client';

import { memo, type ReactNode } from 'react';
import { HomeFeedTableSkeleton } from '@/components/HomeFeedTableSkeleton';
import { useHomeBlocks } from '@/components/HomeBlocksProvider';
import { RecentBlocksTable } from '@/components/RecentBlocksTable';

export const RecentBlocks = memo(function RecentBlocks({ footer }: { footer?: ReactNode }) {
  const { blocks, loading } = useHomeBlocks();

  if (loading) {
    return <HomeFeedTableSkeleton rows={5} footer={footer} />;
  }

  return <RecentBlocksTable blocks={blocks} footer={footer} />;
});
