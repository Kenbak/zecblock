import { buildPageMetadata, getBaseUrl } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'Zcash Shielded Pool Statistics | ZecBlock',
  description: 'Compare Zcash shielded pool balances, transaction counts and shares, and public shielding flows across Ironwood, Orchard, Sapling, and Sprout.',
  path: '/pools',
  index: true,
  networks: ['mainnet'],
  imageAlt: 'ZecBlock Zcash shielded pool statistics',
});

export default function PoolsLayout({ children }: { children: React.ReactNode }) {
  const url = `${getBaseUrl()}/pools`;
  const schema = {
    '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${url}#webpage`,
    url, name: 'Zcash Shielded Pools',
    description: 'Zcash shielded pool balances, supply history, transaction activity by pool, and public shielding flows.',
    isPartOf: { '@id': `${getBaseUrl()}/#website` },
    publisher: { '@id': 'https://zecblock.com/#organization' },
  };
  return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />{children}</>;
}
