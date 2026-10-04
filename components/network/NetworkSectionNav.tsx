import Link from 'next/link';
import { isCrosslink } from '@/lib/config';

export function NetworkSectionNav({ onTechnicalNavigate, nu7Active = false }: { onTechnicalNavigate: () => void; nu7Active?: boolean }) {
  return (
    <nav aria-label="Network page sections" className="flex flex-wrap items-center gap-x-5 gap-y-3 text-caption font-mono text-muted mb-5">
      <a href="#network-protocol" className="hover:text-primary">Overview</a>
      <a href="#network-nodes" className="hover:text-primary">Nodes</a>
      <a href="#network-activity" className="hover:text-primary">Activity</a>
      {!isCrosslink && <a href="#network-accounting" className="hover:text-primary">Block timing</a>}
      {!isCrosslink && nu7Active && <a href="#nu7-accounting" className="hover:text-primary">NU7 accounting</a>}
      <a href="#issuance" className="hover:text-primary">Issuance &amp; halving</a>
      <a href="#network-technical" onClick={onTechnicalNavigate} className="hover:text-primary">Technical details</a>
      <Link href="/network/nodes" className="sm:ml-auto text-secondary hover:text-cipher-gold">Node explorer →</Link>
    </nav>
  );
}
