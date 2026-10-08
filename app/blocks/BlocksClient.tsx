'use client';

import { readApiData } from '@/lib/api-client';
import { useState, useEffect } from 'react';
import { LiveRefreshStatus } from '@/components/LiveRefreshStatus';
import Link from 'next/link';
import { PageHeader, MetricCard, DataTable, HashLink, type DataTableColumn } from '@/components/ui';
import { formatRelativeTime, formatBlockInterval } from '@/lib/utils';
import { zatToZec } from '@/lib/format-numbers';
import { getApiUrl } from '@/lib/api-config';
import { Pagination } from '@/components/Pagination';
import { usePaginatedList, type BasePaginationState } from '@/hooks/usePaginatedList';
import { BlockFilters, type BlockFilterValues } from './BlockFilters';
import { SOFTWARE_LABELS, classifyMiningSoftware, type MiningSoftware } from '@/lib/mining-software';
import { getMiningSoftwareEmoji } from '@/lib/coinbase-client';
import { Tooltip } from '@/components/Tooltip';
import { CURRENCY, isTestnet } from '@/lib/config';
import { scheduledSeconds, type BlockSchedule } from '@/lib/block-timing';
import { Tabs } from '@/components/ui/Tabs';
import { CoinbaseMessage } from '@/components/CoinbaseMessage';

interface Block {
  software?: MiningSoftware;
  intervalSeconds?: number | null;
  height: number;
  hash: string;
  timestamp: number;
  transaction_count: number;
  size: number;
  difficulty: number;
  finality_status?: string | null;
  miner_pool?: string | null;
  coinbase_hex?: string | null;
  total_fees?: number | string | null;
}

const PAGE_SIZE = 25;

// Consensus serialized block-size limit, in decimal bytes (2 MB).
const MAX_BLOCK_BYTES = 2_000_000;
const INTERVAL_SCALE_SECONDS = 300;
type BlocksView = 'overview' | 'coinbase';
const VIEW_STORAGE_KEY = 'zecblock:blocks-view:v1';
const BLOCK_VIEWS: { id: BlocksView; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'coinbase', label: 'Coinbase messages' },
];

function MinerIdentity({ block }: { block: Block }) {
  const software = block.software ?? classifyMiningSoftware(block.coinbase_hex);
  return (
    <div className="font-mono text-xs">
      <p className={block.miner_pool ? 'text-primary' : 'text-muted'}>{block.miner_pool || 'Unattributed'}</p>
      <p className="mt-1 text-muted" title="Self-reported coinbase marker; not authenticated software identity">
        {getMiningSoftwareEmoji(software)} {SOFTWARE_LABELS[software]}
      </p>
    </div>
  );
}

function coinbaseColumns(blocks: Block[], trailingBlock: Block | null, schedule: BlockSchedule | null): DataTableColumn<Block>[] {
  const overview = blockColumns(blocks, trailingBlock, schedule);
  const height = overview[0];
  const age = overview[overview.length - 1];
  const transactions = overview.find((column) => column.id === 'txs')!;
  const size = overview.find((column) => column.id === 'size')!;
  return [
    {
      ...height,
      className: 'align-top py-3 sm:align-middle sm:py-0',
      cell: (block, index) => (
        <div>
          {height.cell(block, index)}
          <div className="sm:hidden mt-2 space-y-2">
            <MinerIdentity block={block} />
            <CoinbaseMessage hex={block.coinbase_hex} />
            <p className="font-mono text-xs text-muted tabular-nums">
              {block.transaction_count.toLocaleString()} txs · {Number.isFinite(block.size) && block.size >= 0 ? `${(block.size / 1000).toFixed(1)} kB` : 'Size unavailable'}
            </p>
          </div>
        </div>
      ),
    },
    {
      id: 'miner',
      header: 'Miner / software',
      className: 'hidden sm:table-cell whitespace-nowrap',
      skeletonWidth: 'w-28',
      cell: (block) => <MinerIdentity block={block} />,
    },
    {
      id: 'message',
      header: 'Coinbase message',
      className: 'hidden sm:table-cell w-full min-w-64 py-3',
      skeletonWidth: 'w-64',
      cell: (block) => <CoinbaseMessage hex={block.coinbase_hex} />,
    },
    { ...transactions, header: 'Transactions', className: 'hidden md:table-cell whitespace-nowrap' },
    { ...size, className: 'hidden lg:table-cell min-w-[10rem]' },
    { ...age, className: 'align-top py-3 sm:align-middle sm:py-0 whitespace-nowrap' },
  ];
}

