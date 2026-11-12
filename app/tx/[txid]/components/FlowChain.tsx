'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { AddressDisplay } from '@/components/AddressWithLabel';
import { useAddressLabel } from '@/lib/address-labels';
import { Badge, type BadgeColor } from '@/components/ui/Badge';
import { TokenChainIcon } from '@/components/TokenChainIcon';
import { ShieldedIcon } from '@/components/icons/shield-flow';
import { EntityLogo } from '@/components/EntityLogo';
import { PoolLogo } from '@/components/PoolLogo';

/**
 * A single endpoint in a transaction's flow. A transaction can have more
 * than one node on either side (a mixed shield+transfer, a batched bridge,
 * a multi-recipient payment) — that's the whole point of this component
 * over a fixed two-box "from -> to" layout.
 */
export type FlowNode =
  | { kind: 'address'; address: string; amount?: number }
  | { kind: 'pool'; label: string; color: BadgeColor; amount?: number }
  | { kind: 'token'; token: string; chain: string; amount?: number | null }
  | { kind: 'more'; count: number; amount?: number }
  | { kind: 'unknown' };

const CheckmarkIcon = ({ className = 'w-3 h-3' }: { className?: string }) => (
  <svg className={className} fill="currentColor" viewBox="0 0 20 20">
    <path
      fillRule="evenodd"
      d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
      clipRule="evenodd"
    />
  </svg>
);

/**
 * A plain address gets plain mono text like everywhere else, but a *known
 * named entity* (a bridge, exchange, etc.) gets the same badge treatment
 * pool/token nodes already have in this diagram — otherwise a named service
 * and an anonymous address look identical in the one place distinguishing
 * them matters most. Prose mentions of the same address stay plain text
 * (see AddressWithLabel) — badges are for scannable diagram nodes, not
 * words in a sentence.
 */
function FlowAddressNode({ address }: { address: string }) {
  const labelInfo = useAddressLabel(address);
  if (!labelInfo) return <AddressDisplay address={address} className="text-xs" />;
  return (
    <Link href={`/address/${address}`} prefetch={false} className="transition-colors">
      <Badge
        color={labelInfo.isOfficial ? 'gold' : 'muted'}
        variant="subtle"
        className="badge-link"
        icon={labelInfo.isOfficial ? <CheckmarkIcon /> : undefined}
      >
        <span className="inline-flex items-center gap-1.5">
          {labelInfo.isOfficial && (labelInfo.category === 'mining'
            ? <PoolLogo name={labelInfo.label} />
            : <EntityLogo label={labelInfo.label} category={labelInfo.category} />)}
          {labelInfo.label}
        </span>
      </Badge>
    </Link>
  );
}

function FlowNodeView({ node }: { node: FlowNode }) {
  switch (node.kind) {
    // Per-node ZEC amounts are intentionally not shown for address/pool/more
    // — that breakdown is already available in the Inputs/Outputs tab, and
    // repeating it here just adds numbers to double-check against the
    // center amount instead of a quick "who/what" read.
    case 'address':
      return (
        <div className="flex flex-col items-center gap-0.5">
          <FlowAddressNode address={node.address} />
        </div>
      );
    case 'pool':
      return (
        <div className="flex flex-col items-center gap-1">
          <Badge color={node.color} icon={<ShieldedIcon size={14} />} variant="subtle">
            {node.label}
          </Badge>
        </div>
      );
    case 'token':
      return (
        <div className="flex items-center gap-2">
          <TokenChainIcon token={node.token} chain={node.chain} size={22} />
          <span className="text-xs font-mono text-primary">
            {node.amount != null
              ? `${node.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${node.token}`
              : node.token}
          </span>
        </div>
      );
    case 'more':
      return <span className="text-caption text-muted font-mono">+{node.count} more</span>;
    case 'unknown':
    default:
      return <span className="text-sm text-muted">—</span>;
  }
}

function FlowNodeGroup({ nodes }: { nodes: FlowNode[] }) {
  const items = nodes.length > 0 ? nodes : [{ kind: 'unknown' } as FlowNode];

  // A single endpoint (the common case) needs no visual framing — the arrow
  // on either side already marks it as one thing.
  if (items.length === 1) {
    return (
      <div className="flex flex-col items-center gap-1.5">
        <FlowNodeView node={items[0]} />
      </div>
    );
  }

  // Multiple nodes on one side (a primary party + "+N more", or a batch of
  // pool/token legs) previously just stacked as bare text with no shared
  // boundary — nothing tied them together as *one* source/destination, so
  // it read as a stray, unexplained list. Wrapping them in one bordered
  // card with a divider between entries makes it legible as a single
  // grouped endpoint at a glance.
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-cipher-border/60 bg-cipher-surface/40 px-3.5 py-2.5">
      {items.map((node, i) => (
        <div
          key={i}
          className={`flex flex-col items-center ${i > 0 ? 'pt-2 border-t border-cipher-border/40 w-full' : ''}`}
        >
          <FlowNodeView node={node} />
        </div>
      ))}
    </div>
  );
}

function FlowArrow() {
  return <span className="text-muted hidden sm:inline">→</span>;
}

function FlowArrowDown() {
  return <span className="text-muted sm:hidden">↓</span>;
}

interface FlowChainProps {
  sources: FlowNode[];
  destinations: FlowNode[];
  /** Center content — omit entirely for flows where each node already carries its own amount (e.g. bridges). */
  amount?: ReactNode;
}

/**
 * Renders `sources -> [amount] -> destinations`, where either side can hold
 * multiple stacked nodes. Replaces the old fixed-arity layout that could only
 * ever show one address per side, which silently dropped information on
 * mixed, batched, or multi-recipient transactions.
 */
export function FlowChain({ sources, destinations, amount }: FlowChainProps) {
  return (
    <div className="flex flex-col sm:flex-row items-center justify-center gap-2.5 sm:gap-4">
      <FlowNodeGroup nodes={sources} />
      {amount !== undefined && (
        <>
          <FlowArrow />
          <FlowArrowDown />
          {amount}
        </>
      )}
      <FlowArrow />
      <FlowArrowDown />
      <FlowNodeGroup nodes={destinations} />
    </div>
  );
}
