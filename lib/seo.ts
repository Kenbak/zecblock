import { readApiData } from '@/lib/api-client';
import { cache } from 'react';
import type { Metadata } from 'next';
import {
  getConfiguredNetwork,
  type AppNetwork,
} from '@/lib/network';
import { getApiUrlForNetwork } from '@/lib/api-config';
import { fetchWithDeadline } from '@/lib/server-fetch';

export type SeoNetwork = AppNetwork;

export function getNetwork(): SeoNetwork {
  const configured = getConfiguredNetwork();
  if (configured) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_NETWORK must be set to mainnet, testnet, or crosslink-testnet for production builds.',
    );
  }

  // Local development has historically defaulted to testnet. Production
  // builds fail above so a missing setting cannot publish the wrong network.
  return 'testnet';
}

export function getBaseUrl(): string {
  const network = getNetwork();
  const urls: Record<SeoNetwork, string> = {
    mainnet: 'https://zecblock.com',
    testnet: 'https://testnet.zecblock.com',
    'crosslink-testnet': 'https://crosslink.zecblock.com',
  };
  return urls[network];
}

export function getApiUrl(): string {
  return getApiUrlForNetwork(getNetwork());
}

/**
 * Network homepage copy. The homepage owns this metadata; the root layout only
 * sets site-wide defaults so pages without metadata (such as the 404) don't
 * inherit the homepage's title, canonical or index policy.
 */
export function getSiteCopy(): { title: string; description: string; keywords: string[]; imageAlt: string } {
  const network = getNetwork();
  if (network === 'mainnet') {
    return {
      title: 'Zcash Block Explorer & Privacy Analytics | ZecBlock',
      description: 'Search Zcash blocks, transactions, and addresses. Explore shielded pools, network activity, and privacy analytics with ZecBlock.',
      keywords: ['zcash block explorer', 'zcash explorer', 'ZEC explorer', 'zcash blockchain explorer', 'zcash transactions', 'zcash shielded pool', 'privacy', 'ZEC', 'ZecBlock', 'zcash rich list', 'zcash network'],
      imageAlt: 'ZecBlock - Zcash Block Explorer',
    };
  }
  if (network === 'testnet') {
    return {
      title: 'Zcash Testnet Explorer for TAZ | ZecBlock',
      description: 'Explore the Zcash testnet with ZecBlock. Search TAZ blocks, transactions, and addresses, monitor pending transactions, and inspect testnet network activity.',
      keywords: ['zcash testnet', 'TAZ', 'TAZ explorer', 'zcash testnet explorer', 'zcash testnet transactions', 'ZecBlock testnet'],
      imageAlt: 'ZecBlock - Zcash Testnet Explorer for TAZ',
    };
  }
  return {
    title: 'Zcash Crosslink Explorer | ZecBlock',
    description: 'Explore the Zcash Crosslink feature network, including blocks, finality, staking, and validators.',
    keywords: ['zcash crosslink', 'crosslink explorer', 'zcash finality', 'cTAZ'],
    imageAlt: 'ZecBlock - Zcash Crosslink Explorer',
  };
}

// Social platforms cache card images by URL. Bump this when app/opengraph-image.tsx changes.
const SHARE_IMAGE_VERSION = '2026-09-29';

function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path === '/' ? '/' : `/${path.replace(/^\/+/, '')}`;
  return new URL(normalizedPath, `${getBaseUrl()}/`).toString();
}

export interface BuildPageMetadataOptions {
  title: string;
  description: string;
  path: string;
  keywords?: string[];
  index?: boolean;
  type?: 'website' | 'article';
  imageAlt?: string;
  networks?: SeoNetwork[];
  indexOnTestnet?: boolean;
  canonical?: boolean;
}

/**
 * Build a complete, network-aware metadata object for a public page.
 *
 * Next.js replaces nested metadata objects instead of deeply merging them,
 * so every page must emit complete Open Graph and Twitter objects. Crosslink
 * remains noindex even if a caller accidentally opts a page into indexing.
 */
