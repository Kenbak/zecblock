import { shieldedListParams } from '@/lib/transaction-list';
import { readApiCollection, parseApiCursor } from '@/lib/api-client';
import { parseTransactionListItems, type TransactionListItem } from '@/lib/transaction-list';
import { getApiUrl } from '@/lib/api-config';
import { retainLastGoodOrBuildFallback } from '@/lib/isr-fallback';
import { buildPageMetadata, getBaseUrl } from '@/lib/seo';
import { fetchWithDeadline, isServerRenderDeadlineError } from '@/lib/server-fetch';
import TxsClient from './TxsClient';

const API_URL = getApiUrl();
const PAGE_SIZE = 25;

export type TxType = 'all' | 'shielded' | 'transparent' | 'coinbase';
export type FlowFilter = 'all' | 'shield' | 'deshield' | 'fully_shielded';
export type PoolFilter = 'all' | 'ironwood' | 'sapling' | 'orchard' | 'mixed';
export type SearchParams = Record<string, string | string[] | undefined>;
export type UnavailablePolicy = 'shell' | 'throw';

export interface TransactionsRequest {
  cursor: string | null;
  cursorIdx: number | null;
  cursorId: number | null;
  direction: 'next' | 'prev';
  page: number;
  type: TxType;
  flow: FlowFilter;
  pool: PoolFilter;
  minZec: number;
  pageParamConsistent: boolean;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parsePositiveInteger(value: string | undefined): number | null {
  const parsed = parseNonNegativeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function parseTxType(value: string | undefined): TxType {
  return value === 'shielded' || value === 'transparent' || value === 'coinbase'
    ? value
    : 'all';
}

function parseFlow(value: string | undefined): FlowFilter {
  return value === 'shield' || value === 'deshield' || value === 'fully_shielded' ? value : 'all';
}

function parsePool(value: string | undefined): PoolFilter {
  return value === 'ironwood' || value === 'sapling' || value === 'orchard' || value === 'mixed'
    ? value : 'all';
}

function parseMinZec(value: string | undefined): number {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 21_000_000 ? parsed : 0;
}

export function parseTransactionsRequest(searchParams: SearchParams): TransactionsRequest {
  const type = parseTxType(firstValue(searchParams.type));
  const cursor = parseApiCursor(firstValue(searchParams.cursor));
  const cursorIdx = parseNonNegativeInteger(firstValue(searchParams.cursor_idx));
  const cursorId = parseNonNegativeInteger(firstValue(searchParams.cursor_id));
  const rawPage = firstValue(searchParams.page);
  const requestedPage = parsePositiveInteger(rawPage);
  const direction = cursor && firstValue(searchParams.direction) === 'prev' ? 'prev' : 'next';

  return {
    cursor,
    cursorIdx: cursor === null ? null : (cursorIdx ?? 0),
    cursorId: cursor === null ? null : (cursorId ?? 0),
    direction,
    page: cursor ? Math.max(2, requestedPage ?? 2) : 1,
    type,
    flow: type === 'shielded' ? parseFlow(firstValue(searchParams.flow_type)) : 'all',
    pool: type === 'shielded' ? parsePool(firstValue(searchParams.pool)) : 'all',
    minZec: type === 'shielded' ? parseMinZec(firstValue(searchParams.min_zec)) : 0,
    pageParamConsistent: (firstValue(searchParams.cursor) === undefined || cursor !== null)
      && (rawPage === undefined || (cursor !== null ? requestedPage !== null && requestedPage >= 2 : requestedPage === 1)),
  };
}

export function getArchiveCanonicalPath(request: TransactionsRequest): string {
  const params = new URLSearchParams();
  if (request.type !== 'all') params.set('type', request.type);
  if (request.type === 'shielded') {
    if (request.flow !== 'all') params.set('flow_type', request.flow);
    if (request.pool !== 'all') params.set('pool', request.pool);
    if (request.minZec > 0) params.set('min_zec', String(request.minZec));
  }
  if (request.cursor !== null) {
    params.set('cursor', String(request.cursor));
    params.set('direction', request.direction);
  }
  const query = params.toString();
  return query ? `/txs?${query}` : '/txs';
}

export function hasShieldedSubFilters(request: TransactionsRequest): boolean {
  return request.flow !== 'all' || request.pool !== 'all' || request.minZec > 0;
}

function unavailableData(policy: UnavailablePolicy, error: unknown, label: string) {
  const fallback = { items: [], pagination: null, available: false };
  return policy === 'throw'
    ? retainLastGoodOrBuildFallback(fallback, error, label)
    : fallback;
}

async function getInitialCollection<T>(request: TransactionsRequest, unavailablePolicy: UnavailablePolicy, shielded: boolean, parseItems: (items: unknown[]) => T[]) {
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (shielded) {
      for (const [key, value] of Object.entries(shieldedListParams(request.flow, request.pool, request.minZec))) params.set(key, value);
    } else params.set('type', request.type);
    if (request.cursor) params.set('cursor', request.cursor);
    const response = await fetchWithDeadline(`${API_URL}/v1/transactions${shielded ? '/shielded' : ''}?${params}`, {
      next: { revalidate: 30, tags: ['chain-tip'] },
    });
    const { items, page } = await readApiCollection<unknown>(response);
    return { items: parseItems(items), pagination: { ...page, total: page.total ?? 0, totalPages: Math.ceil((page.total ?? 0) / PAGE_SIZE) }, available: true };
  } catch (error) {
    return unavailableData(unavailablePolicy, error, shielded ? 'latest shielded transactions' : 'latest transactions');
  }
}
const getInitialTxs = (request: TransactionsRequest, policy: UnavailablePolicy) => getInitialCollection(request, policy, false, parseTransactionListItems);
const getInitialFlows = (request: TransactionsRequest, policy: UnavailablePolicy) => getInitialCollection(request, policy, true, items => items);

export async function renderTransactionsPage(
  searchParams: Promise<SearchParams>,
  unavailablePolicy: UnavailablePolicy = 'shell',
) {
  const query = await searchParams;
  const request = parseTransactionsRequest(query);
  // `?view=activity` opens the Daily Activity tab, so its chart can be linked from other pages.
  // It is a view of this page: the canonical address stays the one without it.
  const initialView = firstValue(query.view) === 'activity' ? 'activity' : 'recent';
  const isShielded = request.type === 'shielded';

  let initialTxs: TransactionListItem[] = [];
  let initialFlows: unknown[] = [];
  let pagination: Record<string, unknown> | null = null;
  let available = true;

  if (isShielded) {
    const result = await getInitialFlows(request, unavailablePolicy);
    initialFlows = result.items;
    pagination = result.pagination;
    available = result.available;
  } else {
    const result = await getInitialTxs(request, unavailablePolicy);
    initialTxs = result.items;
    pagination = result.pagination;
    available = result.available;
  }

  const archiveKey = `${request.type}:${request.flow}:${request.pool}:${request.minZec}:${request.cursor ?? 'first'}:${request.cursorIdx ?? 0}:${request.cursorId ?? 0}:${request.direction}:${request.page}`;
  const collectionUrl = new URL(getArchiveCanonicalPath(request), `${getBaseUrl()}/`).toString();
  const items = isShielded ? initialFlows : initialTxs;
  const uniqueItems = isShielded
    ? Array.from(new Map((items as { txid: string }[]).map(f => [f.txid, f])).values())
    : items as { txid: string }[];

  const collectionJsonLd = request.pageParamConsistent
    && (request.type === 'all' || (request.type === 'shielded' && !hasShieldedSubFilters(request)))
    && request.direction === 'next'
    && uniqueItems.length > 0
    ? {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        '@id': `${collectionUrl}#collection`,
        url: collectionUrl,
        name: request.page > 1
          ? `Zcash ${isShielded ? 'shielded ' : ''}transaction archive page ${request.page}`
          : `Latest Zcash ${isShielded ? 'shielded ' : ''}transactions`,
        isPartOf: { '@id': `${getBaseUrl()}/#website` },
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: uniqueItems.map((item, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            url: `${getBaseUrl()}/tx/${item.txid.toLowerCase()}`,
            name: `Zcash ${isShielded ? 'shielded ' : ''}transaction ${item.txid.toLowerCase()}`,
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
      <TxsClient
        key={`${archiveKey}:${initialView}`}
        initialView={initialView}
        initialTxs={initialTxs}
        initialFlows={initialFlows as never[]}
        initialPagination={pagination}
        initialPage={request.page}
        initialType={request.type}
        initialFlowFilter={request.flow}
        initialPoolFilter={request.pool}
        initialMinZec={request.minZec}
        initialCursor={request.cursor}
        initialCursorIdx={request.cursorIdx}
        initialCursorId={request.cursorId}
        initialDirection={request.direction}
        initialUnavailable={!available}
      />

    </>
  );
}
