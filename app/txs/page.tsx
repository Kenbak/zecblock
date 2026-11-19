import type { Metadata } from 'next';
import {
  parseTransactionsRequest,
  getArchiveCanonicalPath,
  hasShieldedSubFilters,
  renderTransactionsPage,
} from './render';
import type { SearchParams } from './render';
import { buildPageMetadata, getBaseUrl } from '@/lib/seo';

interface TransactionsPageProps {
  searchParams: Promise<SearchParams>;
}

export async function generateMetadata({ searchParams }: TransactionsPageProps): Promise<Metadata> {
  const request = parseTransactionsRequest(await searchParams);
  const isStableArchive = (request.type === 'all' || (request.type === 'shielded' && !hasShieldedSubFilters(request)))
    && (request.page === 1 || request.direction === 'next')
    && request.pageParamConsistent;
  const pageSuffix = request.page > 1 ? ` - Page ${request.page}` : '';

  if (request.type === 'shielded') {
    return buildPageMetadata({
      title: `Zcash Shielded Transactions${pageSuffix} | ZecBlock`,
      description: request.page > 1
        ? `Browse Zcash shielded transaction archive page ${request.page}, including shielding and deshielding flows across privacy pools.`
        : 'Browse shielded Zcash transactions and track shielding and deshielding flows across Ironwood, Orchard, and Sapling privacy pools.',
      path: isStableArchive ? getArchiveCanonicalPath(request) : '/txs?type=shielded',
      index: isStableArchive && request.page === 1,
      keywords: ['zcash shielded transactions', 'zcash orchard', 'zcash sapling', 'shielded ZEC', 'zcash privacy'],
    });
  }

  return buildPageMetadata({
    title: `Latest Zcash Transactions${pageSuffix} | ZecBlock`,
    description: request.page > 1
      ? `Browse Zcash transaction archive page ${request.page}, with transaction hashes, block heights, transaction types, sizes, and confirmation times.`
      : 'Browse the latest Zcash transactions including shielded, transparent, and coinbase transactions. Real-time transaction explorer.',
    path: isStableArchive ? getArchiveCanonicalPath(request) : '/txs',
    index: isStableArchive && request.page === 1,
    keywords: ['zcash transactions', 'zcash transaction explorer', 'ZEC transactions', 'zcash shielded transactions', 'zcash tx'],
  });
}

export default async function TransactionsPage({
  searchParams,
}: TransactionsPageProps) {
  return renderTransactionsPage(searchParams);
}
