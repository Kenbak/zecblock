'use client';

import { readApiData } from '@/lib/api-client';
import { useState, useEffect } from 'react';
import { getApiUrl } from '@/lib/api-config';
import { CURRENCY } from '@/lib/config';
import { AddressDisplay } from '@/components/AddressWithLabel';
import { PrivacyLinkGraph } from '@/components/PrivacyLinkGraph';
import { HashLink } from '@/components/ui/HashLink';
import { Badge } from '@/components/ui/Badge';

interface LinkedTransaction {
  txid: string;
  flowType: 'shield' | 'deshield';
  amount: number;
  timeDelta: string;
  linkabilityScore: number;
  transparentAddresses?: string[];
}

interface LinkabilityData {
  success: boolean;
  txid: string;
  flowType: 'shield' | 'deshield' | null;
  amount: number;
  hasShieldedActivity: boolean;
  warningLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  highestScore: number;
  linkedTransactions: LinkedTransaction[];
  transparentAddresses?: string[];
}

interface PrivacyGraphData {
  success: boolean;
  nodes: Array<{
    id: string;
    type: 'transaction' | 'address';
    label: string;
    amountZec?: number;
    blockTime?: number;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    type: string;
    confidence: number;
    label?: string;
  }>;
}

interface PrivacyRiskInlineProps {
  txid: string;
  variant?: 'compact' | 'full';
  embedded?: boolean;
}

const WarningIcon = () => (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
    />
  </svg>
);

const ClearIcon = () => (
  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
    />
  </svg>
);

const LinkIcon = () => (
  <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
    />
  </svg>
);

function cleanTimeDelta(delta?: string): string {
  return (
    delta
      ?.replace(' after', ' later')
      ?.replace('1 minutes', '1 minute')
      ?.replace('1 hours', '1 hour')
      ?.replace('1 days', '1 day') || ''
  );
}

