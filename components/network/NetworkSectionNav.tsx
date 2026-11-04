import Link from 'next/link';
import { isCrosslink } from '@/lib/config';

export function NetworkSectionNav({ onTechnicalNavigate }: { onTechnicalNavigate: () => void }) {
  return (
    <nav aria-label="Network page sections" className="flex flex-wrap items-center gap-x-5 gap-y-3 text-caption font-mono text-muted mb-5">
      <a href="#network-protocol" className="hover:text-primary">Overview</a>
      <a href="#network-nodes" className="hover:text-primary">Nodes</a>
      <a href="#network-activity" className="hover:text-primary">Activity</a>
      {!isCrosslink && <a href="#block-speed" className="hover:text-primary">Block speed</a>}
      {!isCrosslink && <a href="#nu7-accounting" className="hover:text-primary">NSM &amp; fees</a>}
      <a href="#issuance" className="hover:text-primary">Issuance &amp; halving</a>
      <a href="#network-technical" onClick={onTechnicalNavigate} className="hover:text-primary">Technical details</a>
      <div className="sm:ml-auto flex flex-wrap items-center gap-x-5 gap-y-3">
        {!isCrosslink && <Link href="/network/upgrades" className="text-secondary hover:text-cipher-gold">Upgrades →</Link>}
        <Link href="/network/nodes" className="text-secondary hover:text-cipher-gold">Node explorer →</Link>
      </div>
    </nav>
  );
}
