import type { ReactNode } from 'react';
import { CopyButton } from '@/components/CopyButton';

// These build-only adapters leave production components untouched. Navigation,
// remote enrichments and selectors in resource URLs are excluded from this app.
export default function LocalText({ children, className, title }: { children: ReactNode; className?: string; title?: string; [key: string]: unknown }) {
  return <span className={className} title={title}>{children}</span>;
}

export function AddressWithLabel({ address, truncate = true, className = '' }: { address: string; truncate?: boolean; className?: string; [key: string]: unknown }) {
  const text = truncate ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
  return <span className={`font-mono ${className}`} title={address}>{text}</span>;
}

export function AddressDisplay({ address, className = '' }: { address: string; className?: string }) {
  return <span className={`font-mono text-primary ${className}`} title={address}>{address.slice(0, 6)}...{address.slice(-4)}</span>;
}

export function useAddressLabel(address: string): { label: string; description?: string; isOfficial: boolean } | null {
  void address;
  return null;
}

export function PrivacyRiskInline(props?: { txid?: string; variant?: string; embedded?: boolean }) {
  void props;
  return <p className="text-caption text-muted border-t border-cipher-border pt-3">Privacy-risk enrichment is unavailable in this publication. No additional request is made.</p>;
}

export function TokenChainIcon({ token, chain }: { token: string; chain: string; size?: number }) {
  return <span className="private-token-symbol" title={`${token} on ${chain}`}>{token.slice(0, 3)}</span>;
}

export function Tooltip({ content, children, label = 'More information' }: { content: string; children?: ReactNode; label?: string }) {
  return <span className="inline-flex text-muted cursor-help" title={content} role="img" aria-label={`${label}: ${content}`}>
    {children ?? <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" /></svg>}
  </span>;
}

export function IconTooltip({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <span title={label} role="img" aria-label={label} className={`inline-flex items-center justify-center ${className}`}>{children}</span>;
}

export function BridgeExplorerLinks({ bridges }: { bridges: Array<{ otherChain: string; otherTxHash: string | null }> }) {
  return <div className="space-y-2">{bridges.map((bridge, index) => bridge.otherTxHash ? <div key={index} className="flex items-center gap-2 text-xs text-muted font-mono">
    <span>{bridge.otherChain.toUpperCase()} transaction</span><code className="break-all text-secondary">{bridge.otherTxHash}</code><CopyButton text={bridge.otherTxHash} size="xs" />
  </div> : null)}</div>;
}
