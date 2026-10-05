import { readApiData } from '@/lib/api-client';
import Link from 'next/link';
import { SearchBar } from '@/components/SearchBar';
import { HomeBlocksProvider } from '@/components/HomeBlocksProvider';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { HomeFeedCard } from '@/components/HomeFeedCard';
import { RelativeTimeProvider } from '@/components/RelativeTime';
import { RecentMempool } from '@/components/RecentMempool';
import { CrosslinkStats } from '@/components/CrosslinkStats';
import { CrosslinkChainGraph } from '@/components/CrosslinkChainGraph.lazy';
import { StakingDayBanner } from '@/components/StakingDayBanner';
import { PulseWidget } from '@/components/PulseWidget';
import { getApiUrl } from '@/lib/api-config';
import { isCrosslink, isTestnet } from '@/lib/config';
import { fetchWithDeadline } from '@/lib/server-fetch';
import { retainLastGoodOrBuildFallback } from '@/lib/isr-fallback';
import { buildPageMetadata, getBaseUrl, getSiteCopy } from '@/lib/seo';
import type { Metadata } from 'next';

export const revalidate = 30;

const homeMetadata = buildPageMetadata({ ...getSiteCopy(), path: '/', indexOnTestnet: true });

export const metadata: Metadata = {
  ...homeMetadata,
  alternates: {
    ...homeMetadata.alternates,
    types: { 'application/rss+xml': `${getBaseUrl()}/newsletter/rss` },
  },
};

interface Block {
  height: number;
  hash: string;
  timestamp: number;
  transactions: number;
  size: number;
  finality?: string | null;
}

interface ShieldedTx {
  txid: string;
  blockHeight: number;
  blockTime: number;
  hasSapling: boolean;
  hasOrchard: boolean;
  hasIronwood: boolean;
  saplingSpendCount: number;
  saplingOutputCount: number;
  orchardActions: number;
  ironwoodActions: number;
  vinCount: number;
  voutCount: number;
  valueBalanceSapling: number;
  valueBalanceOrchard: number;
  valueBalanceIronwood: number;
  type: 'fully-shielded' | 'partial';
}

const API_URL = getApiUrl();

function upstreamError(context: string, status: number): Error {
  return new Error(`${context} returned HTTP ${status}`);
}

async function getRecentBlocks(): Promise<Block[]> {
  try {
    const response = await fetchWithDeadline(`${API_URL}/v1/blocks?limit=5`, {
      next: { revalidate: 30, tags: ['chain-tip'] },
    });

    if (!response.ok) throw upstreamError('Recent blocks', response.status);

    const data = await readApiData(response);
    if (!Array.isArray(data)) throw new Error('Recent blocks payload is malformed');
    return data.map((b: any) => ({
      height: parseInt(b.height),
      hash: b.hash,
      timestamp: parseInt(b.timestamp),
      transactions: parseInt(b.transaction_count),
      size: parseInt(b.size),
    }));
  } catch (error) {
    console.error('Error fetching blocks:', error);
    return retainLastGoodOrBuildFallback([], error, 'homepage recent blocks');
  }
}

async function getRecentShieldedTxs(): Promise<ShieldedTx[]> {
  try {
    const response = await fetchWithDeadline(`${API_URL}/v1/transactions/shielded-summary?limit=5`, {
      next: { revalidate: 30, tags: ['chain-tip'] },
    });

    if (!response.ok) throw upstreamError('Recent shielded transactions', response.status);

    const data = await readApiData(response);
    if (!Array.isArray(data.transactions)) {
      throw new Error('Recent shielded transactions payload is malformed');
    }
    return data.transactions;
  } catch (error) {
    console.error('Error fetching shielded txs:', error);
    return retainLastGoodOrBuildFallback([], error, 'homepage recent shielded transactions');
  }
}

const crosslinkMode = isCrosslink;

