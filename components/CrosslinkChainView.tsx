'use client';

import { readApiData } from '@/lib/api-client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Tooltip } from '@/components/Tooltip';
import { getApiUrl } from '@/lib/api-config';

interface BlockRow {
  height: number;
  hash: string;
  timestamp: number;
  transaction_count: number;
  size: number;
  finality_status?: string | null;
}

interface CrosslinkStats {
  tipHeight: number;
  finalizedHeight: number | null;
  finalityGap: number | null;
  crosslinkActive?: boolean;
  finalizerCount: number;
  totalStakeZec: number;
}

interface BftTip {
  votedBlockHash: string | null;
  signatureCount: number;
}

interface BftDecision {
  referenced_hash: string;
  signature_count: number;
  pow_blocks_in_decision: number;
  first_seen_at_pow_height: number;
  last_seen_at_pow_height: number;
}

interface DivergenceEvent {
  id: number;
  start_time: number;
  end_time: number | null;
  duration_seconds: number | null;
  is_open: boolean;
  severity: string;
  start_tip_height: number;
  start_finalized_height: number;
  peak_gap: number;
  peak_tip_height: number;
  end_tip_height: number | null;
  end_finalized_height: number | null;
}

/**
 * Pretty-print bytes with a compact unit.
 */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtAge(epoch: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - epoch));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

/**
 * Size-to-visual-scale: log scale so coinbase-only blocks (1-2 KB) are still
 * visible next to full blocks (>60 KB). Returns a value in [0.2, 1].
 */
function sizeToScale(size: number, maxSize: number): number {
  if (maxSize <= 0) return 0.4;
  const normalizedMax = Math.log10(Math.max(maxSize, 2048));
  const normalizedSize = Math.log10(Math.max(size, 1024));
  const pct = normalizedSize / normalizedMax;
  return Math.max(0.2, Math.min(1, pct));
}

/**
 * Shared Crosslink chain visualizer.
 *
 * Two layouts:
 *  - variant="full": standalone page with header + all stats
 *  - variant="compact": embeddable on the homepage (fewer blocks, no header)
 */