export function buildPageMetadata({
  title,
  description,
  path,
  keywords,
  index,
  type = 'website',
  imageAlt,
  networks,
  indexOnTestnet = false,
  canonical: includeCanonical = true,
}: BuildPageMetadataOptions): Metadata {
  const network = getNetwork();
  const canonical = absoluteUrl(path);
  const image = absoluteUrl(`/opengraph-image?v=${SHARE_IMAGE_VERSION}`);
  const isCrosslink = network === 'crosslink-testnet';
  const allowedOnNetwork = networks ? networks.includes(network) : true;
  // Testnet is a developer utility rather than a second copy of the explorer
  // index. Its homepage is the only default opt-in; any future testnet landing
  // page must make a deliberate, reviewed indexOnTestnet decision.
  const allowedOnTestnet = network !== 'testnet' || indexOnTestnet;
  const stagingPreview = process.env.VERCEL_ENV === 'preview' && process.env.ASK_STAGING_ENABLED === 'true';
  const shouldIndex = !stagingPreview && !isCrosslink
    && allowedOnNetwork
    && allowedOnTestnet
    && (index ?? true);
  // noindex pages may still pass discovery and relationship signals through
  // their normal links. Crosslink remains noindex, follow by product policy.
  const shouldFollow = true;
  const openGraphBase = {
    title,
    description,
    url: canonical,
    siteName: 'ZecBlock',
    locale: 'en_US',
    images: [
      {
        url: image,
        width: 1200,
        height: 630,
        alt: imageAlt || `${title} — ZecBlock`,
      },
    ],
  };
  const openGraph: Metadata['openGraph'] = type === 'article'
    ? { ...openGraphBase, type: 'article' }
    : { ...openGraphBase, type: 'website' };

  return {
    metadataBase: new URL(getBaseUrl()),
    title,
    description,
    ...(keywords?.length ? { keywords } : {}),
    // `null` explicitly clears a canonical inherited from the root layout on
    // invalid or authoritatively missing resources.
    alternates: { canonical: includeCanonical ? canonical : null },
    openGraph,
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image],
      site: '@zecblock',
      creator: '@zecblock',
    },
    robots: {
      index: shouldIndex,
      follow: shouldFollow,
      googleBot: {
        index: shouldIndex,
        follow: shouldFollow,
        'max-image-preview': 'large',
        'max-snippet': -1,
      },
    },
  };
}

// --- Block resolution ---

export interface BlockRecord {
  height: number | string;
  hash: string;
  timestamp?: number | string | null;
  transactionCount?: number | string | null;
  transaction_count?: number | string | null;
  transactions?: unknown[];
  size?: number | string | null;
  isOrphaned?: boolean;
  canonicalBlock?: {
    hash?: string | null;
  } | null;
}

export type BlockResolution =
  | { state: 'found'; block: BlockRecord }
  | { state: 'absent' }
  | { state: 'unavailable' };

export const BLOCK_HASH_PATTERN = /^[a-fA-F0-9]{64}$/;
const BLOCK_HEIGHT_PATTERN = /^\d+$/;

export function normalizeBlockIdentifier(identifier: string): string {
  return BLOCK_HASH_PATTERN.test(identifier) ? identifier.toLowerCase() : identifier;
}

function isValidBlockIdentifier(identifier: string): boolean {
  if (BLOCK_HASH_PATTERN.test(identifier)) return true;
  if (!BLOCK_HEIGHT_PATTERN.test(identifier)) return false;

  const height = Number(identifier);
  return Number.isSafeInteger(height) && height >= 0;
}

function isBlockRecord(value: unknown): value is BlockRecord {
  if (!value || typeof value !== 'object') return false;

  const block = value as Partial<BlockRecord>;
  const height = Number(block.height);
  return typeof block.hash === 'string'
    && BLOCK_HASH_PATTERN.test(block.hash)
    && Number.isSafeInteger(height)
    && height >= 0;
}

/**
 * Resolve enough block data for both metadata and the initial page response.
 *
 * Invalid identifiers and authoritative 404/410 responses are absent.
 * Temporary availability failures and malformed successful payloads return an
 * explicit unavailable state so they cannot become false not-found responses
 * or hold the page open until the hosting platform times out.
 */
