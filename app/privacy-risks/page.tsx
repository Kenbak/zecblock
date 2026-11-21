import { Suspense } from 'react';
import { PageHeader } from '@/components/ui/SectionHeader';
import { RiskResultsSkeleton } from '@/components/privacy/RiskEvidence';
import { getBaseUrl } from '@/lib/seo';
import PrivacyRisksClient from './PrivacyRisksClient';

export default function PrivacyRisksPage() {
  const base = getBaseUrl();
  const schema = {
    '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${base}/privacy-risks#webpage`,
    url: `${base}/privacy-risks`, name: 'Zcash Privacy Risk Analysis',
    description: 'Explore public amount and timing patterns around shielded activity. Candidate links are heuristic observations, not proof of ownership.',
    isPartOf: { '@id': `${base}/#website` }, publisher: { '@id': 'https://zecblock.com/#organization' },
  };
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
    <PageHeader eyebrow="PRIVACY_ANALYSIS" title="Zcash Privacy Risk Analysis" subtitle="Explore public amount and timing patterns around shielded activity. Inspect the evidence behind each candidate link." />
    <p className="mb-8 max-w-4xl text-sm text-secondary leading-relaxed">Scores rank patterns in public data. A high score is a lead to check, not proof that two transactions are linked.</p>
    <Suspense fallback={<RiskResultsSkeleton />}><PrivacyRisksClient /></Suspense>
  </div>;
}