export function CrosslinkChainView({
  variant = 'full',
  blocksToShow = 20,
}: {
  variant?: 'full' | 'compact';
  blocksToShow?: number;
}) {
  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  const [stats, setStats] = useState<CrosslinkStats | null>(null);
  const [bftTip, setBftTip] = useState<BftTip | null>(null);
  const [decisions, setDecisions] = useState<BftDecision[]>([]);
  const [divergenceEvents, setDivergenceEvents] = useState<DivergenceEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const api = getApiUrl();
      const [blocksRes, crosslinkRes, bftRes, bftChainRes, divRes] = await Promise.all([
        fetch(`${api}/v1/blocks?limit=${blocksToShow}`),
        fetch(`${api}/v1/crosslink`),
        fetch(`${api}/v1/crosslink/bft-tip`),
        fetch(`${api}/v1/crosslink/bft-chain?limit=${blocksToShow}`),
        variant === 'full'
          ? fetch(`${api}/v1/crosslink/divergence-history?limit=10`)
          : Promise.resolve(null),
      ]);

      if (blocksRes.ok) {
        const data = await readApiData(blocksRes);
        setBlocks(data || []);
      }
      if (crosslinkRes.ok) {
        const data = await readApiData(crosslinkRes);
        if (data) {
          setStats({
            tipHeight: data.tipHeight,
            finalizedHeight: data.finalizedHeight,
            finalityGap: data.finalityGap,
          crosslinkActive: data.crosslinkActive,
            finalizerCount: data.finalizerCount,
            totalStakeZec: data.totalStakeZec,
          });
        }
      }
      if (bftRes.ok) {
        const data = await readApiData(bftRes);
        if (data) {
          setBftTip({
            votedBlockHash: data.votedBlockHash,
            signatureCount: data.signatureCount,
          });
        }
      }
      if (bftChainRes.ok) {
        const data = await readApiData(bftChainRes);
        if (data) setDecisions(data.decisions || []);
      }
      if (divRes && divRes.ok) {
        const data = await readApiData(divRes);
        if (data) setDivergenceEvents(data.events || []);
      }
    } catch (err) {
      console.error('Chain view fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [blocksToShow, variant]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, variant === 'compact' ? 15_000 : 10_000);
    return () => clearInterval(interval);
  }, [fetchData, variant]);

  // Index into blocks[] of the first finalized block from the top (= finality frontier)
  const finalizedFrontierIndex = stats
    ? blocks.findIndex((b) => stats.finalizedHeight != null && b.height <= stats.finalizedHeight)
    : -1;

  // Index of the block BFT is currently voting on (if visible)
  const votedIndex = bftTip?.votedBlockHash
    ? blocks.findIndex((b) => b.hash === bftTip.votedBlockHash)
    : -1;

  const maxSize = blocks.reduce((m, b) => Math.max(m, b.size || 0), 0);
  const openDivergence = divergenceEvents.find((e) => e.is_open);

  if (loading && blocks.length === 0) {
    return (
      <div className="card p-8 flex items-center justify-center min-h-[240px]">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-cipher-gold border-t-transparent" />
      </div>
    );
  }

  return (
    <div className={variant === 'compact' ? '' : 'space-y-6'}>
      {variant === 'full' && stats && (
        <StatsGrid stats={stats} openDivergence={!!openDivergence} />
      )}

      {variant === 'full' && (openDivergence || divergenceEvents.length > 0) && (
        <DivergencePanel openEvent={openDivergence} recentEvents={divergenceEvents} />
      )}

      <div className="space-y-1.5">
        {blocks.map((b, i) => {
          const isFinalized = stats ? stats.finalizedHeight != null && b.height <= stats.finalizedHeight : false;
          const isFrontier = i === finalizedFrontierIndex && stats !== null;
          const isVotingOn = i === votedIndex;
          const isTip = stats ? b.height === stats.tipHeight : i === 0;
          const scale = sizeToScale(b.size || 0, maxSize);
          const decision = decisions.find(
            (d) =>
              b.height >= d.first_seen_at_pow_height &&
              b.height <= d.last_seen_at_pow_height,
          );

          return (
            <ChainRow
              key={b.hash}
              block={b}
              scale={scale}
              isFinalized={isFinalized}
              isFrontier={isFrontier}
              isVotingOn={isVotingOn}
              isTip={isTip}
              stats={stats}
              bftTip={bftTip}
              decision={decision ?? null}
              isFirst={i === 0}
              isLast={i === blocks.length - 1}
              variant={variant}
            />
          );
        })}
      </div>

      {variant === 'compact' && (
        <div className="mt-3 flex items-center justify-between text-caption font-mono">
          <span className="text-muted">
            {stats &&
              (stats.finalizedHeight == null ? (stats.crosslinkActive === false ? 'PoW phase · Crosslink not active' : 'Finality unavailable') : `Finalized through #${stats.finalizedHeight.toLocaleString()} · gap ${stats.finalityGap}`)}
          </span>
          <Link href="/chain" className="text-cipher-gold hover:underline">
            Open Chain View →
          </Link>
        </div>
      )}
    </div>
  );
}

