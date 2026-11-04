import { readApiData } from '@/lib/api-client';
import { notFound } from 'next/navigation';
import {
  getBaseUrl,
  getApiUrl,
  getNetwork,
  getBlockResolution,
  BLOCK_HASH_PATTERN,
  normalizeBlockIdentifier,
  type BlockRecord,
} from '@/lib/seo';
import { fetchWithDeadline } from '@/lib/server-fetch';
import BlockPageClient, { type BlockPageSummary } from './BlockPageClient';
import { FutureBlockView } from './FutureBlockView';
import { retainLastGoodOrBuildFallback } from '@/lib/isr-fallback';
import { getUpgradeStats } from '@/lib/network-upgrades-server';
import { readUpgradeSnapshot, getFutureBlockUpgrade } from '@/lib/network-upgrades';

function blockDescription(block: BlockRecord, height: number, hash: string): string {
  const transactionCount = Number(
    block.transactionCount
      ?? block.transaction_count
      ?? block.transactions?.length
      ?? 0,
  );
  const count = Number.isFinite(transactionCount) ? transactionCount : 0;
  const status = block.isOrphaned === true ? 'orphaned' : 'canonical';

  return `Zcash block ${height.toLocaleString('en-US')} is ${status}, has hash ${hash}, and records ${count.toLocaleString('en-US')} transaction${count === 1 ? '' : 's'}.`;
}

async function getCurrentTipHeight(): Promise<number> {
  const res = await fetchWithDeadline(`${getApiUrl()}/v1/network/info`, {
    next: { revalidate: 30 },
  });
  if (!res.ok) throw new Error(`Chain tip returned HTTP ${res.status}`);

  const data = await readApiData(res);
  const rawHeight = data.height ?? data.blocks;
  const tipHeight = rawHeight === null || rawHeight === undefined || rawHeight === ''
    ? Number.NaN
    : Number(rawHeight);
  if (!Number.isSafeInteger(tipHeight) || tipHeight < 0) {
    throw new Error('Chain tip payload is malformed');
  }
  return tipHeight;
}

export default async function BlockPage({
  params,
}: {
  params: Promise<{ height: string }>;
}) {
  const { height: identifier } = await params;
  const resolution = await getBlockResolution(identifier);
  if (resolution.state === 'absent') {
    const requestedHeight = /^\d+$/.test(identifier) ? Number(identifier) : null;
    if (requestedHeight !== null && requestedHeight >= 0) {
      const tipHeight = await getCurrentTipHeight();
      if (requestedHeight > tipHeight) {
        const initialStats = await getUpgradeStats();
        const upgrade = getFutureBlockUpgrade(requestedHeight, getNetwork(), readUpgradeSnapshot(initialStats, getNetwork()));
        const url = `${getBaseUrl()}/block/${requestedHeight}`;
        const name = `${upgrade?.name ?? 'Future Zcash block'} #${requestedHeight.toLocaleString('en-US')}`;
        const description = `${name} on Zcash ${getNetwork()}. This block is pending, ${Math.max(0, requestedHeight - tipHeight).toLocaleString('en-US')} blocks beyond the verified chain tip. ${upgrade?.description ?? 'Arrival time is an estimate.'}`;
        const schema = {
          '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${url}#webpage`,
          url, name, description, isPartOf: { '@id': `${getBaseUrl()}/#website` },
          mainEntity: { '@type': 'Thing', '@id': `${url}#block`, url, name, description,
            identifier: { '@type': 'PropertyValue', propertyID: 'Zcash block height', value: String(requestedHeight) } },
        };
        return <>
          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
          <FutureBlockView targetHeight={requestedHeight} currentHeight={tipHeight} initialStats={initialStats} />
        </>;
      }
    }
    notFound();
  }

  if (resolution.state === 'unavailable') {
    return retainLastGoodOrBuildFallback(
      <BlockPageClient
        identifier={normalizeBlockIdentifier(identifier)}
        initialSummary={null}
      />,
      new Error(`Block ${identifier} is unavailable`),
      'block detail',
    );
  }

  const block = resolution.block;
  const height = Number(block.height);
  const hash = block.hash.toLowerCase();
  const isOrphaned = block.isOrphaned === true;
  const replacementHash = block.canonicalBlock?.hash;
  const canonicalReplacementHeight = isOrphaned && typeof replacementHash === 'string'
    && BLOCK_HASH_PATTERN.test(replacementHash) && replacementHash.toLowerCase() !== hash
    ? height : null;
  const rawTransactionCount = block.transactionCount ?? block.transaction_count ?? null;
  const transactionCount = rawTransactionCount === null || rawTransactionCount === undefined
    ? null
    : Number(rawTransactionCount);
  const timestamp = block.timestamp === null || block.timestamp === undefined
    ? null
    : Number(block.timestamp);
  const size = block.size === null || block.size === undefined ? null : Number(block.size);
  const summary: BlockPageSummary = {
    height,
    hash,
    isOrphaned,
    canonicalReplacementHeight,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    transactionCount: Number.isFinite(transactionCount) ? transactionCount : null,
    size: Number.isFinite(size) ? size : null,
  };
  const baseUrl = getBaseUrl();
  const canonicalIdentifier = isOrphaned ? hash : String(height);
  const canonicalUrl = new URL(
    `/block/${encodeURIComponent(canonicalIdentifier)}`,
    `${baseUrl}/`,
  ).toString();
  const statusLabel = isOrphaned ? 'Orphaned' : 'Canonical';
  const name = `${statusLabel} Zcash Block #${height.toLocaleString('en-US')}`;
  const description = blockDescription(block, height, hash);
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${canonicalUrl}#webpage`,
    url: canonicalUrl,
    name,
    description,
    isPartOf: {
      '@type': 'WebSite',
      '@id': `${baseUrl}/#website`,
      url: `${baseUrl}/`,
      name: 'ZecBlock',
    },
    mainEntity: {
      '@type': 'Thing',
      '@id': `${canonicalUrl}#block`,
      url: canonicalUrl,
      name,
      description,
      identifier: {
        '@type': 'PropertyValue',
        propertyID: 'Zcash block hash',
        value: hash,
      },
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, '\\u003c'),
        }}
      />
      <BlockPageClient
        identifier={normalizeBlockIdentifier(identifier)}
        initialSummary={summary}
      />
    </>
  );
}
