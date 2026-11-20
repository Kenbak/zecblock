import Link from 'next/link';
import { readApiData } from '@/lib/api-client';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/SectionHeader';
import { buildPageMetadata, getApiUrl, getBaseUrl, getNetwork } from '@/lib/seo';
import { fetchWithDeadline } from '@/lib/server-fetch';
import { normalizeApiBaseUrl } from '@/lib/network';
import type { AttestationData } from '@/lib/attestations';
import AttestationsClient from './AttestationsClient';

// No ISR snapshot may outlive a security observation's freshness window.
export const dynamic = 'force-dynamic';
export const metadata = buildPageMetadata({
  title: 'Zero Indexer Attestation Monitor | ZecBlock',
  description: 'Check fresh enclave evidence, TLS certificate bindings and software release status for experimental Zcash Zero Indexer shims and hubs.',
  path: '/network/attestations', index: true, networks: ['mainnet', 'testnet'],
  imageAlt: 'ZecBlock Zero Indexer attestation monitor',
});

export default async function AttestationsPage() {
  const network = getNetwork();
  if (network === 'crosslink-testnet') notFound();
  let initialData: AttestationData | null = null;
  try {
    const response = await fetchWithDeadline(`${getApiUrl()}/v1/network/attestations`, { cache: 'no-store' });
    if (response.ok) {
      const data = await readApiData<AttestationData>(response);
      if (data.network === network && Array.isArray(data.endpoints)) initialData = data;
    }
  } catch { /* The introduction and explicit unavailable state still render on an API outage. */ }
  const publicApiUrl = normalizeApiBaseUrl(process.env.NEXT_PUBLIC_API_URL || (network === 'mainnet' ? 'https://api.zecblock.com' : 'https://api.testnet.zecblock.com'));
  const initialNow = Date.now();
  const url = `${getBaseUrl()}/network/attestations`;
  const schema = {
    '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${url}#webpage`, url,
    name: 'Zero Indexer Attestation Monitor',
    description: 'Observed enclave evidence and TLS certificate bindings for experimental Zero Indexer endpoints. Software release verification is shown separately.',
    isPartOf: { '@id': `${getBaseUrl()}/#website` },
    publisher: { '@id': 'https://zecblock.com/#organization' },
  };
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
    <PageHeader eyebrow="NETWORK" eyebrowHref="/network" title="Zero Indexer attestations"
      subtitle="Independent observations of the experimental shims and hubs serving Zcash wallets. Check their enclave evidence, connection certificates and software release status."
      actions={<span className="type-label font-mono text-muted">{network === 'mainnet' ? 'MAINNET' : 'TESTNET'} · EXPERIMENTAL</span>} />
    <nav aria-label="Attestation page sections" className="flex flex-wrap gap-x-6 gap-y-3 border-b border-cipher-border pb-5 mb-6 text-caption font-mono text-muted">
      <a href="#endpoint-observations" className="hover:text-primary">Endpoints</a>
      <a href="#attestation-method" className="hover:text-primary">Methodology</a>
      {network === 'mainnet' ? <Link href="/network/wallet-servers" className="hover:text-primary">Wallet servers</Link> : null}
      <a href={`${publicApiUrl}/v1/network/attestations`} className="sm:ml-auto hover:text-primary">JSON API ↗</a>
    </nav>
    <AttestationsClient initialData={initialData} initialNow={initialNow} network={network} apiUrl={publicApiUrl} />
    <details id="attestation-method" className="group mt-8 border border-cipher-border rounded-lg scroll-mt-36">
      <summary className="cursor-pointer list-none flex items-center justify-between gap-4 p-5 sm:p-6 hover:bg-glass-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold">
        <span><span className="block font-mono text-sm text-primary">Methodology &amp; limitations</span><span className="block text-caption text-muted mt-1">Evidence, software measurements and observer trust.</span></span><span aria-hidden="true" className="text-muted group-open:rotate-90">›</span>
      </summary>
      <div className="border-t border-cipher-border p-5 sm:p-6">
      <div className="grid gap-6 md:grid-cols-3 text-sm text-secondary leading-relaxed">
        <div><h3 className="font-medium text-primary mb-2">01 · Fresh enclave evidence</h3><p>Each check sends a new random challenge. We validate the signed response against the AWS Nitro trust root, check its timestamp and reject debug measurements.</p></div>
        <div><h3 className="font-medium text-primary mb-2">02 · A matching connection</h3><p>The domain and certificate fingerprint inside the signed evidence must match the HTTPS connection used by our observer.</p></div>
        <div><h3 className="font-medium text-primary mb-2">03 · A separate software check</h3><p>Release verification needs independently established build measurements. Valid evidence alone does not confirm the expected software or prove that the software is safe.</p></div>
      </div>
      <p className="text-sm text-muted mt-6 max-w-4xl">Canary adds signed observations for endpoints with reproduced build measurements, checked every minute and expiring after three minutes. It runs on ZecBlock’s server with operator-pinned signing keys; Canary’s own runtime is not enclave-attested. Connection warnings remain visible even when a recent signed check passed.</p>
      <p className="text-sm text-muted mt-6 max-w-4xl">These are periodic observations from ZecBlock, not verification of your wallet’s connection. A passing shim does not establish its hub’s status. Build tags identify reviewed source commits. A matching reproduced configuration can confirm a shim’s configured hub, but does not prove live routing or hub availability. The monitor does not measure transaction privacy, batching or wallet service uptime.</p>
      <div className="flex flex-wrap gap-x-6 gap-y-3 mt-5 text-sm">
        <a className="text-secondary hover:text-primary underline underline-offset-4" href="https://docs.caution.co/concepts/attestation/" target="_blank" rel="noopener noreferrer">Attestation methodology ↗</a>
        <a className="text-secondary hover:text-primary underline underline-offset-4" href="https://docs.caution.co/guides/verify-an-app/" target="_blank" rel="noopener noreferrer">Verify a build yourself ↗</a>
        <a className="text-secondary hover:text-primary underline underline-offset-4" href={`${publicApiUrl}/v1/network/attestations`}>Public JSON API ↗</a>
      </div>
      </div>
    </details>
  </div>;
}