export const getBlockResolution = cache(async (identifier: string): Promise<BlockResolution> => {
  if (!isValidBlockIdentifier(identifier)) return { state: 'absent' };

  const normalizedIdentifier = normalizeBlockIdentifier(identifier);

  // Confirmed blocks deep in the chain are immutable — cache them for 1 hour
  // instead of 30s to avoid burning serverless function invocations on every
  // bot/crawler visit.  Blocks within 100 of the tip might still be reorged
  // so they keep the short window.
  let revalidateSeconds = 30;
  if (/^\d+$/.test(normalizedIdentifier)) {
    const requestedHeight = Number(normalizedIdentifier);
    try {
      // Use the same long revalidation for the tip lookup so this fetch does
      // not pull the page-level s-maxage back to 30s.  An hour-old tip is
      // fine here — the 100-block margin absorbs the drift.
      const tipRes = await fetchWithDeadline(`${getApiUrl()}/v1/network/info`, {
        next: { revalidate: 3600 },
      });
      if (tipRes.ok) {
        const tipData = await readApiData(tipRes);
        const tipHeight = Number(tipData.height ?? tipData.blocks);
        if (Number.isSafeInteger(tipHeight) && requestedHeight < tipHeight - 100) {
          revalidateSeconds = 3600;
        }
      }
    } catch {
      // Chain tip unavailable — fall back to short revalidation
    }
  }

  let response: Response;

  try {
    response = await fetchWithDeadline(`${getApiUrl()}/v1/blocks/${encodeURIComponent(normalizedIdentifier)}?summary=1`, {
      next: { revalidate: revalidateSeconds },
    });
  } catch {
    return { state: 'unavailable' };
  }

  if (response.status === 404 || response.status === 410) {
    return { state: 'absent' };
  }

  if (!response.ok) {
    return { state: 'unavailable' };
  }

  let block: unknown;
  try {
    block = await readApiData(response);
  } catch {
    return { state: 'unavailable' };
  }

  if (!isBlockRecord(block)) {
    return { state: 'unavailable' };
  }

  return { state: 'found', block };
});

// --- Transaction metadata ---

export interface TxMeta {
  status: 'confirmed' | 'pending' | 'stale' | 'unknown';
  txid: string;
  blockHeight: number;
  timestamp: number;
  confirmations: number;
  isCoinbase: boolean;
  hasShielded: boolean;
  orchardActions: number;
  saplingSpendCount: number;
  saplingOutputCount: number;
  fee: number | null;
}

export type TxResolution =
  | { state: 'found'; meta: TxMeta }
  | { state: 'absent' }
  | { state: 'unavailable' };

export const getTxResolution = cache(async (txid: string): Promise<TxResolution> => {
  try {
    // Confirmed transactions are immutable — 300s keeps the CDN from
    // re-invoking the serverless function on every crawler visit.
    // Pending/absent paths fall through to the mempool fetch (revalidate 10s)
    // which pulls the effective page revalidation down automatically.
    const res = await fetchWithDeadline(`${getApiUrl()}/v1/transactions/${encodeURIComponent(txid)}/summary`, {
      next: { revalidate: 300 },
    });
    if (res.ok) {
      const data = await readApiData(res);
      const indexedStatus: TxMeta['status'] = data.status === 'stale'
        ? 'stale'
        : data.status === 'unknown' || data.isCanonical === false
          ? 'unknown'
          : 'confirmed';
      const indexedMeta: TxMeta = {
        status: indexedStatus,
        txid: data.txid,
        blockHeight: parseInt(data.blockHeight) || 0,
        timestamp: parseInt(data.blockTime) || 0,
        confirmations: indexedStatus === 'confirmed' ? (parseInt(data.confirmations) || 0) : 0,
        isCoinbase: data.isCoinbase || false,
        hasShielded: data.hasSapling || data.hasOrchard || data.hasIronwood || data.hasShielded || false,
        orchardActions: data.orchardActions || 0,
        saplingSpendCount: data.saplingSpendCount || 0,
        saplingOutputCount: data.saplingOutputCount || 0,
        fee: data.fee ?? null,
      };

      if (indexedStatus === 'confirmed') return { state: 'found', meta: indexedMeta };

      // A transaction removed by a reorg may return to the mempool. Prefer
      // that live state over the stale index record so it remains discoverable.
      const pendingResolution = await getPendingTxResolution(txid);
      return pendingResolution.state === 'found'
        ? pendingResolution
        : { state: 'found', meta: indexedMeta };
    }

    // A newly broadcast transaction may not be present in the confirmed
    // index yet. Check the mempool before treating the hash as absent.
    if (res.status !== 404) return { state: 'unavailable' };

    return getPendingTxResolution(txid);
  } catch {
    return { state: 'unavailable' };
  }
});