function ChainRow({
  block,
  isFinalized,
  isVotingOn,
  isTip,
  stats,
  bftTip,
  decision,
  variant,
}: {
  block: BlockRow;
  scale: number;
  isFinalized: boolean;
  isFrontier: boolean;
  isVotingOn: boolean;
  isTip: boolean;
  stats: CrosslinkStats | null;
  bftTip: BftTip | null;
  decision: BftDecision | null;
  isFirst: boolean;
  isLast: boolean;
  variant: 'full' | 'compact';
}) {
  let badgeLabel: string;
  let badgeClass: string;
  let accentClass: string;
  let borderClass: string;

  if (isTip) {
    badgeLabel = 'TIP';
    badgeClass = 'text-cipher-gold bg-brand-gold/10 border-cipher-gold/40';
    accentClass = 'bg-brand-gold';
    borderClass = 'border-cipher-gold/50';
  } else if (isVotingOn) {
    badgeLabel = 'VOTING';
    badgeClass = 'text-cipher-orange bg-cipher-orange/10 border-cipher-orange/40';
    accentClass = 'bg-cipher-orange animate-pulse';
    borderClass = 'border-cipher-orange/50';
  } else if (isFinalized) {
    badgeLabel = 'FINAL';
    badgeClass = 'text-cipher-gold-muted bg-[rgba(94,187,206,0.08)] border-[rgba(94,187,206,0.3)]';
    accentClass = 'bg-cipher-gold-muted';
    borderClass = 'border-cipher-border';
  } else {
    badgeLabel = 'PENDING';
    badgeClass = 'text-muted border-cipher-border';
    accentClass = 'bg-brand-gold/50';
    borderClass = 'border-cipher-border';
  }

  return (
    <Link
      href={`/block/${block.height}`}
      className={`group flex items-stretch rounded-md border ${borderClass} bg-white dark:bg-white/[0.03] overflow-hidden hover:border-cipher-gold/60 transition-colors`}
    >
      <span className={`block w-1 shrink-0 ${accentClass}`} />

      <div className="flex-1 min-w-0 px-3 py-2 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono text-data font-semibold tabular-nums text-black dark:text-white group-hover:text-primary transition-colors shrink-0">
              #{block.height.toLocaleString()}
            </span>
            <span
              className={`shrink-0 inline-flex items-center px-1.5 py-[1px] rounded border text-caption font-mono uppercase tracking-wider ${badgeClass}`}
            >
              {badgeLabel}
            </span>
            <code className="hidden sm:inline text-caption font-mono text-secondary truncate">
              {block.hash.slice(0, 8)}…{block.hash.slice(-6)}
            </code>
          </div>
          <div className="mt-0.5 font-mono text-caption flex items-center gap-1.5 text-muted">
            <span className="tabular-nums text-black dark:text-white">
              {fmtAge(block.timestamp)}
            </span>
            <span>·</span>
            <span className="tabular-nums">
              <span className="text-black dark:text-white">
                {block.transaction_count}
              </span>{' '}
              {block.transaction_count === 1 ? 'tx' : 'txs'}
            </span>
            <span>·</span>
            <span className="tabular-nums">{fmtBytes(block.size || 0)}</span>
          </div>
        </div>

        {/* Right side: actual BFT decision info when available */}
        <div className="shrink-0">
          {isVotingOn && bftTip && stats ? (
            <BftChip
              count={bftTip.signatureCount}
              total={stats.finalizerCount}
              state="voting"
            />
          ) : decision && stats ? (
            <BftChip
              count={decision.signature_count}
              total={stats.finalizerCount}
              state="signed"
              blocksInDecision={decision.pow_blocks_in_decision}
            />
          ) : isFinalized ? (
            <BftChip count={0} total={0} state="final" />
          ) : (
            <BftChip count={0} total={0} state="pending" />
          )}
        </div>
      </div>
    </Link>
  );
}

function BftChip({
  count,
  total,
  state,
  blocksInDecision,
}: {
  count: number;
  total: number;
  state: 'voting' | 'signed' | 'final' | 'pending';
  blocksInDecision?: number;
}) {
  if (state === 'pending') {
    return (
      <div className="flex items-center gap-1.5 text-caption font-mono">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-cipher-orange/60 animate-pulse" />
        <span className="text-muted uppercase tracking-wider">
          pending
        </span>
      </div>
    );
  }

  if (state === 'final') {
    return (
      <div className="flex items-center gap-1.5 text-caption font-mono">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-cipher-gold-muted" />
        <span className="text-cipher-gold-muted uppercase tracking-wider">
          bft ✓
        </span>
      </div>
    );
  }

  // signed or voting → show a mini circle with sig count + "of N"
  const isVoting = state === 'voting';
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const circleColor = isVoting
    ? 'border-cipher-orange/70 bg-cipher-orange/15 text-cipher-orange'
    : 'border-cipher-coral/70 bg-cipher-coral/15 text-cipher-coral';

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`relative inline-flex items-center justify-center w-6 h-6 rounded-full border ${circleColor}`}
      >
        {isVoting && (
          <span className="absolute inset-0 rounded-full bg-cipher-orange/30 animate-ping opacity-60" />
        )}
        <span className="relative font-mono text-caption font-semibold tabular-nums">
          {count}
        </span>
      </span>
      <div className="text-caption font-mono leading-tight">
        <div className="text-black dark:text-white tabular-nums">
          {isVoting ? 'voting' : `of ${total}`}
        </div>
        <div className="text-muted tabular-nums">
          {isVoting
            ? `${count}/${total}`
            : blocksInDecision && blocksInDecision > 1
            ? `${pct}% · ${blocksInDecision}b`
            : `${pct}%`}
        </div>
      </div>
    </div>
  );
}

