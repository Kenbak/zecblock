import { readApiData } from '@/lib/api-client';
import { GovernanceRefresh } from '../GovernanceRefresh';
import { VoteResults } from './VoteResults';
import { NU7VoteClient } from './NU7VoteClient';
import { getApiUrl, getBaseUrl, getNetwork } from '@/lib/seo';
import { NU7_VOTE } from '@/lib/nu7-vote-config';
import { fetchWithDeadline } from '@/lib/server-fetch';
import { readBoundedJson } from '@/lib/bounded-json';
import { NU7_ROUND_ID, NU7_SUMMARY_URL, NU7_TALLY_URL, parseVoteResults } from '@/lib/nu7-vote-results';
import { notFound } from 'next/navigation';
import { unstable_cache } from 'next/cache';

// Cache the bounded parsed value. A cacheable raw fetch is cloned and buffered
// independently by Next before our reader can enforce its decoded byte cap.
const fetchVoteJson = unstable_cache(async (url: string) => {
  const response = await fetchWithDeadline(url, { cache: 'no-store' }, 8_000);
  if (!response.ok) throw new Error('Voting API unavailable');
  return readBoundedJson(response);
}, ['nu7-bounded-vote-json-v1'], { revalidate: 300 });

async function fetchJson(url: string, versioned = false) {
  try {
    if (!versioned) return await fetchVoteJson(url);
    const res = await fetchWithDeadline(url, { next: { revalidate: 300 } }, 8_000);
    if (!res.ok) return null;
    return await readApiData(res);
  } catch {
    return null;
  }
}

export default async function NU7VotePage() {
  const network = getNetwork();
  if (network !== 'mainnet') notFound();

  const apiBase = getApiUrl();
  const baseUrl = getBaseUrl();
  const pageUrl = new URL('/governance/nu7', `${baseUrl}/`).toString();

  const [networkStats, summary, tally] = await Promise.all([
    fetchJson(`${apiBase}/v1/network/stats`, true),
    fetchJson(NU7_SUMMARY_URL),
    fetchJson(NU7_TALLY_URL),
  ]);
  const results = parseVoteResults(summary, tally);

  const supply = networkStats?.supply ?? null;
  const initialData = {
    ironwoodZec: supply?.ironwood ?? null,
    sproutZec: supply?.sprout ?? null,
    totalShielded: supply?.totalShielded ?? null,
    chainSupply: supply?.chainSupply ?? null,
  };

  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${pageUrl}#webpage`,
        url: pageUrl,
        name: 'NU7 Coinholder Vote Results and Verification',
        identifier: { '@type': 'PropertyValue', propertyID: 'zvote-1 round', value: NU7_ROUND_ID },
        about: { '@id': `${pageUrl}#event` },
        description:
          'Published Zcash NU7 coinholder vote results, question-by-question participation, and independent tally verification instructions.',
        isPartOf: { '@id': `${baseUrl}/#website` },
        breadcrumb: { '@id': `${pageUrl}#breadcrumb` },
      },
      {
        '@type': 'Event',
        '@id': `${pageUrl}#event`,
        name: NU7_VOTE.title,
        startDate: NU7_VOTE.voteStartTime,
        endDate: NU7_VOTE.voteEndTime,
        organizer: [
          { '@type': 'Organization', name: 'Valar Group' },
          { '@type': 'Organization', name: 'Project Tachyon' },
        ],
        description:
          'Private coinholder vote on NU7 scope: issuance smoothing, Sprout deprecation, 25-second blocks, and upgrade schedule.',
        url: pageUrl,
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${pageUrl}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Dashboard', item: `${baseUrl}/` },
          { '@type': 'ListItem', position: 2, name: 'Governance', item: `${baseUrl}/governance` },
          { '@type': 'ListItem', position: 3, name: 'NU7 Vote', item: pageUrl },
        ],
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, '\\u003c'),
        }}
      />
      <GovernanceRefresh />
      <NU7VoteClient initialData={initialData} resultsState={results.state} resultsContent={<VoteResults results={results} />} initialNow={Date.now()} />
    </>
  );
}
