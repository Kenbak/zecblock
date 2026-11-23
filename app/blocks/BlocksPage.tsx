import { readApiCollection, parseApiCursor } from '@/lib/api-client';
import type { Metadata } from 'next';
import { getApiUrl } from '@/lib/api-config';
import { retainLastGoodOrBuildFallback } from '@/lib/isr-fallback';
import { buildPageMetadata, getBaseUrl } from '@/lib/seo';
import { fetchWithDeadline, isServerRenderDeadlineError } from '@/lib/server-fetch';
import BlocksClient from './BlocksClient';
import type { BlockFilterValues } from './BlockFilters';

const API_URL = getApiUrl();
const PAGE_SIZE = 25;

type SearchParams = Record<string, string | string[] | undefined>;
type UnavailablePolicy = 'shell' | 'throw';

interface BlocksPageProps {
  searchParams: Promise<SearchParams>;
  unavailablePolicy?: UnavailablePolicy;
}

interface BlocksRequest {
  filters: BlockFilterValues;
  filtered: boolean;
  cursor: string | null;
  direction: 'next' | 'prev';
  page: number;
  pageParamConsistent: boolean;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseBlocksRequest(searchParams: SearchParams): BlocksRequest {
  const filters: BlockFilterValues = Object.fromEntries(['software','pool','order','from','to','min_height','max_height','min_interval','max_interval','min_size','max_size','min_fees','max_fees','min_txs','max_txs'].flatMap(key => {
    const value=firstValue(searchParams[key]);
    return value ? [[key,value]] : [];
  }));
  const filtered=Object.keys(filters).length>0;
  const cursor = parseApiCursor(firstValue(searchParams.cursor));
  const rawPage = firstValue(searchParams.page);
  const requestedPage = parsePositiveInteger(rawPage);
  const direction = cursor && firstValue(searchParams.direction) === 'prev' ? 'prev' : 'next';

  return {
    filters, filtered, cursor,
    direction,
    page: cursor ? Math.max(2, requestedPage ?? 2) : 1,
    // `page` is only a UI label; the cursor identifies the result slice. Keep
    // malformed combinations out of the index while canonicalizing valid
    // navigation URLs to their cursor identity below.
    pageParamConsistent: (firstValue(searchParams.cursor) === undefined || cursor !== null)
      && (rawPage === undefined || (cursor !== null ? requestedPage !== null && requestedPage >= 2 : requestedPage === 1)),
  };
}

function getArchiveCanonicalPath(request: BlocksRequest): string {
  if (request.filtered || !request.cursor) return '/blocks';
  const params = new URLSearchParams({
    cursor: String(request.cursor),
    direction: request.direction,
  });
  return `/blocks?${params.toString()}`;
}

export async function generateMetadata({ searchParams }: BlocksPageProps): Promise<Metadata> {
  const request = parseBlocksRequest(await searchParams);
  const isForwardArchive = (request.page === 1 || request.direction === 'next')
    && request.pageParamConsistent;
  const pageSuffix = request.page > 1 ? ` - Page ${request.page}` : '';

  return buildPageMetadata({
    title: `${request.filtered ? 'Zcash Blocks' : 'Latest Zcash Blocks'}${pageSuffix} | ZecBlock`,
    description: request.filtered
      ? 'Filter canonical Zcash blocks by software, mining pool, date, height, size, fees, transaction count and parent-block interval.'
      : request.page > 1
      ? `Browse Zcash block archive page ${request.page}, including block heights, hashes, transaction counts, sizes, miners, and timestamps.`
      : 'Browse the latest Zcash blocks with transaction counts, sizes, mining rewards, and timestamps. Real-time block explorer data.',
    path: isForwardArchive ? getArchiveCanonicalPath(request) : '/blocks',
    index: isForwardArchive && request.page === 1 && !request.filtered,
    keywords: ['zcash blocks', 'zcash block explorer', 'zcash latest blocks', 'ZEC blocks', 'zcash block height'],
  });
}

function unavailableBlocks(policy: UnavailablePolicy, error: unknown) {
  const fallback = { blocks: [], trailingBlock: null, pagination: null, available: false };
  return policy === 'throw'
    ? retainLastGoodOrBuildFallback(fallback, error, 'latest blocks')
    : fallback;
}

async function getInitialBlocks(request: BlocksRequest, unavailablePolicy: UnavailablePolicy) {
  let res: Response;
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), ...request.filters });
    if (request.cursor !== null) {
      params.set('cursor', String(request.cursor));
    }

    res = await fetchWithDeadline(`${API_URL}/v1/blocks?${params.toString()}`, {
      next: { revalidate: 30, tags: ['chain-tip'] },
    });
  } catch (error) {
    if (!isServerRenderDeadlineError(error)) {
      console.error('Error fetching initial blocks:', error);
    }
    return unavailableBlocks(unavailablePolicy, error);
  }

  if (!res.ok) {
    return unavailableBlocks(
      unavailablePolicy,
      new Error(`Latest blocks API returned HTTP ${res.status}`),
    );
  }

  try {
    const { items: blocks, page } = await readApiCollection<any>(res);
    return {
      blocks,
      trailingBlock: null,
      pagination: { ...page, page: request.page, total: page.total ?? 0, totalPages: Math.ceil((page.total ?? 0) / PAGE_SIZE) },
      available: true,
    };
  } catch (error) {
    return unavailableBlocks(unavailablePolicy, error);
  }

}

export default async function BlocksPage({
  searchParams,
  unavailablePolicy = 'shell',
}: BlocksPageProps) {
  const request = parseBlocksRequest(await searchParams);
  const { blocks, trailingBlock, pagination, available } = await getInitialBlocks(
    request,
    unavailablePolicy,
  );
  const archiveKey = `${request.cursor ?? 'first'}:${request.direction}:${request.page}:${JSON.stringify(request.filters)}`;
  const collectionUrl = new URL(getArchiveCanonicalPath(request), `${getBaseUrl()}/`).toString();
  const collectionJsonLd = request.pageParamConsistent
    && request.direction === 'next'
    && !request.filtered
    && blocks.length > 0
    ? {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        '@id': `${collectionUrl}#collection`,
        url: collectionUrl,
        name: request.page > 1 ? `Zcash block archive page ${request.page}` : 'Latest Zcash blocks',
        isPartOf: { '@id': `${getBaseUrl()}/#website` },
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: blocks.map((block: { height: number | string }, index: number) => ({
            '@type': 'ListItem',
            position: index + 1,
            url: `${getBaseUrl()}/block/${Number(block.height)}`,
            name: `Zcash block #${Number(block.height).toLocaleString('en-US')}`,
          })),
        },
      }
    : null;

  return (
    <>
      {collectionJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionJsonLd).replace(/</g, '\\u003c') }}
        />
      )}
      <BlocksClient
        key={archiveKey}
        filters={request.filters}
        initialBlocks={blocks}
        initialTrailingBlock={trailingBlock}
        initialPagination={pagination}
        initialCursor={request.cursor}
        initialDirection={request.direction}
        initialPage={request.page}
        initialUnavailable={!available}
      />

    </>
  );
}