function StatsGrid({
  stats,
  openDivergence,
}: {
  stats: CrosslinkStats;
  openDivergence: boolean;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <TipStat
        label="PoW Tip"
        value={`#${stats.tipHeight.toLocaleString()}`}
        tooltip="Highest block mined by miners."
      />
      <TipStat
        label="Finalized"
        value={stats.finalizedHeight == null ? (stats.crosslinkActive === false ? 'Not active' : 'Unavailable') : `#${stats.finalizedHeight.toLocaleString()}`}
        tooltip="Highest block irreversibly confirmed by PoS BFT consensus."
      />
      <TipStat
        label="Finality Gap"
        value={stats.finalityGap == null ? (stats.crosslinkActive === false ? 'Not active' : 'Unavailable') : `${stats.finalityGap}`}
        sub="blocks"
        accent={openDivergence ? 'orange' : (stats.finalityGap ?? 0) > 20 ? 'orange' : undefined}
        tooltip="Blocks between the PoW tip and the last finalized block. Healthy: 0–10."
      />
      <TipStat
        label="Finalizers"
        value={`${stats.finalizerCount}`}
        tooltip="Active validators participating in BFT voting."
      />
    </div>
  );
}

function TipStat({
  label,
  value,
  sub,
  tooltip,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  tooltip?: string;
  accent?: 'orange';
}) {
  return (
    <div className="card p-4">
      <div className="text-caption font-mono text-muted uppercase tracking-wider mb-1 flex items-center gap-1">
        <span>{label}</span>
        {tooltip && <Tooltip content={tooltip} />}
      </div>
      <div
        className={`text-lg sm:text-xl font-mono font-semibold ${
          accent === 'orange' ? 'text-cipher-orange' : 'text-primary'
        }`}
      >
        {value}
        {sub && <span className="text-xs text-muted ml-1">{sub}</span>}
      </div>
    </div>
  );
}

function FrontierMarker({
  finalizerCount,
  totalStakeZec,
  compact,
}: {
  finalizerCount: number;
  totalStakeZec: number;
  compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-2.5 rounded border border-cipher-green/40 bg-cipher-green/5">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cipher-green opacity-70" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-cipher-green" />
      </span>
      <div className="min-w-0">
        <div className="text-caption font-semibold text-cipher-green whitespace-nowrap">
          Finality Frontier
        </div>
        {!compact && (
          <div className="text-caption text-muted font-mono whitespace-nowrap">
            {finalizerCount} finalizers · {totalStakeZec.toFixed(1)} cTAZ
          </div>
        )}
      </div>
    </div>
  );
}

function BftVoteMarker({
  signatureCount,
  finalizerCount,
  compact,
}: {
  signatureCount: number;
  finalizerCount: number;
  compact?: boolean;
}) {
  const pct = finalizerCount > 0 ? Math.round((signatureCount / finalizerCount) * 100) : 0;
  return (
    <div className="flex items-center gap-2 py-1.5 px-2.5 rounded border border-cipher-orange/40 bg-cipher-orange/5">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cipher-orange opacity-70" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-cipher-orange" />
      </span>
      <div className="min-w-0">
        <div className="text-caption font-semibold text-cipher-orange whitespace-nowrap">Voting now</div>
        {!compact && (
          <div className="text-caption text-muted font-mono whitespace-nowrap">
            {signatureCount}/{finalizerCount} sigs · {pct}%
          </div>
        )}
      </div>
    </div>
  );
}

