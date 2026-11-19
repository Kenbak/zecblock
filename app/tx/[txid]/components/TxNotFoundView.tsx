'use client';

import Link from 'next/link';
import { Card, CardBody } from '@/components/ui/Card';
import type { LookupState } from './types';

interface TxNotFoundViewProps {
  lookupState: LookupState;
  blockFallbackChecked: boolean;
  mempoolChecked: boolean;
  txid: string;
}

export function TxNotFoundView({
  lookupState,
  blockFallbackChecked,
  mempoolChecked,
}: TxNotFoundViewProps) {
  const isUnavailable = lookupState === 'unavailable';
  const isChecking =
    lookupState === 'missing' && (!blockFallbackChecked || (!mempoolChecked && blockFallbackChecked));

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-12 animate-fade-in">
      <div className="mb-8">
        <span className="text-xs font-mono text-muted tracking-wider">&gt; TX_LOOKUP</span>
        <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-primary mt-1">
          Transaction Details
        </h2>
      </div>
      <Card role={isChecking ? 'status' : 'alert'} ariaLive={isChecking ? 'polite' : 'assertive'}>
        <CardBody>
          <div className="text-center py-12">
            {isChecking ? (
              <>
                <div className="animate-spin rounded-full h-10 w-10 border-2 border-cipher-gold border-t-transparent mx-auto mb-5" aria-hidden="true"></div>
                <p className="text-sm text-secondary font-mono">Looking up transaction...</p>
              </>
            ) : (
              <>
                <div className="w-14 h-14 mx-auto mb-5 rounded-xl bg-cipher-card border border-white/[0.04] flex items-center justify-center">
                  <svg className="w-7 h-7 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                </div>
                <h2 className="text-lg font-semibold text-primary mb-2">
                  {isUnavailable ? 'Transaction Status Unavailable' : 'Transaction Not Found'}
                </h2>
                <p className="text-sm text-secondary mb-6 max-w-md mx-auto">
                  {isUnavailable
                    ? 'ZecBlock could not reach the transaction data service. Try this lookup again shortly.'
                    : 'This transaction is not in the indexed chain or current mempool.'}
                </p>
                <Link
                  href="/"
                  className="text-cipher-gold hover:text-cipher-yellow transition-colors font-mono text-sm"
                >
                  &larr; Back to Explorer
                </Link>
              </>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
