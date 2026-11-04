import { readApiData } from '@/lib/api-client';
import { isGrantsRound } from '@/lib/governance';
import { getGovernanceCatalog } from '@/lib/governance-data';
import { unstable_cache } from 'next/cache';
import { getAllNewsletters } from '@/lib/newsletter';
import { createRefreshCache } from '@/lib/refresh-cache';
import { getApiUrl, getBaseUrl, getNetwork } from '@/lib/seo';
import {
  getBlockSitemapRange,
  getConfiguredBlockSitemapRanges,
  getStaticSitemapEntries,
  isKnownSitemapSlug,
  serializeUrlSet,
  type SitemapUrlEntry,
} from '@/lib/sitemaps';
import { isValidName, listZnsRegistrations } from '@/lib/zns';

export const dynamic = 'force-dynamic';

const FETCH_TIMEOUT_MS = 10_000;
const ZNS_SITEMAP_LIMIT = 5_000;
const ZNS_PAGE_SIZE = 500;
const ZNS_REVALIDATE_SECONDS = 60 * 60;

interface DynamicSitemapResult {
  entries: SitemapUrlEntry[];
  maxAge: number;
}

function xmlResponse(xml: string, maxAge: number): Response {
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${Math.max(maxAge * 2, 600)}`,
      'CDN-Cache-Control': `public, s-maxage=${maxAge}`,
      'Vercel-CDN-Cache-Control': `public, s-maxage=${maxAge}`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function unavailableResponse(): Response {
  return new Response('Sitemap data is temporarily unavailable.', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '60',
      'X-Robots-Tag': 'noindex',
    },
  });
}

function notFoundResponse(): Response {
  return new Response('Not found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

function toDateFromSeconds(value: unknown): Date | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function fetchJson(url: string, revalidate: number): Promise<unknown> {
  const response = await fetch(url, {
    next: { revalidate },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Sitemap data source returned ${response.status}`);
  }
  return readApiData(response);
}

