import { readApiData } from '@/lib/api-client';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  buildPageMetadata,
  formatNumber,
  getApiUrl,
  getNetwork,
  getBlockResolution,
  truncateHash,
} from '@/lib/seo';
import { fetchWithDeadline } from '@/lib/server-fetch';
import { retainLastGoodOrBuildFallback } from '@/lib/isr-fallback';
import { getUpgradeStats } from '@/lib/network-upgrades-server';
import { readUpgradeSnapshot, getFutureBlockUpgrade } from '@/lib/network-upgrades';

type Props = {
  params: Promise<{ height: string }>;
  children: React.ReactNode;
};

// No page-level `revalidate` — the fetch-level values inside
// getBlockResolution control the effective ISR window dynamically:
// 3600s for confirmed blocks deep in the chain, 30s near the tip.

export function generateStaticParams(): Array<{ height: string }> {
  return [];
}

async function getTipHeight(): Promise<number> {
  const res = await fetchWithDeadline(`${getApiUrl()}/v1/network/info`, { next: { revalidate: 30 } });
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

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { height } = await params;
  const resolution = await getBlockResolution(height);

  if (resolution.state === 'absent') {
    // Check if this is a future block (valid height above tip)
    if (/^\d+$/.test(height)) {
      const tipHeight = await getTipHeight();
      if (Number(height) > tipHeight) {
        const stats = await getUpgradeStats();
        const upgrade = getFutureBlockUpgrade(Number(height), getNetwork(), readUpgradeSnapshot(stats, getNetwork()));
        const label = upgrade?.authority === 'announcement' ? 'NU7 Mainnet Preview' : upgrade?.name === 'NU7 activation' ? `NU7 Activation on Zcash ${getNetwork()}` : 'Zcash Block';
        const title = `${label} #${formatNumber(Number(height))} — Estimated Arrival | ZecBlock`;
        const description = upgrade?.authority === 'announcement'
          ? `${label} #${formatNumber(Number(height))} has not been mined yet. ${upgrade.description} Arrival is approximate.`
          : `${label} #${formatNumber(Number(height))} has not been mined yet. Approximately ${formatNumber(Number(height) - tipHeight)} blocks remain. Time estimates follow recent block times and the serving node’s schedule; mining variance can change arrival times.`;
        return buildPageMetadata({
          title,
          description,
          path: `/block/${Number(height)}`,
          index: false,
          imageAlt: title,
        });
      }
    }

    const title = `Zcash Block ${truncateHash(height)} Not Found | ZecBlock`;
    const description = `ZecBlock could not find Zcash block ${truncateHash(height)}.`;

    return buildPageMetadata({
      title,
      description,
      path: `/block/${encodeURIComponent(height)}`,
      index: false,
      canonical: false,
      imageAlt: title,
    });
  }

  if (resolution.state === 'unavailable') {
    const title = `Zcash Block ${truncateHash(height)} Status Unknown | ZecBlock`;
    const fallback = buildPageMetadata({
      title,
      description: `ZecBlock cannot currently verify Zcash block ${truncateHash(height)} because the block index is temporarily unavailable.`,
      path: `/block/${encodeURIComponent(height)}`,
      index: false,
      imageAlt: title,
    });
    return retainLastGoodOrBuildFallback(
      fallback,
      new Error(`Block ${height} metadata is unavailable`),
      'block detail metadata',
    );
  }

  const block = resolution.block;
  const blockHeight = Number(block.height);
  const timestamp = Number(block.timestamp);
  const rawTransactionCount = Number(
    block.transactionCount
      ?? block.transaction_count
      ?? block.transactions?.length
      ?? 0,
  );
  const transactionCount = Number.isFinite(rawTransactionCount) ? rawTransactionCount : 0;
  const size = Number(block.size ?? 0);
  const blockLabel = Number.isFinite(blockHeight)
    ? formatNumber(blockHeight)
    : String(block.height);
  const canonicalHash = block.hash.toLowerCase();
  const isOrphaned = block.isOrphaned === true;
  const canonicalIdentifier = isOrphaned
    ? canonicalHash
    : Number.isSafeInteger(blockHeight) && blockHeight >= 0
      ? String(blockHeight)
      : String(block.height);
  const replacementHash = block.canonicalBlock?.hash?.toLowerCase();

  const title = isOrphaned
    ? `Orphaned Zcash Block #${blockLabel} | ZecBlock`
    : `Zcash Block #${blockLabel} | ZecBlock`;

  // Block hashes share long runs of leading zeros; the tail is what tells them apart.
  const hashTail = (hash: string) => `…${hash.slice(-12)}`;
  const txLabel = `${formatNumber(transactionCount)} transaction${transactionCount !== 1 ? 's' : ''}`;
  let description: string;
  if (isOrphaned) {
    const replacement = replacementHash
      ? ` Canonical replacement: ${hashTail(replacementHash)}.`
      : '';
    description = `Orphaned Zcash block #${blockLabel} (hash ${hashTail(canonicalHash)}) recorded ${txLabel} before it was replaced in a chain reorganization.${replacement}`;
  } else {
    const validTimestamp = Number.isFinite(timestamp) && timestamp > 0;
    const datePart = validTimestamp
      ? `, mined ${new Date(timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })} UTC,`
      : '';
    const sizePart = Number.isFinite(size) && size > 0
      ? ` (${(size / 1024).toFixed(1)} KB)`
      : '';
    description = `Zcash block #${blockLabel}${datePart} with ${txLabel}${sizePart}. See its transactions, miner, fees and timing.`;
  }

  return buildPageMetadata({
    title,
    description,
    path: `/block/${encodeURIComponent(canonicalIdentifier)}`,
    index: true,
    imageAlt: title,
  });
}

// The existence check lives here, above this segment's loading boundary, so a
// missing block is decided before streaming commits the response to 200.
export default async function BlockLayout({ params, children }: Props) {
  const { height } = await params;
  const resolution = await getBlockResolution(height);
  if (resolution.state === 'absent') {
    const isFutureHeight = /^\d+$/.test(height) && Number(height) > await getTipHeight();
    if (!isFutureHeight) notFound();
  }
  return children;
}
