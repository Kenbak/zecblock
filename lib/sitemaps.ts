import type { NewsletterIssue } from '@/lib/newsletter/types';

export const MAX_SITEMAP_URLS = 50_000;
export const BLOCK_SITEMAP_SHARD_SIZE = 50_000;

export interface SitemapUrlEntry {
  url: string;
  changeFrequency?: 'hourly' | 'daily' | 'weekly';
  priority?: number;
  lastModified?: Date | string;
}

export interface SitemapIndexEntry {
  url: string;
  lastModified?: Date | string;
}

export interface BlockSitemapRange {
  start: number;
  end: number;
  slug: string;
}

export const CORE_PATHS = [
  '/',
  '/blocks',
  '/txs',
  '/txs?type=shielded',
  '/mempool',
  '/mempool/live',
  '/network',
  '/network/nodes',
  '/network/attestations',
  '/network/block-speed',
  '/network/upgrades',
  '/privacy',
  '/privacy-risks',
  '/privacy/wallets',
  '/pools',
  '/mining',
  '/charts',
  // Stable chart pages only. Range and series variants canonicalize here.
  '/charts/pool-balances',
  '/charts/supply',
  '/charts/shielded-supply',
  '/charts/turnstile',
  '/charts/pool-share',
  '/charts/search-interest',
  '/charts/daily-activity',
  '/charts/privacy-adoption',
  '/charts/privacy-score',
  '/charts/flow-volume',
  '/charts/net-flow',
  '/charts/flow-thresholds',
  '/charts/flow-buckets',
  '/charts/network-hashrate',
  '/charts/mining-distribution',
  '/charts/miner-rewards',
  '/charts/block-time',
  '/charts/difficulty',
  '/charts/block-fees',
  '/charts/tx-per-block',
  '/charts/fees',
  '/charts/node-storage',
  '/charts/price-vs-realized',
  '/charts/mvrv',
  '/charts/nupl',
  '/charts/sopr',
  '/charts/realized-cap',
  '/charts/dormancy',
  '/charts/coin-days',
  '/charts/hodl-waves',
  '/charts/swap-volume',
  '/charts/swap-count',
  '/charts/protocol-commitments',
  '/charts/protocol-nullifiers',
  '/zift',
  '/rich-list',
  '/reorgs',
  '/crosschain',
  '/ironwood',
  '/governance',
  '/governance/retroactive-grants-q3-2026',
  '/governance/nu7',
  '/turnstile',
  '/usage-clock',
  '/zodl',
  '/valuation',
  '/pulse',
] as const;

export const CONTENT_PATHS = [
  '/docs/mcp',
  '/learn',
  '/newsletter',
  '/about',
  '/press',
  '/privacy-policy',
  '/terms',
] as const;

export const TOOL_PATHS = [
  '/decrypt',
  '/tools',
  '/tools/anchor-search',
  '/tools/blend-check',
  '/tools/broadcast',
  '/tools/decode',
  '/tools/unit-converter',
  '/docs',
] as const;