/** Column defs close over the block list because interval computation needs
 *  each row's successor (and the trailing block beyond the page boundary). */
function blockColumns(blocks: Block[], trailingBlock: Block | null, schedule: BlockSchedule | null): DataTableColumn<Block>[] {
  return [
    {
      id: 'height',
      header: 'Height',
      className: 'whitespace-nowrap',
      skeletonWidth: 'w-24',
      cell: (block) => (
        <div className="flex items-center gap-2">
          <Link href={`/block/${block.height}`} className="font-mono text-sm text-primary hover:text-primary transition-colors">
            {block.height.toLocaleString()}
          </Link>
          {block.finality_status === 'Finalized' && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-cipher-green/70" title="Finalized" />
          )}
        </div>
      ),
    },
    {
      id: 'hash',
      header: 'Hash',
      className: 'hidden sm:table-cell whitespace-nowrap',
      skeletonWidth: 'w-40',
      cell: (block) => (
        // Same lead/tail convention as every other hash display (e.g. the
        // block detail page's CopyableHash) — a block hash's leading zeros
        // (from proof-of-work) aren't distinguishing, but keeping the same
        // truncation shape everywhere matters more than trying to skip past
        // them here. The old plain CSS `truncate` on a fixed-width column
        // just clipped wherever the pixel width ran out, so it kept a
        // different number of characters depending on font/zoom instead of a
        // consistent, predictable lead+tail.
        <HashLink value={block.hash} href={`/block/${block.height}`} lead={10} tail={8} copy={false} linkClassName="font-mono text-xs text-muted hover:text-secondary transition-colors" />
      ),
    },
    {
      id: 'miner',
      header: 'Miner',
      className: 'hidden lg:table-cell whitespace-nowrap',
      skeletonWidth: 'w-16',
      cell: (block) => {
        return (
          <div className="flex items-center gap-1.5">
            {block.miner_pool ? (
              <span className="text-xs font-mono text-primary">{block.miner_pool}</span>
            ) : (
              <span className="text-xs font-mono text-muted" title="No identified mining pool; the payout may be shielded">Unattributed</span>
            )}
          </div>
        );
      },
    },
    {
      id:'software', header:'Software marker', className:'hidden md:table-cell',
      cell: (block) => {
        const software = block.software ?? classifyMiningSoftware(block.coinbase_hex);
        return (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-xs text-secondary" title="Self-reported coinbase marker; not authenticated software identity">
            <span aria-hidden>{getMiningSoftwareEmoji(software)}</span>
            {SOFTWARE_LABELS[software]}
          </span>
        );
      },
    },
    {
      id: 'txs',
      header: 'Txs',
      align: 'right',
      className: 'min-w-16 whitespace-nowrap',
      skeletonWidth: 'w-8',
      cell: (block) => <span className="font-mono text-sm text-primary tabular-nums">{block.transaction_count}</span>,
    },
    {
      id: 'size',
      header: 'Size / 2 MB',
      align: 'right',
      className: 'hidden md:table-cell min-w-[10rem]',
      skeletonWidth: 'w-16',
      cell: (block) => {
        if (!Number.isFinite(block.size) || block.size < 0) {
          return <span className="font-mono text-xs text-muted" title="Block size unavailable">—</span>;
        }
        const sizePct = (block.size / MAX_BLOCK_BYTES) * 100;
        const capacity = `${sizePct > 0 && sizePct < 0.01 ? '<0.01' : sizePct.toFixed(2)}% of the 2 MB limit (${block.size.toLocaleString('en-US')} / 2,000,000 bytes)`;
        return (
          <div className="grid grid-cols-[3rem_4.5rem] items-center justify-end gap-3" title={capacity}>
            <div aria-hidden="true" className="w-12 h-1 rounded-full bg-cipher-border-alpha/40 overflow-hidden">
              <div
                className="h-full rounded-full bg-brand-gold/60 group-hover:bg-brand-gold transition-colors"
                style={{ width: `${Math.min(100, sizePct)}%` }}
              />
            </div>
            <span className="font-mono text-xs text-muted tabular-nums whitespace-nowrap text-right">
              {(block.size / 1000).toFixed(1)} kB
            </span>
          </div>
        );
      },
    },
    {
      id: 'fees',
      header: 'Fees',
      align: 'right',
      className: 'hidden lg:table-cell',
      skeletonWidth: 'w-14',
      cell: (block) => {
        if (block.total_fees == null) return <span className="font-mono text-xs text-muted">—</span>;
        const feeZec = zatToZec(block.total_fees);
        return (
          <span className="font-mono text-xs text-muted tabular-nums">
            {feeZec < 0.001 ? feeZec.toFixed(5) : feeZec.toFixed(4)} {CURRENCY}
          </span>
        );
      },
    },
    {
      id: 'interval',
      header: 'Block interval',
      align: 'right',
      className: 'hidden lg:table-cell min-w-[10rem]',
      skeletonWidth: 'w-12',
      cell: (block, idx) => {
        const nextBlock = blocks[idx + 1] ?? (idx === blocks.length - 1 ? trailingBlock : null);
        const gap = block.intervalSeconds ?? (nextBlock && Number(nextBlock.height) === Number(block.height) - 1 ? block.timestamp - nextBlock.timestamp : null);
        if (gap === null || !Number.isFinite(gap)) {
          return <span className="font-mono text-xs text-muted" title="Previous block timestamp unavailable">—</span>;
        }
        const interval = formatBlockInterval(gap);
        const target = scheduledSeconds(schedule, Number(block.height), Number(block.height) + 1);
        const description = `${target !== null ? `The tick marks the ${target}s target. ` : ''}${gap > INTERVAL_SCALE_SECONDS ? 'The arrow means more than 5 min.' : 'The bar shows up to 5 min.'}${gap < 0 ? ' Left arrow: timestamp earlier than the previous block’s.' : ''}`;
        return (
          <div className="grid grid-cols-[3rem_4.5rem] items-center justify-end gap-3">
            <Tooltip content={description} label={`Block interval ${interval.label}: scale and target`}>
              <span className="inline-flex h-6 w-12 items-center" aria-hidden="true">
                <span className="relative block w-12 h-1 shrink-0 rounded-full bg-cipher-border-alpha/40">
                  {gap < 0 ? (
                    <span className="absolute right-full mr-0.5 top-1/2 -translate-y-1/2 text-xs leading-none text-secondary">←</span>
                  ) : (
                    <span className="block h-full rounded-full bg-secondary/60" style={{ width: `${Math.min(100, (gap / INTERVAL_SCALE_SECONDS) * 100)}%` }} />
                  )}
                  {target !== null && target <= INTERVAL_SCALE_SECONDS && (
                    <span className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-primary/70" style={{ left: `${(target / INTERVAL_SCALE_SECONDS) * 100}%` }} />
                  )}
                  {gap > INTERVAL_SCALE_SECONDS && <span className="absolute left-full ml-0.5 top-1/2 -translate-y-1/2 text-xs leading-none text-secondary">›</span>}
                </span>
              </span>
            </Tooltip>
            <span className="font-mono text-xs text-secondary tabular-nums whitespace-nowrap text-right">{interval.label}</span>
          </div>
        );
      },
    },
    {
      id: 'age',
      header: 'Age',
      align: 'right',
      skeletonWidth: 'w-16',
      cell: (block) => (
        // formatRelativeTime() reads Date.now(), which necessarily differs
        // between the server render and the client's hydration pass by
        // however long that round-trip took — usually not enough to change
        // the rounded text, but enough to flip it right at a unit boundary
        // (e.g. "59 seconds ago" -> "1 minute ago"). The mismatch is
        // expected and harmless (React docs list this exact case), so it's
        // suppressed here rather than fixed by forcing a client-only render.
        <span className="text-xs text-muted whitespace-nowrap" suppressHydrationWarning>
          {formatRelativeTime(block.timestamp)}
        </span>
      ),
    },
  ];
}