async function refreshRegisteredNamePages(baseUrl: string): Promise<SitemapUrlEntry[]> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const entries: SitemapUrlEntry[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let recordsRead = 0;

  // The current resolver's status describes sync state, not registration count.
  // Enumerate its authoritative collection within the existing discovery budget.
  let cursor: string | null = null;
  const maxPages = Math.ceil(ZNS_SITEMAP_LIMIT / ZNS_PAGE_SIZE);
  for (let pageNumber = 0; pageNumber < maxPages && recordsRead < ZNS_SITEMAP_LIMIT; pageNumber += 1) {
    const limit = Math.min(ZNS_PAGE_SIZE, ZNS_SITEMAP_LIMIT - recordsRead);
    const { items: registrations, page } = await listZnsRegistrations(limit, cursor, signal);
    if (!Array.isArray(registrations) || registrations.length > limit) {
      throw new Error('Name sitemap data source returned an invalid collection');
    }
    recordsRead += registrations.length;
    for (const registration of registrations) {
      if (typeof registration?.name !== 'string' || !isValidName(registration.name)) continue;
      if (typeof registration.address !== 'string' || !registration.address
        || typeof registration.txid !== 'string' || !Number.isInteger(registration.height)
        || typeof registration.lastAction !== 'string') {
        throw new Error('Name sitemap data source returned an invalid registration');
      }
      const name = registration.name.toLowerCase();
      if (names.has(name)) continue;
      names.add(name);
      entries.push({
        url: `${baseUrl}/name/${encodeURIComponent(name)}`,
      });
    }
    if (!page.hasNext) break;
    if (registrations.length === 0 || !page.nextCursor || cursors.has(page.nextCursor)) {
      throw new Error('Name sitemap data source returned non-advancing pagination');
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  if (recordsRead > 0 && entries.length === 0) {
    throw new Error('Name sitemap data source returned no valid registrations');
  }

  return entries;
}

const getRegisteredNamePagesFromDataCache = unstable_cache(
  refreshRegisteredNamePages,
  ['sitemap-zns-registrations-v3'],
  {
    revalidate: ZNS_REVALIDATE_SECONDS,
    tags: ['sitemap-zns-registrations'],
  },
);

const getRegisteredNamePages = createRefreshCache({
  load: getRegisteredNamePagesFromDataCache,
  maxAgeMs: 5 * 60 * 1000,
  retryAfterMs: 30 * 1000,
});

async function getDynamicSitemap(slug: string, baseUrl: string): Promise<DynamicSitemapResult> {
  const apiUrl = getApiUrl();

  if (slug === 'names') {
    return { entries: await getRegisteredNamePages(baseUrl), maxAge: 3_600 };
  }

  if (slug === 'addresses') {
    const data = await fetchJson(`${apiUrl}/v1/addresses/rich-list?limit=100&offset=0`, 3_600) as {
      success?: boolean;
      addresses?: Array<{ address?: unknown; lastSeen?: unknown }>;
    };
    if (!(data) || !Array.isArray(data.addresses)) {
      throw new Error('Address sitemap data source returned an invalid payload');
    }
    const entries = data.addresses.map((entry) => {
      if (typeof entry.address !== 'string' || entry.address.length < 20) {
        throw new Error('Address sitemap data source returned an invalid address');
      }
      return {
        url: `${baseUrl}/address/${encodeURIComponent(entry.address)}`,
        lastModified: toDateFromSeconds(entry.lastSeen) ?? toDate(entry.lastSeen),
      };
    });
    return {
      entries,
      maxAge: 3_600,
    };
  }

  if (slug === 'orphan-blocks') {
    const data = await fetchJson(`${apiUrl}/v1/uncles?limit=100&offset=0`, 300) as {
      success?: boolean;
      orphanedBlocks?: Array<{ hash?: unknown; detectedAt?: unknown; timestamp?: unknown }>;
    };
    if (!(data) || !Array.isArray(data.orphanedBlocks)) {
      throw new Error('Orphan-block sitemap data source returned an invalid payload');
    }
    const entries = data.orphanedBlocks.map((block) => {
      if (typeof block.hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(block.hash)) {
        throw new Error('Orphan-block sitemap data source returned an invalid hash');
      }
      return {
        url: `${baseUrl}/block/${block.hash.toLowerCase()}`,
        lastModified: toDate(block.detectedAt) ?? toDateFromSeconds(block.timestamp),
      };
    });
    return {
      entries,
      maxAge: 300,
    };
  }

  if (slug === 'transactions-recent') {
    const data = await fetchJson(`${apiUrl}/v1/sitemaps/transactions/recent`, 300) as {
      success?: boolean;
      transactions?: Array<{ txid?: unknown; blockTime?: unknown }>;
    };
    if (!(data) || !Array.isArray(data.transactions)) {
      throw new Error('Transaction sitemap data source returned an invalid payload');
    }
    if (data.transactions.length !== 100) {
      throw new Error('Transaction sitemap data source did not return exactly 100 records');
    }
    const entries = data.transactions.map((transaction) => {
      if (typeof transaction.txid !== 'string'
        || !/^[a-fA-F0-9]{64}$/.test(transaction.txid)) {
        throw new Error('Transaction sitemap data source returned an invalid transaction ID');
      }
      return {
        url: `${baseUrl}/tx/${transaction.txid.toLowerCase()}`,
        lastModified: toDateFromSeconds(transaction.blockTime),
      };
    });
    return {
      entries,
      maxAge: 300,
    };
  }

  const range = getBlockSitemapRange(slug);
  if (!range) throw new Error('Unknown block sitemap range');

  const data = await fetchJson(
    `${apiUrl}/v1/sitemaps/blocks?start=${range.start}&end=${range.end}`,
    300,
  ) as {
    success?: boolean;
    complete?: boolean;
    blocks?: Array<{ height?: unknown; timestamp?: unknown }>;
  };
  if (!(data) || !Array.isArray(data.blocks)) {
    throw new Error('Block sitemap data source returned an invalid payload');
  }

  const entries = data.blocks.map((block) => {
    const height = Number(block.height);
    if (!Number.isSafeInteger(height) || height < range.start || height > range.end) {
      throw new Error('Block sitemap data source returned an out-of-range height');
    }
    return {
      url: `${baseUrl}/block/${height}`,
      lastModified: toDateFromSeconds(block.timestamp),
    };
  });

  return {
    entries,
    maxAge: data.complete === true ? 86_400 : 300,
  };
}

const getDynamicSitemapWithFallback = createRefreshCache({
  load: async (key: string) => {
    const separator = key.indexOf('\n');
    if (separator < 1) throw new Error('Invalid dynamic sitemap cache key');
    return getDynamicSitemap(key.slice(0, separator), key.slice(separator + 1));
  },
  maxAgeMs: 5 * 60 * 1000,
  retryAfterMs: 30 * 1000,
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  if (getNetwork() !== 'mainnet') return notFoundResponse();

  const { slug } = await params;
  const ranges = getConfiguredBlockSitemapRanges();
  if (!isKnownSitemapSlug(slug, ranges)) return notFoundResponse();

  const baseUrl = getBaseUrl();
  const staticEntries = getStaticSitemapEntries(
    slug,
    baseUrl,
    slug === 'content' ? getAllNewsletters() : [],
  );
  if (staticEntries) {
    if (slug === 'core') {
      const catalog = await getGovernanceCatalog();
      const known = new Set(staticEntries.map(entry => entry.url));
      for (const vote of catalog.votes) {
        const url = `${baseUrl}${vote.href}`;
        if (!known.has(url)) {
          staticEntries.push({ url, changeFrequency: 'daily', priority: 0.5 });
          known.add(url);
        }
      }
      // The announcement redirects to a registered round once matched.
      const grants = catalog.votes.filter(vote => isGrantsRound(vote.round));
      const entries = grants.length === 1 ? staticEntries.filter(entry => !entry.url.endsWith('/governance/retroactive-grants-q3-2026')) : staticEntries;
      return xmlResponse(serializeUrlSet(entries), 300);
    }
    return xmlResponse(serializeUrlSet(staticEntries), 86_400);
  }

  try {
    const result = await getDynamicSitemapWithFallback(`${slug}\n${baseUrl}`);
    return xmlResponse(serializeUrlSet(result.entries), result.maxAge);
  } catch (error) {
    console.error(`Unable to generate sitemap ${slug}:`, error);
    return unavailableResponse();
  }
}
