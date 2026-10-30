import Link from 'next/link';
import { buildPageMetadata, getBaseUrl } from '@/lib/seo';
import { PageHeader } from '@/components/ui/SectionHeader';

export const metadata = buildPageMetadata({
  title: 'Privacy Policy | ZecBlock',
  description: 'Read how ZecBlock handles analytics, logs, local browser data, and public Zcash blockchain information while protecting visitor privacy.',
  path: '/privacy-policy',
  networks: ['mainnet'],
});

export default function PrivacyPolicyPage() {
  const updated = 'October 30, 2026';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
        '@context': 'https://schema.org', '@type': 'WebPage',
        '@id': `${getBaseUrl()}/privacy-policy#webpage`, url: `${getBaseUrl()}/privacy-policy`,
        name: 'Privacy Policy', isPartOf: { '@id': `${getBaseUrl()}/#website` },
        publisher: { '@id': 'https://zecblock.com/#organization' },
      }) }} />
      <PageHeader
        eyebrow="LEGAL"
        title="Privacy Policy"
        subtitle={<span className="font-mono">Last updated: {updated}</span>}
      />

      <div className="prose-legal space-y-8 text-sm text-secondary leading-relaxed">
        <section>
          <h2 className="text-lg font-semibold text-primary mb-3">1. Who We Are</h2>
          <p>
            ZecBlock (<Link href="/" className="legal-link">zecblock.com</Link>) is
            an open-source Zcash blockchain explorer operated by Atmosphere Labs (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;).
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-primary mb-3">2. Information We Collect</h2>
          <p className="mb-3">You can browse without creating an account. The information processed depends on the pages and tools you use.</p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong className="text-primary">Requests and diagnostics:</strong> Our hosting, API and security services process connection information such as IP addresses, requested URLs and browser headers to deliver responses, limit abuse and diagnose failures. Infrastructure providers may retain operational logs; we do not promise that requests are unlogged.</li>
            <li><strong className="text-primary">Explorer lookups:</strong> Looking up an address, transaction or block sends that public identifier to our services. Public chain data and derived observations are indexed for the explorer. Shielded addresses, amounts and memos cannot be read from public chain data without the required keys or a voluntary disclosure.</li>
            <li><strong className="text-primary">Viewing keys:</strong> The memo and inbox tools process viewing keys in your browser. The application does not send those keys to our API. It requests blockchain data and matching transaction data, which can reveal requested ranges or transaction identifiers to the services supplying them. Keep viewing keys, recovery phrases and private keys out of search fields, Ask and support messages.</li>
            <li><strong className="text-primary">Research counters:</strong> Where research is enabled, we count query outcomes, duration bands, public dataset names and query features in daily aggregates. These counters contain no questions, SQL, query fingerprints, addresses, IP addresses or user identifiers, and expire 30 days after their last update. They do not automatically train the AI. Queued SQL and results are temporary execution state with a one-hour expiry; result caches expire after 30 seconds. Analyses you choose to save stay in your browser or downloaded file.</li>
            <li><strong className="text-primary">Swaps and support:</strong> Swap providers process the addresses and transaction details you supply. If you contact us, the contact service receives the information you submit. Do not post private keys or other secrets in public issues or social messages.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-primary mb-3">3. Third-Party Services</h2>
          <p className="mb-3">We integrate with third-party services that have their own privacy policies:</p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong className="text-primary">Hosting and analytics:</strong> Vercel hosts the frontend. We use Vercel Web Analytics for aggregate visits to selected public landing pages. Our analytics filter removes query strings and fragments and excludes individual address, transaction and block pages, Ask, and sensitive tools. See <a href="https://vercel.com/docs/analytics/privacy-policy" target="_blank" rel="noopener noreferrer" className="legal-link">Vercel’s analytics privacy documentation</a>.</li>
            <li><strong className="text-primary">Zift (formerly Ask):</strong> Free-form questions, recent conversation context and relevant public data are sent to our API and, when AI is enabled, its configured provider (OpenAI or Anthropic). The OpenAI integration disables optional response storage; this does not guarantee zero provider retention. Public-data explanations may be cached briefly. Zift and its MCP server store no IP addresses or identifiers derived from them, hashed or otherwise: their usage limits are site-wide counters shared by all visitors. A short-lived in-memory limiter uses your IP address only to count requests in the past minute and keeps nothing after that. Cloudflare Turnstile can process browser and connection information for abuse prevention. Do not submit confidential or personal information to Ask.</li>
            <li><strong className="text-primary">NEAR Intents (1-Click Swap):</strong> Cross-chain swap quotes and execution. When you initiate a swap, your transaction data is shared with NEAR Intents to facilitate the exchange.</li>
            <li><strong className="text-primary">Fiat on-ramp providers:</strong> If you purchase cryptocurrency with a credit card through an embedded widget, you interact directly with the provider (e.g. MoonPay). They may require identity verification (KYC). We do not receive or store your payment information.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-primary mb-3">4. Cookies &amp; Tracking</h2>
          <p>
            The app uses local or session storage for preferences such as theme, currency, feed layout, custom address labels and dismissed announcements. You can remove these through your browser’s site-data controls; doing so also removes saved preferences and labels. Vercel Web Analytics is cookieless. We disable Vercel Web Analytics when the browser sends Do Not Track or Global Privacy Control. External swap, purchase and security providers follow their own storage and privacy policies.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-primary mb-3">5. Data Sharing</h2>
          <p>
            We do not sell, rent, or share your personal information with third parties for marketing purposes.
            We may disclose information if required by law or to protect the security of our service.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-primary mb-3">6. Data Security</h2>
          <p>
            We use HTTPS encryption for all connections. Our servers are secured with standard industry practices.
            However, no method of transmission over the internet is 100% secure.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-primary mb-3">7. Retention &amp; Your Choices</h2>
          <p>
            Public blockchain records are permanent and cannot be removed from the blockchain by us. Browser preferences remain until cleared or expired by your browser. Operational, provider and correspondence retention depends on the service and applicable requirements. Depending on your location, you may have rights to access, correct or delete personal information, or object to its processing. Contact us to make a request; do not include sensitive information in a public post.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-primary mb-3">8. Changes</h2>
          <p>
            We may update this policy from time to time. Changes will be posted on this page with a revised
            &ldquo;last updated&rdquo; date.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-primary mb-3">9. Contact</h2>
          <p>
            Questions? Reach us on{' '}
            <a href="https://x.com/zecblock" target="_blank" rel="noopener noreferrer" className="legal-link">
              X / Twitter
            </a>{' '}
            or open an issue on{' '}
            <a href="https://github.com/Kenbak/zecblock" target="_blank" rel="noopener noreferrer" className="legal-link">
              GitHub
            </a>.
          </p>
        </section>
      </div>
    </div>
  );
}
