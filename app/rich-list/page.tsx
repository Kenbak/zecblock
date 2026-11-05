import { getApiUrl } from '@/lib/api-config';
import { fetchApiDataWithDeadline, isServerRenderDeadlineError } from '@/lib/server-fetch';
import { retainLastGoodOrBuildFallback } from '@/lib/isr-fallback';
import RichListClient, {
  type Concentration,
  type PaginationData,
  type RichListEntry,
} from './RichListClient';

export const revalidate = 60;

interface InitialRichList {
  addresses: RichListEntry[];
  concentration: Concentration | null;
  pagination: PaginationData | null;
  unavailable?: boolean;
}

const EMPTY_RICH_LIST: InitialRichList = {
  addresses: [],
  concentration: null,
  pagination: null,
};

async function getInitialRichList(): Promise<InitialRichList> {
  try {
    const data = await fetchApiDataWithDeadline<{
      addresses?: RichListEntry[];
      concentration?: Concentration;
      pagination?: PaginationData;
    }>(
      `${getApiUrl()}/v1/addresses/rich-list?limit=100&offset=0`,
      { next: { revalidate: 60 } },
    );
    if (!(data)
      || !Array.isArray(data.addresses)
      || !data.concentration
      || !data.pagination) {
      throw new Error('Rich list payload is malformed');
    }

    return {
      addresses: data.addresses,
      concentration: data.concentration,
      pagination: data.pagination,
    };
  } catch (error) {
    // Protected Ask previews may have no warm ISR snapshot. Keep an explicit
    // unavailable state that can recover through the bounded public GET bridge.
    // Production still throws so revalidation retains its last successful page.
    if (process.env.VERCEL_ENV === 'preview' && process.env.ASK_STAGING_ENABLED === 'true' && isServerRenderDeadlineError(error)) {
      console.warn('Rich list initial snapshot exceeded its render deadline');
      return { ...EMPTY_RICH_LIST, unavailable: true };
    }
    console.error('Error fetching initial rich list:', error);
    return retainLastGoodOrBuildFallback(EMPTY_RICH_LIST, error, 'rich list');
  }
}

export default async function RichListPage() {
  const initial = await getInitialRichList();
  return (
    <RichListClient
      initialAddresses={initial.addresses}
      initialConcentration={initial.concentration}
      initialPagination={initial.pagination}
      initialUnavailable={initial.unavailable === true}
    />
  );
}
