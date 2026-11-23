import PrivacyClient from './PrivacyClient';
import { getBaseUrl } from '@/lib/seo';
import { PageAbout } from '@/components/HomeAbout';

export default function PrivacyPage() {
  const url = `${getBaseUrl()}/privacy`;
  const schema = {
    '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${url}#webpage`,
    url, name: 'Zcash Privacy Score',
    description: 'A weighted index of observed shielded participation, transaction patterns, supply and reshielding.',
    isPartOf: { '@id': `${getBaseUrl()}/#website` }, publisher: { '@id': 'https://zecblock.com/#organization' },
  };
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
    <PrivacyClient />
    <section id="how-it-works" className="scroll-mt-36 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
      <details open className="network-detail-panel network-detail-disclosure rounded-lg border border-cipher-border">
        <summary className="network-detail-toggle"><span><span className="block text-sm font-mono text-primary">Methodology & limits</span><span className="block text-caption text-muted mt-1">Weights, data windows and what the score cannot measure.</span></span><svg className="network-detail-chevron w-4 h-4 text-muted shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" /></svg></summary>
        <div className="border-t border-cipher-border p-5 sm:p-6 grid md:grid-cols-2 gap-8 text-sm text-muted leading-relaxed">
          <div><h2 className="font-mono text-primary text-sm mb-3">How the score is calculated</h2><p>Model v2 assigns up to 33 points to shielded participation, 33 to fully shielded share, 20 to shielded supply and 14 to tracked reshielding. Each input percentage is multiplied by its weight; the sum is rounded to an integer from 0 to 100.</p><p className="mt-3">Activity uses a 30-day window and Sapling, Orchard and Ironwood transaction flags. The implementation includes shielded coinbase transactions in the shielded count, while excluding coinbase from transparent and fully shielded counts. Supply is the indexed snapshot; reshielding uses 90 days of turnstile records.</p></div>
          <div><h2 className="font-mono text-primary text-sm mb-3">How to read the result</h2><p>This is a ZecBlock model of observed network usage, not a cryptographic security audit or a probability that a transaction can be linked. Higher public flow counts do not establish an individual anonymity set.</p><p className="mt-3">The current model treats absent or unavailable turnstile inputs as zero, so a low reshielding contribution can reflect data coverage. Historical values can reflect formula changes. The score updates on the statistics job’s hourly schedule; the transaction feed updates independently.</p></div>
        </div>
      </details>
    </section>
    <PageAbout path="/privacy" />
  </>;
}