export default async function Home() {
  const [initialBlocks, initialShieldedTxs] = await Promise.all([
    getRecentBlocks(),
    getRecentShieldedTxs(),
  ]);

  return (
    <HomeBlocksProvider initialBlocks={initialBlocks}>
    <div className="home-page">
      {/* Full-bleed hero band. The band, not the container, owns the hero's
          vertical rhythm, and it deliberately has no border of its own, so it
          does not add a fourth chrome edge under the nav. No `overflow: hidden` here: the search suggestions
          dropdown is absolutely positioned inside and must escape the band. */}
      <section className="home-hero-band">
        {/* z-index so the search dropdown sits above the widgets below. */}
        <div className="home-hero relative z-30 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="home-introduction">
            <h1 className="text-primary">
              {crosslinkMode
                ? 'The Zcash Crosslink Explorer'
                : isTestnet
                  ? 'The Zcash Testnet Explorer (TAZ)'
                  : 'The Zcash Blockchain Explorer'}
            </h1>
            <p className="home-hero-intro text-secondary">
              {crosslinkMode
                ? 'Explore the Zcash Crosslink hybrid PoW/PoS feature net. Track finality, staking windows, validators, and blocks in real time.'
                : isTestnet
                  ? 'Search TAZ blocks, transactions, and addresses on the Zcash testnet. Monitor pending transactions and network activity before using mainnet.'
                  : 'Inspect the Zcash network. Blocks, transactions and shielded pools.'}
            </p>
          </div>

          {/* Input contents stay left-aligned inside the centred column. */}
          <div className="home-command">
            <SearchBar />
          </div>
        </div>
      </section>

      <div className="home-body max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-8 sm:pb-10 lg:pb-12">
      {/* Crosslink: Network Stats + Staking Day */}
      {crosslinkMode && (
        <div className="relative z-10 space-y-4">
          <CrosslinkStats />
          <StakingDayBanner />
          <div className="grid grid-cols-2 gap-3">
            <Link
              href="/learn/crosslink"
              className="text-xs font-mono text-muted hover:text-primary px-3 py-2.5 rounded-lg border border-white/[0.06] hover:border-cipher-gold/30 transition text-center"
            >
              Learn Crosslink →
            </Link>
            <a
              href="https://github.com/ShieldedLabs/crosslink_monolith/releases/tag/v14"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-muted hover:text-primary px-3 py-2.5 rounded-lg border border-white/[0.06] hover:border-cipher-gold/30 transition text-center"
            >
              Join v14 Round 3 →
            </a>
          </div>
        </div>
      )}

      {crosslinkMode ? (
        <>
          {/* Hero — embedded dual-chain graph (covers PoW blocks + BFT links) */}
          <div className="mt-8 sm:mt-12 lg:mt-14">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm sm:text-base font-semibold font-mono text-secondary flex items-center gap-2">
                <span className="text-muted opacity-50">{'>'}</span>
                CHAIN_VIEW
              </h2>
              <Link
                href="/chain"
                className="text-xs font-mono text-muted hover:text-primary transition-colors"
              >
                Open full view →
              </Link>
            </div>
            <CrosslinkChainGraph
              variant="embedded"
              initialBlocksToShow={15}
              height="540px"
            />
          </div>
        </>
      ) : (
        <RelativeTimeProvider initialNow={Date.now()}>
          <div className="home-feeds home-table-section grid grid-cols-1 lg:grid-cols-2 gap-8">
            <HomeFeedCard
              storageKey="cipherscan-home-card-left"
              defaultType="blocks"
            />
            <HomeFeedCard
              storageKey="cipherscan-home-card-right"
              defaultType="shielded"
              initialShieldedTxs={initialShieldedTxs}
            />
          </div>
        </RelativeTimeProvider>
      )}

      {/* Network Pulse — floating widget */}
      {!crosslinkMode && <PulseWidget />}

      {/* Pending Mempool — fixed, not customizable: always the baseline
          "what's about to confirm" view regardless of what the two cards
          above are set to. */}
      <div className="home-mempool home-table-section mt-10 sm:mt-12 lg:mt-16">
        <SectionHeader label="MEMPOOL" live size="lg" />
        <RecentMempool
          footer={
            <Link href="/mempool" className="text-xs sm:text-sm font-mono text-muted hover:text-primary transition-colors">
              View all
            </Link>
          }
        />
      </div>
      </div>
    </div>
    </HomeBlocksProvider>
  );
}
