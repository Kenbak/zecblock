'use client';

import { readApiData } from '@/lib/api-client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  PanOnScrollMode,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getApiUrl } from '@/lib/api-config';
import { displayPubkey } from '@/lib/utils';
import { getFinalizerLabel } from '@/lib/finalizer-labels';
import { Tooltip } from '@/components/Tooltip';
import styles from './CrosslinkChainGraph.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PowBlock {
  height: number;
  hash: string;
  timestamp: number;
  transaction_count: number;
  size: number;
  finality_status?: string | null;
}

interface BftDecision {
  referenced_hash: string;
  signature_count: number;
  pow_blocks_in_decision: number;
  first_seen_at_pow_height: number;
  last_seen_at_pow_height: number;
  signer_keys: string[];
}

interface BftTip {
  votedBlockHash: string | null;
  signatureCount: number;
  signers: Array<{ pub_key: string | null }>;
}

interface CrosslinkStats {
  tipHeight: number;
  finalizedHeight: number | null;
  finalityGap: number | null;
  crosslinkActive?: boolean;
  finalizerCount: number;
  totalStakeZec: number;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const POW_X = 0;
const BFT_X = 580;
const ROW_HEIGHT = 100;
const POW_WIDTH = 360;
const POW_HEIGHT = 84;
const BFT_SIZE = 48;
const BFT_NODE_WIDTH = 260;

// Brand palette
const COLOR_POW_DIM = 'rgba(232, 184, 75, 0.65)';
const COLOR_BFT = 'rgba(239, 108, 96, 0.95)';
const COLOR_BFT_EDGE = 'rgba(239, 108, 96, 0.7)';
// Clay, matching the text-cipher-orange labels these nodes carry.
const COLOR_VOTING = 'rgba(226, 166, 110, 1)';
const COLOR_VOTING_EDGE = 'rgba(226, 166, 110, 0.85)';
const COLOR_FINALIZE = 'var(--color-green)'; // Finality status follows the shared success color.

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// PoW node
// ---------------------------------------------------------------------------

interface PowNodeData extends Record<string, unknown> {
  block: PowBlock;
  state: 'finalized' | 'voting' | 'pending';
  isTip?: boolean;
}

function PowBlockNode({ data }: NodeProps<Node<PowNodeData>>) {
  const { block, state, isTip } = data;

  // Priority: TIP > VOTING > FINAL > PENDING
  let badgeLabel: string;
  let badgeClass: string;
  let accentClass: string;
  let borderClass: string;

  if (isTip) {
    badgeLabel = 'TIP';
    badgeClass = 'text-cipher-gold bg-brand-gold/10 border-cipher-gold/40';
    accentClass = 'bg-brand-gold';
    borderClass = 'border-cipher-gold/50';
  } else if (state === 'voting') {
    badgeLabel = 'VOTING';
    badgeClass = 'text-cipher-orange bg-cipher-orange/10 border-cipher-orange/40';
    accentClass = 'bg-cipher-orange animate-pulse';
    borderClass = 'border-cipher-orange/50';
  } else if (state === 'finalized') {
    badgeLabel = 'FINAL';
    badgeClass = 'text-cipher-gold-muted bg-[rgba(94,187,206,0.08)] border-[rgba(94,187,206,0.3)]';
    accentClass = 'bg-cipher-gold-muted';
    borderClass = 'border-cipher-border';
  } else {
    badgeLabel = 'PENDING';
    badgeClass = 'border-cipher-border';
    accentClass = 'bg-brand-gold/50';
    borderClass = 'border-cipher-border';
  }

  return (
    <div
      className="relative nodrag"
      style={{ width: POW_WIDTH, height: POW_HEIGHT }}
    >
      <Handle
        type="source"
        position={Position.Right}
        id="pow"
        isConnectable={false}
        className="!bg-transparent !border-0 !w-px !h-px !min-w-0 !min-h-0"
        style={{ right: 0, top: POW_HEIGHT / 2 }}
      />
      <Handle
        type="target"
        position={Position.Right}
        id="pow-in"
        isConnectable={false}
        className="!bg-transparent !border-0 !w-px !h-px !min-w-0 !min-h-0"
        style={{ right: 0, top: POW_HEIGHT / 2 }}
      />

      <Link
        href={`/block/${block.height}`}
        className={`group absolute inset-0 flex items-stretch rounded-lg border ${borderClass} bg-white dark:bg-white/[0.03] overflow-hidden hover:border-cipher-gold/60 hover:shadow-[0_0_20px_rgba(248,188,33,0.12)] transition`}
      >
        <span className={`block w-1 shrink-0 ${accentClass}`} />

        <div className="flex-1 min-w-0 px-3.5 py-2.5 flex flex-col justify-between gap-1">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="font-mono text-body font-semibold tabular-nums shrink-0 text-black dark:text-white group-hover:text-primary transition-colors">
              #{block.height.toLocaleString()}
            </span>
            <span
              className={`shrink-0 inline-flex items-center px-1.5 py-[1px] rounded border text-caption font-mono uppercase tracking-wider ${badgeClass}`}
            >
              {badgeLabel}
            </span>
          </div>

          <code className="font-mono text-caption truncate text-secondary">
            {block.hash.slice(0, 10)}…{block.hash.slice(-10)}
          </code>

          <div className="font-mono text-caption flex items-center gap-1.5 text-muted">
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
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BFT node
// ---------------------------------------------------------------------------

interface BftNodeData extends Record<string, unknown> {
  decision: BftDecision;
  finalizerCount: number;
  isVoting?: boolean;
}

function BftDecisionNode({ data }: NodeProps<Node<BftNodeData>>) {
  const { decision, finalizerCount, isVoting } = data;
  const pct =
    finalizerCount > 0
      ? (decision.signature_count / finalizerCount) * 100
      : 0;

  const circleBg = isVoting
    ? 'bg-cipher-orange/20'
    : 'bg-[rgba(239,108,96,0.15)]';
  const circleBorder = isVoting
    ? 'border-cipher-orange/70'
    : 'border-[rgba(239,108,96,0.7)]';
  const numColor = isVoting ? 'text-cipher-orange' : 'text-cipher-coral';
  const glow = isVoting
    ? 'shadow-[0_0_22px_rgba(226,166,110,0.45)]'
    : 'shadow-[0_0_16px_rgba(239,108,96,0.3)]';

  return (
    <div
      className="group relative flex items-center gap-3 overflow-visible"
      style={{ width: BFT_NODE_WIDTH, height: POW_HEIGHT }}
    >
      {/* Handles sit at the very left edge of the node so edges terminate
          at the circle boundary instead of passing through its center. */}
      <Handle
        type="target"
        position={Position.Left}
        id="bft-in"
        isConnectable={false}
        className="!bg-transparent !border-0 !w-px !h-px !min-w-0 !min-h-0"
        style={{ left: 0, top: POW_HEIGHT / 2 }}
      />
      <Handle
        type="source"
        position={Position.Left}
        id="bft-out"
        isConnectable={false}
        className="!bg-transparent !border-0 !w-px !h-px !min-w-0 !min-h-0"
        style={{ left: 0, top: POW_HEIGHT / 2 }}
      />

      <div
        className={`relative flex items-center justify-center rounded-full border-2 shrink-0 ${circleBg} ${circleBorder} ${glow} transition-shadow hover:shadow-[0_0_28px_rgba(239,108,96,0.5)]`}
        style={{ width: BFT_SIZE, height: BFT_SIZE }}
      >
        {isVoting && (
          <span className="absolute inset-0 rounded-full bg-cipher-orange/30 animate-ping opacity-60" />
        )}
        <span
          className={`relative font-mono text-data font-semibold ${numColor}`}
        >
          {decision.signature_count}
        </span>
      </div>

      <div className="min-w-0 leading-tight">
        <div className="font-mono text-caption uppercase tracking-wider text-muted">
          {isVoting ? 'voting now' : 'BFT decision'}
        </div>
        <div className="text-caption font-medium text-black dark:text-white">
          <span className="tabular-nums">{decision.signature_count}</span>
          <span className="text-muted"> of </span>
          <span className="tabular-nums">{finalizerCount}</span>
          <span className="text-muted"> signed</span>
          <span className="text-muted"> · </span>
          <span className="tabular-nums text-secondary">
            {pct.toFixed(0)}%
          </span>
        </div>
        <div className="font-mono text-caption truncate text-muted">
          {decision.pow_blocks_in_decision > 1
            ? `confirms ${decision.pow_blocks_in_decision} PoW blocks`
            : `confirms 1 PoW block`}
          {` · `}
          {decision.referenced_hash.slice(0, 6)}…
          {decision.referenced_hash.slice(-4)}
        </div>
      </div>

      {decision.signer_keys.length > 0 && (
        <div className="absolute left-[60px] top-[80px] opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity z-50">
          <div className="card p-3 min-w-[280px] max-w-[340px] shadow-xl">
            <div className="text-caption font-mono text-muted uppercase tracking-wider mb-2">
              Signers · {decision.signer_keys.length}
            </div>
            <div className="space-y-0.5 max-h-56 overflow-y-auto">
              {decision.signer_keys.slice(0, 24).map((k) => {
                const pretty = displayPubkey(k);
                const label = getFinalizerLabel(k);
                return (
                  <Link
                    key={k}
                    href={`/finalizer/${pretty}`}
                    className="flex items-center gap-1.5 text-caption font-mono text-secondary hover:text-primary truncate"
                  >
                    {label && (
                      <span className="shrink-0 inline-flex items-center px-1 py-[1px] rounded border text-caption uppercase tracking-wider text-cipher-gold bg-brand-gold/10 border-cipher-gold/40">
                        {label.name}
                      </span>
                    )}
                    <span className="truncate">
                      {pretty.slice(0, 14)}…{pretty.slice(-6)}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const nodeTypes = {
  pow: PowBlockNode,
  bft: BftDecisionNode,
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CrosslinkChainGraph({
  initialBlocksToShow = 25,
  variant = 'full',
  height,
}: {
  initialBlocksToShow?: number;
  /** 'full' = standalone /chain page, 'embedded' = drop-in for homepage */
  variant?: 'full' | 'embedded';
  /** Override canvas height (px or any CSS length). Defaults to viewport-aware sizing. */
  height?: string;
}) {
  const isEmbedded = variant === 'embedded';
  const [limit, setLimit] = useState(initialBlocksToShow);
  const [blocks, setBlocks] = useState<PowBlock[]>([]);
  const [decisions, setDecisions] = useState<BftDecision[]>([]);
  const [stats, setStats] = useState<CrosslinkStats | null>(null);
  const [bftTip, setBftTip] = useState<BftTip | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchData = useCallback(
    async (effectiveLimit: number) => {
      try {
        const api = getApiUrl();
        const [blocksRes, bftChainRes, crossRes, bftTipRes] = await Promise.all(
          [
            fetch(`${api}/v1/blocks?limit=${effectiveLimit}`),
            fetch(`${api}/v1/crosslink/bft-chain?limit=${effectiveLimit}`),
            fetch(`${api}/v1/crosslink`),
            fetch(`${api}/v1/crosslink/bft-tip`),
          ],
        );

        if (blocksRes.ok) {
          const d = await readApiData(blocksRes);
          const parsed: PowBlock[] = (d || []).map(
            (b: Record<string, unknown>) => ({
              height:
                typeof b.height === 'string'
                  ? parseInt(b.height as string, 10)
                  : (b.height as number),
              hash: b.hash as string,
              timestamp:
                typeof b.timestamp === 'string'
                  ? parseInt(b.timestamp as string, 10)
                  : (b.timestamp as number),
              transaction_count: (b.transaction_count as number) ?? 0,
              size: (b.size as number) ?? 0,
              finality_status: (b.finality_status as string | null) ?? null,
            }),
          );
          setBlocks(parsed);
        }
        if (bftChainRes.ok) {
          const d = await readApiData(bftChainRes);
          if (d) setDecisions(d.decisions || []);
        }
        if (crossRes.ok) {
          const d = await readApiData(crossRes);
          if (d) {
            setStats({
              tipHeight: d.tipHeight,
              finalizedHeight: d.finalizedHeight,
              finalityGap: d.finalityGap,
              crosslinkActive: d.crosslinkActive,
              finalizerCount: d.finalizerCount,
              totalStakeZec: d.totalStakeZec,
            });
          }
        }
        if (bftTipRes.ok) {
          const d = await readApiData(bftTipRes);
          if (d) {
            setBftTip({
              votedBlockHash: d.votedBlockHash,
              signatureCount: d.signatureCount,
              signers: Array.isArray(d.signers) ? d.signers : [],
            });
          }
        }
      } catch (err) {
        console.error('CrosslinkChainGraph fetch error:', err);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [],
  );

  useEffect(() => {
    fetchData(limit);
    const id = setInterval(() => fetchData(limit), 10_000);
    return () => clearInterval(id);
  }, [fetchData, limit]);

  const loadOlder = useCallback(() => {
    setLoadingMore(true);
    setLimit((l) => Math.min(l + 50, 500));
  }, []);

  // Build RF nodes + edges
  const { nodes, edges } = useMemo<{ nodes: Node[]; edges: Edge[] }>(() => {
    if (blocks.length === 0) return { nodes: [], edges: [] };

    const finalizedHeight = stats?.finalizedHeight ?? null;
    const finalizerCount = stats?.finalizerCount ?? 0;
    const votingHash = bftTip?.votedBlockHash || null;

    const yByHash = new Map<string, number>();
    const yByHeight = new Map<number, number>();

    const tipHeight = stats?.tipHeight ?? blocks[0]?.height ?? 0;

    const powNodes: Node[] = blocks.map((b, i) => {
      const y = i * ROW_HEIGHT;
      yByHash.set(b.hash, y);
      yByHeight.set(b.height, y);
      const state: 'finalized' | 'voting' | 'pending' =
        b.hash === votingHash
          ? 'voting'
          : finalizedHeight != null && b.height <= finalizedHeight
          ? 'finalized'
          : 'pending';
      return {
        id: `pow-${b.hash}`,
        type: 'pow',
        position: { x: POW_X, y },
        data: {
          block: b,
          state,
          isTip: b.height === tipHeight,
        } satisfies PowNodeData,
        draggable: false,
        selectable: false,
      };
    });

    const bftNodes: Node[] = [];
    const bftEdges: Edge[] = [];

    for (const d of decisions) {
      const firstY = yByHeight.get(d.last_seen_at_pow_height);
      const lastY = yByHeight.get(d.first_seen_at_pow_height);
      if (firstY === undefined && lastY === undefined) continue;
      const y0 = firstY ?? lastY ?? 0;
      const y1 = lastY ?? firstY ?? 0;
      const centerY = (y0 + y1) / 2 + (POW_HEIGHT - BFT_SIZE) / 2;

      const nodeId = `bft-${d.referenced_hash}`;
      bftNodes.push({
        id: nodeId,
        type: 'bft',
        position: { x: BFT_X, y: centerY },
        data: {
          decision: d,
          finalizerCount,
        } satisfies BftNodeData,
        draggable: false,
        selectable: false,
      });

      // Coral edges: PoW → BFT (fat pointer, many-to-one)
      for (
        let h = d.first_seen_at_pow_height;
        h <= d.last_seen_at_pow_height;
        h++
      ) {
        const block = blocks.find((b) => b.height === h);
        if (!block) continue;
        bftEdges.push({
          id: `pow2bft-${block.hash}-${d.referenced_hash}`,
          source: `pow-${block.hash}`,
          sourceHandle: 'pow',
          target: nodeId,
          targetHandle: 'bft-in',
          type: 'bezier',
          style: {
            stroke: COLOR_BFT_EDGE,
            strokeWidth: 1.6,
          },
        });
      }

      // NOTE: per-decision "finalizes" arrow needs a backend column
      // (bft_finalized_pow_height) we don't yet store — bft_referenced_hash
      // is the BFT block's own hash, not the PoW it commits. We draw a
      // single global "finality frontier" arrow below instead.
    }

    // Finality frontier arrow: draw from the most recent BFT decision back
    // to the finalized PoW block. If the exact finalized block is below the
    // loaded range, target the lowest visible finalized block instead and
    // annotate the label so the user knows the real height.
    if (decisions.length > 0 && stats?.finalizedHeight) {
      const latestDecision = decisions[0];
      const sourceNodeId = `bft-${latestDecision.referenced_hash}`;
      const sourceExists = bftNodes.some((n) => n.id === sourceNodeId);

      // Find the best target: exact finalized block, or lowest visible finalized block
      let targetBlock: PowBlock | undefined;
      let isBelowView = false;
      if (yByHeight.has(stats.finalizedHeight)) {
        targetBlock = blocks.find((b) => b.height === stats.finalizedHeight);
      } else {
        // Finalized block isn't loaded — pick the lowest visible block that is finalized
        const finalized = blocks.filter((b) => stats.finalizedHeight != null && b.height <= stats.finalizedHeight);
        if (finalized.length > 0) {
          targetBlock = finalized[finalized.length - 1];
          isBelowView = true;
        }
      }

      if (targetBlock && sourceExists) {
        const label = isBelowView
          ? `finalizes through #${stats.finalizedHeight?.toLocaleString() ?? (stats.crosslinkActive === false ? 'Not active' : 'Unavailable')} (below view)`
          : `finalizes through #${stats.finalizedHeight?.toLocaleString() ?? (stats.crosslinkActive === false ? 'Not active' : 'Unavailable')}`;
        bftEdges.push({
          id: 'finality-frontier',
          source: sourceNodeId,
          sourceHandle: 'bft-out',
          target: `pow-${targetBlock.hash}`,
          targetHandle: 'pow-in',
          type: 'smoothstep',
          style: {
            stroke: COLOR_FINALIZE,
            strokeWidth: 2,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 14,
            height: 14,
            color: COLOR_FINALIZE,
          },
          label,
          labelStyle: {
            fill: COLOR_FINALIZE,
            fontFamily: 'var(--font-geist-mono), monospace',
            fontSize: 12,
            letterSpacing: '0.05em',
          },
          labelBgStyle: { fill: 'var(--color-surface)', stroke: 'var(--color-border)', strokeWidth: 0.5 },
          labelBgPadding: [6, 3],
          labelBgBorderRadius: 4,
          zIndex: 10,
        });
      }
    }

    // Voting pointer: BFT's current live vote
    if (bftTip?.votedBlockHash && yByHash.has(bftTip.votedBlockHash)) {
      const y =
        yByHash.get(bftTip.votedBlockHash)! + (POW_HEIGHT - BFT_SIZE) / 2;
      const nodeId = 'bft-voting';
      bftNodes.push({
        id: nodeId,
        type: 'bft',
        position: { x: BFT_X, y },
        data: {
          decision: {
            referenced_hash: bftTip.votedBlockHash,
            signature_count: bftTip.signatureCount,
            pow_blocks_in_decision: 1,
            first_seen_at_pow_height: 0,
            last_seen_at_pow_height: 0,
            signer_keys: bftTip.signers
              .map((s) => s.pub_key)
              .filter(Boolean) as string[],
          },
          finalizerCount,
          isVoting: true,
        } satisfies BftNodeData,
        draggable: false,
        selectable: false,
      });
      bftEdges.push({
        id: 'voting-ref',
        source: nodeId,
        sourceHandle: 'bft-out',
        target: `pow-${bftTip.votedBlockHash}`,
        targetHandle: 'pow-in',
        type: 'smoothstep',
        animated: true,
        style: {
          stroke: COLOR_VOTING_EDGE,
          strokeWidth: 1.6,
          strokeDasharray: '4 3',
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 12,
          height: 12,
          color: COLOR_VOTING,
        },
      });
    }

    return { nodes: [...powNodes, ...bftNodes], edges: bftEdges };
  }, [blocks, decisions, stats, bftTip]);

  // Clamp panning so users can't scroll into empty space
  const translateExtent = useMemo<[[number, number], [number, number]]>(() => {
    if (blocks.length === 0) return [[-Infinity, -Infinity], [Infinity, Infinity]];
    const padding = 80;
    const minX = POW_X - padding;
    const minY = -padding;
    const maxX = BFT_X + BFT_NODE_WIDTH + padding;
    const maxY = (blocks.length - 1) * ROW_HEIGHT + POW_HEIGHT + padding;
    return [[minX, minY], [maxX, maxY]];
  }, [blocks.length]);

  const openDivergence = stats && (stats.finalityGap ?? 0) > 20;

  return (
    <div className="space-y-4">
      {/* Stats + explanation — part of the page, not a floating overlay */}
      {!isEmbedded && stats && (
        <div className="card p-0 overflow-hidden">
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-cipher-border-alpha/60">
            <HeaderStat
              label="PoW tip"
              value={`#${stats.tipHeight.toLocaleString()}`}
              tooltip="Latest block mined by PoW miners."
            />
            <HeaderStat
              label="Finalized"
              value={stats.finalizedHeight == null ? (stats.crosslinkActive === false ? 'Not active' : 'Unavailable') : `#${stats.finalizedHeight.toLocaleString()}`}
              valueClass="text-cipher-green"
              tooltip="Highest block irreversibly confirmed by BFT consensus."
            />
            <HeaderStat
              label="Finality gap"
              value={stats.finalityGap == null ? (stats.crosslinkActive === false ? 'Not active' : 'Unavailable') : `${stats.finalityGap}`}
              sub="blocks"
              valueClass={
                openDivergence ? 'text-cipher-orange' : 'text-primary'
              }
              tooltip="Blocks between PoW tip and last finalized block. Healthy: 0–10."
            />
            <HeaderStat
              label="Finalizers"
              value={`${stats.finalizerCount}`}
              sub={
                stats.totalStakeZec > 0
                  ? `${stats.totalStakeZec.toFixed(0)} cTAZ`
                  : undefined
              }
              tooltip="Validators signing BFT votes. Quorum ≈ ⅔ of these."
            />
          </div>
        </div>
      )}

      {/* Legend — explains what you're actually looking at */}
      {!isEmbedded && (
      <div className="card p-3 sm:p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-x-6 md:gap-y-2 text-xs">
          <div className="flex items-start gap-2.5">
            <span className="mt-1 inline-block w-5 h-3 rounded-sm bg-cipher-gold-muted/25 border border-cipher-gold-muted/50 shrink-0" />
            <p className="text-secondary leading-snug">
              <span className="text-primary font-semibold">Left — PoW blocks.</span>{' '}
              Produced by miners. Click one to inspect its transactions.
            </p>
          </div>
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 inline-block w-4 h-4 rounded-full bg-[rgba(239,108,96,0.15)] border border-[rgba(239,108,96,0.7)] shrink-0" />
            <p className="text-secondary leading-snug">
              <span className="text-primary font-semibold">Right — BFT decisions.</span>{' '}
              The number inside is how many finalizers signed it.
            </p>
          </div>
          <div className="flex items-start gap-2.5">
            <span
              className="mt-2 inline-block h-[2px] w-6 shrink-0"
              style={{ background: COLOR_BFT_EDGE }}
            />
            <p className="text-secondary leading-snug">
              <span className="text-primary font-semibold">Coral lines — fat pointer.</span>{' '}
              Each PoW block embeds a pointer to the BFT chain tip it observed.
            </p>
          </div>
          <div className="flex items-start gap-2.5">
            <span
              className="mt-2 inline-block h-[2px] w-6 shrink-0"
              style={{ background: COLOR_FINALIZE }}
            />
            <p className="text-secondary leading-snug">
              <span className="text-primary font-semibold">Teal arrow — finality frontier.</span>{' '}
              The PoW block at which the chain is currently locked in as irreversible.
            </p>
          </div>
        </div>
      </div>
      )}

      {/* Graph canvas */}
      <div
        className={`${styles.root} relative w-full card p-0 overflow-hidden ${
          isEmbedded
            ? ''
            : 'h-[calc(100vh-260px)] min-h-[560px]'
        }`}
        style={isEmbedded ? { height: height || '560px' } : undefined}
      >
        {loading && nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-cipher-gold border-t-transparent" />
          </div>
        )}

        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultViewport={{ x: 120, y: 32, zoom: 1 }}
          fitView={false}
          translateExtent={translateExtent}
          minZoom={0.35}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Vertical}
          panOnScrollSpeed={0.6}
          zoomOnPinch
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
          style={{ background: 'transparent' }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="var(--color-map-dot)"
          />
          <Controls
            position="bottom-right"
            showInteractive={false}
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              overflow: 'hidden',
            }}
          />
          {!isEmbedded && (
            <MiniMap
              position="top-right"
              pannable
              zoomable
              nodeColor={(n) => {
                if (n.type === 'bft') {
                  const d = n.data as BftNodeData;
                  return d.isVoting ? COLOR_VOTING : COLOR_BFT;
                }
                const s = (n.data as PowNodeData).state;
                if (s === 'voting') return COLOR_VOTING;
                return COLOR_POW_DIM;
              }}
              nodeStrokeWidth={0}
              nodeBorderRadius={3}
              style={{
                width: 180,
                height: 128,
                border: '1px solid var(--color-border)',
                borderRadius: 8,
              }}
            />
          )}
        </ReactFlow>
      </div>

      {/* Footer: load-more (full mode only) or "open chain view" link (embedded) */}
      {!isEmbedded ? (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="text-xs font-mono text-muted">
            {blocks.length > 0 &&
              `Showing ${blocks.length} latest PoW blocks · ${decisions.length} BFT decisions`}
          </span>
          <button
            onClick={loadOlder}
            disabled={loadingMore || limit >= 200}
            className="text-xs font-mono px-3 py-1.5 rounded-md border border-cipher-border hover:border-cipher-gold/50 hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed text-secondary transition-colors"
          >
            {limit >= 500
              ? 'Maximum history loaded'
              : loadingMore
              ? 'Loading…'
              : 'Load 50 older blocks →'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header stat cell
// ---------------------------------------------------------------------------

function HeaderStat({
  label,
  value,
  sub,
  valueClass,
  tooltip,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
  tooltip?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center p-4 sm:p-5">
      <div className="text-caption font-mono text-muted uppercase tracking-wider mb-1 flex items-center gap-1">
        <span>{label}</span>
        {tooltip && <Tooltip content={tooltip} />}
      </div>
      <div
        className={`text-lg sm:text-xl font-mono font-semibold tabular-nums ${
          valueClass || 'text-primary'
        }`}
      >
        {value}
      </div>
      {sub && (
        <div className="text-caption font-mono text-muted mt-0.5 tabular-nums">
          {sub}
        </div>
      )}
    </div>
  );
}