interface BlocksClientProps {
  filters?: BlockFilterValues;
  initialBlocks?: Block[];
  initialTrailingBlock?: Block | null;
  initialPagination?: Partial<BasePaginationState> | null;
  initialCursor?: string | null;
  initialDirection?: 'next' | 'prev';
  initialPage?: number;
  initialUnavailable?: boolean;
}

export default function BlocksClient({
  filters = {},
  initialBlocks = [],
  initialTrailingBlock = null,
  initialPagination = null,
  initialCursor = null,
  initialDirection = 'next',
  initialPage = 1,
  initialUnavailable = false,
}: BlocksClientProps) {
  const [view, setView] = useState<BlocksView>('overview');
  useEffect(() => {
    try {
      if (window.localStorage.getItem(VIEW_STORAGE_KEY) === 'coinbase') setView('coinbase');
    } catch { /* Storage may be disabled; switching views still works. */ }
  }, []);

  const selectView = (next: BlocksView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch { /* Keep the preference for this mounted page when storage is unavailable. */ }
  };

  const {
    items: blocks,
    page,
    pagination,
    loading,
    dataAvailable,
    lastCheckedAt,
    refreshFailed,
    extra: trailingBlock,
    firstHref,
    prevHref,
    nextHref,
  } = usePaginatedList<Block, BasePaginationState, Block | null>({
    endpoint: '/v1/blocks',
    buildParams: () => filters as Record<string,string>,
    pageSize: PAGE_SIZE,
    archiveBasePath: '/blocks',
    getLatestKey: (block) => block.hash,
    shouldWsRefresh: (msg) => {
      return msg.type === 'new_block' || msg.type === 'chain_tip';
    },
    buildArchiveHref: (cursor, _secondary, direction, targetPage) => {
      if (targetPage <= 1 || cursor === null) return Object.keys(filters).length ? `/blocks?${new URLSearchParams(filters)}` : '/blocks';
      const params = new URLSearchParams({
        ...filters,
        cursor: String(cursor),
        direction,
        page: String(targetPage),
      });
      return `/blocks?${params.toString()}`;
    },
    initialItems: initialBlocks,
    initialPagination,
    initialPage,
    initialCursor,
    initialDirection,
    initialUnavailable,
    initialExtra: initialTrailingBlock,
  });

  const [summary, setSummary] = useState<{ height: number | null; blocks24h: number | null; avgBlockTime: number | null; avgBlockFee: number | null; txsPerBlock: number | null }>({ height: null, blocks24h: null, avgBlockTime: null, avgBlockFee: null, txsPerBlock: null });
  const [schedule, setSchedule] = useState<BlockSchedule | null>(null);
  const [zecPriceUsd, setZecPriceUsd] = useState<number | null>(null);

  useEffect(() => {
    const base = getApiUrl();
    fetch(`${base}/v1/network/stats`)
      .then(res => res.ok ? readApiData(res) : null)
      .then(data => {
        if (!data) return;
        setSchedule(data.mining?.schedule ?? null);
        const blocks24h = data.mining?.blocks24h ?? null;
        // Excludes each block's mandatory coinbase tx — nobody "sent" it, so
        // counting it here would inflate "per block" activity with a
        // transaction every single block has by construction.
        const tx24hExclCoinbase = data.blockchain?.tx24hExclCoinbase ?? null;
        setSummary({
          height: data.network?.height ?? data.blockchain?.height ?? null,
          blocks24h,
          avgBlockTime: data.mining?.avgBlockTime ?? null,
          avgBlockFee: data.mining?.avgBlockFee ?? null,
          txsPerBlock: blocks24h && tx24hExclCoinbase ? Math.round((tx24hExclCoinbase / blocks24h) * 10) / 10 : null,
        });
      })
      .catch(() => {});
    fetch(`${base}/v1/network/price`)
      .then(res => res.ok ? readApiData(res) : null)
      .then(data => setZecPriceUsd(data?.price ?? null))
      .catch(() => {});
  }, []);

  // /v1/network/stats is cached up to 2 minutes server-side, while the
  // block list itself refreshes live over the websocket (~15s cache) — right
  // after a new block, the list already shows it but this fetch hasn't
  // caught up yet, so the "Block Height" card would read one block behind
  // the table underneath it. Only the list's own live head is trustworthy
  // for "is there a newer block than what summary last saw", so take
  // whichever is higher; on page 2+ blocks[0] is a historical block, not the
  // tip, so summary.height (the actual network tip) is used untouched.
  const liveHeight = Object.keys(filters).length === 0 && page === 1 && blocks[0]?.height
    ? Math.max(summary.height ?? 0, blocks[0].height) || null
    : summary.height;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-12 animate-fade-in">
      <PageHeader
        eyebrow="ALL_BLOCKS"
        title={page > 1 ? `Zcash Blocks - Page ${page}` : Object.keys(filters).length ? 'Zcash Blocks' : 'Latest Zcash Blocks'}
        subtitle="Browse canonical blocks by software, pool, date, size, fees and more."
        actions={<BlockFilters values={filters} />}
      />

      {initialCursor === null && page === 1 && <LiveRefreshStatus lastCheckedAt={lastCheckedAt} failed={refreshFailed} />}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <MetricCard size="compact"
          label="Block Height"
          value={liveHeight != null ? liveHeight.toLocaleString() : '—'}
          hint="Latest known network height"
        />
        <MetricCard size="compact"
          label="Blocks (24h)"
          value={summary.blocks24h != null ? summary.blocks24h.toLocaleString() : '—'}
          hint="Observed canonical blocks in 24 hours"
        />
        <MetricCard size="compact"
          label="Avg Block Time"
          value={summary.avgBlockTime != null ? `${summary.avgBlockTime}s` : '—'}
          hint={`Last ${isTestnet ? '500' : '1,000'} blocks · observed timestamps`}
        />
        <MetricCard size="compact"
          label="Avg Block Fee (24h)"
          className="order-last col-span-2 sm:order-none sm:col-span-1"
          value={summary.avgBlockFee != null ? `${summary.avgBlockFee.toFixed(8)} ${CURRENCY}` : '—'}
          hint={summary.avgBlockFee != null && zecPriceUsd != null ? `≈ $${(summary.avgBlockFee * zecPriceUsd).toFixed(2)}` : undefined}
        />
        <MetricCard size="compact"
          label="Txs Per Block"
          value={summary.txsPerBlock != null ? summary.txsPerBlock.toLocaleString() : '—'}
          hint="Coinbase not counted"
        />
      </div>

      {!dataAvailable && <p role="status" className="mb-4 text-sm text-muted">Block data is unavailable for this selection. Software filters require the completed history index; please try again later.</p>}
      <Tabs tabs={BLOCK_VIEWS} active={view} onChange={selectView} className="mb-4" />
      <div role="tabpanel" aria-label={view === 'coinbase' ? 'Coinbase messages' : 'Blocks overview'}>
      <DataTable
        columns={(view === 'coinbase' ? coinbaseColumns : blockColumns)(blocks, trailingBlock ?? null, schedule).map((column) => {
          if (!['height', 'txs', 'size', 'fees', 'interval'].includes(column.id)) return column;
          const order = filters.order || 'newest';
          const active = column.id === 'height' ? ['newest', 'oldest'].includes(order) : order.startsWith(`${column.id}_`);
          const ascending = order === 'oldest' || order.endsWith('_asc');
          const nextAscending = active && !ascending;
          const nextOrder = column.id === 'height' ? (nextAscending ? 'oldest' : 'newest') : `${column.id}_${nextAscending ? 'asc' : 'desc'}`;
          const params = new URLSearchParams({ ...filters, order: nextOrder });
          const label = column.id === 'height' ? (nextAscending ? 'oldest first' : 'newest first') : (nextAscending ? 'lowest first' : 'highest first');
          return {
            ...column,
            sortDirection: active ? (ascending ? 'ascending' as const : 'descending' as const) : undefined,
            header: <Link href={`/blocks?${params}`} scroll={false} className={`inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap ${column.align === 'right' ? 'flex-row-reverse' : ''} hover:text-primary ${active ? 'text-primary' : ''}`} aria-label={`Sort ${column.id === 'txs' ? 'transactions' : column.id}: ${label}`}>
              {column.header}<span aria-hidden="true" className={active ? 'text-primary' : 'text-muted'}>{active ? (ascending ? '↑' : '↓') : '↕'}</span>
            </Link>,
          };
        })}
        footer={view === 'coinbase'
          ? <p className="px-4 py-3 text-xs text-muted">Miner-provided messages and software markers · non-printable bytes shown as dots.</p>
          : <p className="hidden lg:block px-4 py-3 text-xs text-muted">Interval bars: 0–5 min · tick = target at that height · ← timestamp earlier than previous block. Intervals use block timestamps, not arrival times.</p>}
        rows={blocks}
        rowKey={(block) => block.height}
        loading={loading}
      />
      </div>

      <Pagination
        page={page}
        totalPages={pagination.totalPages}
        hasNext={pagination.hasNext}
        hasPrev={pagination.hasPrev}
        firstHref={firstHref}
        prevHref={prevHref}
        nextHref={nextHref}
        loading={loading}
      />
    </div>
  );
}