export const STATIC_SITEMAP_SLUGS = ['core', 'content', 'tools'] as const;
export const DYNAMIC_SITEMAP_SLUGS = [
  'names',
  'addresses',
  'orphan-blocks',
  'transactions-recent',
] as const;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatLastModified(value: Date | string | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function uniqueByUrl<T extends { url: string }>(entries: T[]): T[] {
  const unique = new Map<string, T>();
  for (const entry of entries) {
    if (!unique.has(entry.url)) unique.set(entry.url, entry);
  }
  return Array.from(unique.values());
}

export function serializeUrlSet(entries: SitemapUrlEntry[]): string {
  const uniqueEntries = uniqueByUrl(entries);
  if (uniqueEntries.length > MAX_SITEMAP_URLS) {
    throw new RangeError(`A sitemap cannot contain more than ${MAX_SITEMAP_URLS} URLs`);
  }

  const urls = uniqueEntries.map((entry) => {
    const lastModified = formatLastModified(entry.lastModified);
    return [
      '  <url>',
      `    <loc>${escapeXml(entry.url)}</loc>`,
      ...(lastModified ? [`    <lastmod>${lastModified}</lastmod>`] : []),
      ...(entry.changeFrequency ? [`    <changefreq>${escapeXml(entry.changeFrequency)}</changefreq>`] : []),
      ...(entry.priority !== undefined ? [`    <priority>${Math.min(1, Math.max(0, entry.priority))}</priority>`] : []),
      '  </url>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

export function serializeSitemapIndex(entries: SitemapIndexEntry[]): string {
  const uniqueEntries = uniqueByUrl(entries);
  if (uniqueEntries.length > MAX_SITEMAP_URLS) {
    throw new RangeError(`A sitemap index cannot contain more than ${MAX_SITEMAP_URLS} sitemaps`);
  }

  const sitemaps = uniqueEntries.map((entry) => {
    const lastModified = formatLastModified(entry.lastModified);
    return [
      '  <sitemap>',
      `    <loc>${escapeXml(entry.url)}</loc>`,
      ...(lastModified ? [`    <lastmod>${lastModified}</lastmod>`] : []),
      '  </sitemap>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...sitemaps,
    '</sitemapindex>',
    '',
  ].join('\n');
}

function parseConfiguredHeight(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const height = Number(value);
  return Number.isSafeInteger(height) && height >= 0 ? height : null;
}

export function getConfiguredBlockSitemapRanges(
  minimumValue = process.env.SITEMAP_BLOCK_MIN_HEIGHT,
  maximumValue = process.env.SITEMAP_BLOCK_MAX_HEIGHT,
): BlockSitemapRange[] {
  if (minimumValue === undefined && maximumValue === undefined) return [];

  const minimum = parseConfiguredHeight(minimumValue);
  const maximum = parseConfiguredHeight(maximumValue);
  const isAligned = minimum !== null
    && maximum !== null
    && minimum % BLOCK_SITEMAP_SHARD_SIZE === 0
    && (maximum + 1) % BLOCK_SITEMAP_SHARD_SIZE === 0;

  if (!isAligned || minimum > maximum) {
    console.error(
      'Block sitemaps are disabled: SITEMAP_BLOCK_MIN_HEIGHT and '
      + 'SITEMAP_BLOCK_MAX_HEIGHT must define aligned 50,000-height shards.',
    );
    return [];
  }

  const ranges: BlockSitemapRange[] = [];
  for (let start = minimum; start <= maximum; start += BLOCK_SITEMAP_SHARD_SIZE) {
    const end = Math.min(start + BLOCK_SITEMAP_SHARD_SIZE - 1, maximum);
    ranges.push({ start, end, slug: `blocks-${start}-${end}` });
    if (ranges.length >= MAX_SITEMAP_URLS) break;
  }
  return ranges;
}

export function getBlockSitemapRange(
  slug: string,
  ranges = getConfiguredBlockSitemapRanges(),
): BlockSitemapRange | null {
  return ranges.find((range) => range.slug === slug) ?? null;
}

function absoluteUrl(baseUrl: string, path: string): string {
  return path === '/' ? `${baseUrl}/` : `${baseUrl}${path}`;
}

function newsletterDate(value: string): Date | undefined {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function getStaticSitemapEntries(
  slug: string,
  baseUrl: string,
  newsletters: NewsletterIssue[],
): SitemapUrlEntry[] | null {
  if (slug === 'core') {
    return CORE_PATHS.map((path) => ({ url: absoluteUrl(baseUrl, path), ...(path.startsWith('/governance') ? { lastModified: path === '/governance/nu7' ? '2026-09-15' : '2026-09-18', changeFrequency: 'daily' as const, priority: 0.6 } : {}), ...(path === '/ironwood' ? { lastModified: '2026-09-17' } : {}), ...(path === '/zift' ? { lastModified: '2026-10-29', changeFrequency: 'weekly' as const, priority: 0.7 } : {}), ...(path === '/network/attestations' ? { lastModified: '2026-09-09', changeFrequency: 'hourly' as const, priority: 0.6 } : {}) }));
  }

  if (slug === 'tools') {
    return TOOL_PATHS.map((path) => ({
      url: absoluteUrl(baseUrl, path),
      ...(path === '/tools' ? { lastModified: '2026-09-17' } : {}),
    }));
  }

  if (slug === 'content') {
    const latestNewsletterDate = newsletters[0]
      ? newsletterDate(newsletters[0].date)
      : undefined;
    const staticEntries = CONTENT_PATHS.map((path) => ({
      url: absoluteUrl(baseUrl, path),
      ...(path === '/learn' ? { lastModified: '2026-10-26' } : {}),
      ...(path === '/about' ? { lastModified: '2026-09-17' } : {}),
      ...(path === '/newsletter' && latestNewsletterDate
        ? { lastModified: latestNewsletterDate }
        : {}),
    }));
    const issueEntries = newsletters.map((issue) => ({
      url: `${baseUrl}/newsletter/${encodeURIComponent(issue.slug)}`,
      lastModified: newsletterDate(issue.date),
    }));
    return [...staticEntries, ...issueEntries];
  }

  return null;
}

export function getMainnetSitemapIndexEntries(
  baseUrl: string,
  ranges = getConfiguredBlockSitemapRanges(),
): SitemapIndexEntry[] {
  const slugs = [
    ...STATIC_SITEMAP_SLUGS,
    ...DYNAMIC_SITEMAP_SLUGS,
    ...ranges.map((range) => range.slug),
  ];
  return slugs.map((slug) => ({ url: `${baseUrl}/sitemap-${slug}.xml` }));
}

export function isKnownSitemapSlug(
  slug: string,
  ranges = getConfiguredBlockSitemapRanges(),
): boolean {
  return STATIC_SITEMAP_SLUGS.includes(slug as (typeof STATIC_SITEMAP_SLUGS)[number])
    || DYNAMIC_SITEMAP_SLUGS.includes(slug as (typeof DYNAMIC_SITEMAP_SLUGS)[number])
    || ranges.some((range) => range.slug === slug);
}