export function PrivacyRiskInline({ txid, variant = 'full', embedded = false }: PrivacyRiskInlineProps) {
  const [data, setData] = useState<LinkabilityData | null>(null);
  const [graph, setGraph] = useState<PrivacyGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showWhy, setShowWhy] = useState(false);
  const [showGraph, setShowGraph] = useState(false);

  useEffect(() => {
    const fetchLinkability = async () => {
      try {
        const baseUrl = getApiUrl();
        const [linkabilityResponse, graphResponse] = await Promise.all([
          fetch(`${baseUrl}/v1/transactions/${txid}/linkability`),
          fetch(`${baseUrl}/v1/privacy/graph/${txid}`),
        ]);

        if (linkabilityResponse.ok) {
          const result = await readApiData(linkabilityResponse);
          if (result) {
            setData(result);
          }
        }

        if (graphResponse.ok) {
          const graphResult = await readApiData(graphResponse);
          if (graphResult) {
            setGraph(graphResult);
          }
        }
      } catch (error) {
        console.error('Failed to fetch linkability:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchLinkability();
  }, [txid]);

  if (loading || !data || !data.hasShieldedActivity) {
    return null;
  }

  // Compact variant: single-line alert for hero sections.
  if (variant === 'compact') {
    const hasRisk = data.linkedTransactions.length > 0 && data.warningLevel !== 'LOW';
    const isHigh = data.warningLevel === 'HIGH';

    return (
      <Badge
        color={hasRisk ? (isHigh ? 'danger' : 'orange') : 'green'}
        icon={hasRisk ? <WarningIcon /> : <ClearIcon />}
        variant="subtle"
      >
        {hasRisk ? `Privacy risk ${data.highestScore}/100 — round-trip` : 'No round-trip detected'}
      </Badge>
    );
  }

  // No linkage found — the reassuring, low-key state.
  if (data.linkedTransactions.length === 0 || data.warningLevel === 'LOW') {
    const amountZec = (data.amount || 0).toFixed(4);
    const flowVerb = data.flowType === 'shield' ? 'shielded' : 'deshielded';
    const address = data.transparentAddresses?.[0];

    return (
      <div className={embedded ? 'border-t border-cipher-border pt-3' : 'card card-compact'}>
        <div className="flex items-center justify-between mb-3">
          <Badge color="green" icon={<ClearIcon />} variant="subtle">
            No round-trip detected
          </Badge>
          <span className="text-caption font-mono text-muted">0/100</span>
        </div>

        <p className="text-caption text-muted leading-relaxed">
          This transaction {flowVerb}{' '}
          <span className="text-primary font-medium">
            {amountZec} {CURRENCY}
          </span>
          {address && (
            <>
              {data.flowType === 'shield' ? ' from ' : ' to '}
              <AddressDisplay address={address} className="text-caption" />
            </>
          )}
          . No matching {data.flowType === 'shield' ? 'deshield' : 'shield'} with a similar amount and timing turned up
          on the other side of the pool, so there's nothing here for an outside observer to connect.
        </p>
      </div>
    );
  }

  const topMatch = data.linkedTransactions[0];
  const linkedAddress = topMatch?.transparentAddresses?.[0];
  const currentAddress = data.transparentAddresses?.[0];
  const isDeshield = data.flowType === 'deshield';
  const isHigh = data.warningLevel === 'HIGH';
  const amountZec = data.amount.toFixed(4);
  const timeDelta = cleanTimeDelta(topMatch?.timeDelta);

  return (
    <div className={embedded ? 'border-t border-cipher-border pt-3' : 'card card-compact'}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <Badge color={isHigh ? 'danger' : 'orange'} icon={<WarningIcon />} variant="subtle">
          {isHigh ? 'High' : 'Medium'} privacy risk — {data.highestScore}/100
        </Badge>
        <span className="text-caption font-mono text-muted uppercase tracking-wider">round-trip pattern</span>
      </div>

      <p className="text-sm text-secondary leading-relaxed">
        This transaction {isDeshield ? 'moves' : 'moved'}{' '}
        <span className="text-primary font-medium">
          {amountZec} {CURRENCY}
        </span>{' '}
        {isDeshield ? 'out of the shielded pool to' : 'from'}{' '}
        {currentAddress ? <AddressDisplay address={currentAddress} className="text-xs" /> : 'a transparent address'}
        {isDeshield ? '' : ' into the shielded pool'}.{' '}
        {timeDelta && <>{timeDelta.charAt(0).toUpperCase() + timeDelta.slice(1)}, </>}a very similar amount was{' '}
        {isDeshield ? 'shielded' : 'deshielded'}{' '}
        {linkedAddress ? (
          <>
            {isDeshield ? 'from ' : 'to '}
            <AddressDisplay address={linkedAddress} className="text-xs" />
          </>
        ) : (
          'on the other side of the pool'
        )}
        .{' '}
        {currentAddress && linkedAddress && currentAddress === linkedAddress ? (
          <>
            Both sides use the same address, so the round trip is directly visible to any observer — the pass through
            the shielded pool hid nothing.
          </>
        ) : (
          <>
            Because the amount and timing line up this closely, an outside observer could reasonably guess that{' '}
            {currentAddress ? <AddressDisplay address={currentAddress} className="text-xs" /> : 'this address'} and{' '}
            {linkedAddress ? <AddressDisplay address={linkedAddress} className="text-xs" /> : 'the other address'} belong
            to the same wallet — even though the shielded transfer itself stayed private.
          </>
        )}
      </p>

      <div className="flex items-center gap-2 text-xs text-muted mt-3 flex-wrap">
        <LinkIcon />
        <span>Linked transaction:</span>
        <HashLink value={topMatch.txid} href={`/tx/${topMatch.txid}`} copy={false} />
      </div>

      <div className="pt-2 mt-1">
        <div className="h-px bg-glass-4 mb-2" aria-hidden />
        <div className="flex items-center gap-4">
          {graph && graph.nodes.length > 0 && graph.edges.length > 0 && (
            <button
              onClick={() => setShowGraph(!showGraph)}
              className="text-xs text-muted hover:text-secondary flex items-center gap-1 transition-colors"
            >
              {showGraph ? 'Hide' : 'Show'} linkage graph
              <svg
                className={`w-3 h-3 transition-transform ${showGraph ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          )}
          <button
            onClick={() => setShowWhy(!showWhy)}
            className="text-xs text-muted hover:text-secondary flex items-center gap-1 transition-colors"
          >
            {showWhy ? 'Hide' : 'Why is this a risk?'}
            <svg
              className={`w-3 h-3 transition-transform ${showWhy ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {showGraph && graph && graph.nodes.length > 0 && graph.edges.length > 0 && (
          <div className="mt-3">
            <PrivacyLinkGraph nodes={graph.nodes} edges={graph.edges} focusNodeId={txid} height={220} />
          </div>
        )}

        {showWhy && (
          <div className="mt-3 text-xs text-secondary leading-relaxed space-y-2">
            <p>
              Shielded transactions hide amounts and addresses — but the pool itself is shared by everyone. If you
              shield and then deshield a similar amount within a short window, the amount and timing act as a
              fingerprint an outside observer can match up, even without ever seeing inside the shielded pool.
            </p>
            <p className="text-muted">
              The only reliable defense is to <strong className="text-primary">ZODL</strong> — leave your{' '}
              {CURRENCY} shielded longer, so timing and amount no longer line up cleanly with anything on the
              transparent side.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