export const getTxMeta = cache(async (txid: string): Promise<TxMeta | null> => {
  const resolution = await getTxResolution(txid);
  return resolution.state === 'found' ? resolution.meta : null;
});

async function getPendingTxResolution(txid: string): Promise<TxResolution> {
  try {
    const mempoolRes = await fetchWithDeadline(`${getApiUrl()}/v1/mempool/${encodeURIComponent(txid)}`, {
      next: { revalidate: 10 },
    });
    if (!mempoolRes.ok) return { state: 'unavailable' };

    const mempoolData = await readApiData(mempoolRes);
    if (!mempoolData.inMempool) return { state: 'absent' };
    if (!mempoolData.transaction) {
      return { state: 'unavailable' };
    }

    const pending = mempoolData.transaction;
    return {
      state: 'found',
      meta: {
        status: 'pending',
        txid: pending.txid || txid,
        blockHeight: 0,
        timestamp: parseInt(pending.firstSeen) || 0,
        confirmations: 0,
        isCoinbase: false,
        hasShielded: pending.type === 'shielded' || pending.type === 'mixed' ||
          (pending.saplingSpendCount || 0) > 0 ||
          (pending.saplingOutputCount || 0) > 0 ||
          (pending.orchardActions || 0) > 0 ||
          (pending.ironwoodActions || 0) > 0,
        orchardActions: pending.orchardActions || 0,
        saplingSpendCount: pending.saplingSpendCount || 0,
        saplingOutputCount: pending.saplingOutputCount || 0,
        fee: 0,
      },
    };
  } catch {
    return { state: 'unavailable' };
  }
}

// --- Address metadata ---

export interface AddressMeta {
  address: string;
  balance: number;
  type: 'shielded' | 'transparent' | 'unified';
  txCount: number;
  isShielded: boolean;
}

export type AddressResolution =
  | { state: 'found'; meta: AddressMeta }
  | { state: 'absent' }
  | { state: 'unavailable' };

export const getAddressResolution = cache(async (address: string): Promise<AddressResolution> => {
  try {
    const res = await fetchWithDeadline(`${getApiUrl()}/v1/addresses/${encodeURIComponent(address)}?limit=1`, {
      next: { revalidate: 60 },
    });
    if (res.status === 404 || res.status === 410) return { state: 'absent' };
    if (!res.ok) return { state: 'unavailable' };
    const data = await readApiData(res);

    const isShielded = data.type === 'shielded' || data.type === 'unified' || (data.note && (
      data.note.includes('Shielded address') ||
      data.note.includes('Fully shielded')
    ));

    return {
      state: 'found',
      meta: {
        address: data.address,
        balance: (data.balance || 0) / 100000000,
        type: data.type || 'transparent',
        txCount: data.txCount || data.transactionCount || 0,
        isShielded,
      },
    };
  } catch {
    return { state: 'unavailable' };
  }
});

export const getAddressMeta = cache(async (address: string): Promise<AddressMeta | null> => {
  const resolution = await getAddressResolution(address);
  return resolution.state === 'found' ? resolution.meta : null;
});

// --- Helpers ---

export function truncateHash(hash: string, start = 10, end = 6): string {
  if (hash.length <= start + end + 3) return hash;
  return `${hash.slice(0, start)}...${hash.slice(-end)}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