function fmtAgo(epoch: number | null): string {
  if (!epoch) return '—';
  const diff = Math.floor(Date.now() / 1000 - epoch);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtDuration(secs: number | null): string {
  if (!secs) return '—';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function DivergencePanel({
  openEvent,
  recentEvents,
}: {
  openEvent?: DivergenceEvent;
  recentEvents: DivergenceEvent[];
}) {
  const [expanded, setExpanded] = useState(false);
  const closed = recentEvents.filter((e) => !e.is_open);
  if (!openEvent && closed.length === 0) return null;

  const repeatedHeights = new Map<number, number>();
  for (const e of closed) {
    const h = e.start_finalized_height;
    repeatedHeights.set(h, (repeatedHeights.get(h) || 0) + 1);
  }
  const recurringHeight = [...repeatedHeights.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])[0];

  return (
    <div className={`card p-4 sm:p-5 ${openEvent ? 'border-cipher-orange/40' : ''}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <span className="relative flex h-2.5 w-2.5 mt-1.5 shrink-0">
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${
                openEvent ? 'bg-cipher-orange' : 'bg-brand-gold'
              }`}
            />
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                openEvent ? 'bg-cipher-orange' : 'bg-brand-gold'
              }`}
            />
          </span>
          <div>
            <div className="text-sm font-semibold text-primary">
              {openEvent ? 'Chain divergence in progress' : 'Chain divergence history'}
            </div>
            <div className="text-xs text-secondary mt-1 leading-relaxed max-w-2xl">
              {openEvent ? (
                <>
                  Our node&apos;s finality gap is{' '}
                  <span className="text-cipher-orange font-semibold">
                    {openEvent.peak_gap} blocks
                  </span>
                  . Started {fmtAgo(openEvent.start_time)} at finalized block{' '}
                  <Link
                    href={`/block/${openEvent.start_finalized_height}`}
                    className="text-cipher-gold hover:underline"
                  >
                    #{openEvent.start_finalized_height.toLocaleString()}
                  </Link>
                  .
                </>
              ) : recurringHeight ? (
                <>
                  We&apos;ve diverged at finalized block{' '}
                  <Link
                    href={`/block/${recurringHeight[0]}`}
                    className="text-cipher-gold hover:underline"
                  >
                    #{recurringHeight[0].toLocaleString()}
                  </Link>{' '}
                  <span className="text-primary">{recurringHeight[1]} times</span> — looks like a
                  reproducible protocol bug at that height.
                </>
              ) : (
                <>Last divergence resolved {fmtAgo(closed[0]?.end_time ?? null)}.</>
              )}
            </div>
          </div>
        </div>

        {recentEvents.length > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs font-mono text-muted hover:text-primary"
          >
            {expanded ? 'hide history' : `history (${recentEvents.length})`}
          </button>
        )}
      </div>

      {expanded && recentEvents.length > 0 && (
        <div className="mt-4 pt-4 border-t border-cipher-border overflow-x-auto">
          <table className="w-full text-xs font-mono min-w-[560px]">
            <thead>
              <tr className="text-left text-muted text-caption uppercase tracking-wider">
                <th className="py-2 pr-4">Started</th>
                <th className="py-2 pr-4">Diverged at</th>
                <th className="py-2 pr-4 text-right">Peak gap</th>
                <th className="py-2 pr-4 text-right">Duration</th>
                <th className="py-2 pr-4">Severity</th>
              </tr>
            </thead>
            <tbody>
              {recentEvents.map((e) => (
                <tr key={e.id} className="border-t border-cipher-border-alpha/40">
                  <td className="py-2 pr-4 text-secondary">{fmtAgo(e.start_time)}</td>
                  <td className="py-2 pr-4">
                    <Link
                      href={`/block/${e.start_finalized_height}`}
                      className="text-cipher-gold hover:underline"
                    >
                      #{e.start_finalized_height.toLocaleString()}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 text-right text-primary">{e.peak_gap}</td>
                  <td className="py-2 pr-4 text-right text-secondary">
                    {e.is_open ? 'open' : fmtDuration(e.duration_seconds)}
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className={
                        e.severity === 'critical' ? 'text-cipher-orange' : 'text-muted'
                      }
                    >
                      {e.severity}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
