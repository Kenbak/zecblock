'use client';

import dynamic from 'next/dynamic';

interface CrosslinkChainGraphProps {
  initialBlocksToShow?: number;
  /** 'full' = standalone /chain page, 'embedded' = drop-in for homepage */
  variant?: 'full' | 'embedded';
  /** Override canvas height (px or any CSS length). Defaults to viewport-aware sizing. */
  height?: string;
}

const LazyCrosslinkChainGraph = dynamic(
  () => import('./CrosslinkChainGraph').then((mod) => mod.CrosslinkChainGraph),
  {
    ssr: false,
    loading: () => (
      <div
        className="h-[540px] w-full rounded-2xl border border-cipher-border bg-cipher-surface animate-pulse"
        role="status"
        aria-live="polite"
      >
        <span className="sr-only">Loading Crosslink chain graph…</span>
      </div>
    ),
  },
);

/**
 * Dynamically-imported wrapper for `CrosslinkChainGraph`.
 *
 * `CrosslinkChainGraph` pulls in `@xyflow/react` — meaningful
 * bundle weight that most deployments (mainnet, testnet) never exercise,
 * since Crosslink runs as its own dedicated network deployment. Importing
 * the real component statically from the homepage meant every mainnet/
 * testnet homepage bundle paid for that weight even though `crosslinkMode`
 * is always false there. This wrapper (same export name, drop-in
 * replacement for the direct import) code-splits it into its own chunk
 * that's only fetched when actually rendered — i.e. never on mainnet/testnet,
 * and lazily below the fold on the Crosslink homepage / `/chain` page.
 */
export function CrosslinkChainGraph(props: CrosslinkChainGraphProps) {
  return <LazyCrosslinkChainGraph {...props} />;
}
