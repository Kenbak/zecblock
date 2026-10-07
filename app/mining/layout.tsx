import { buildPageMetadata, getBaseUrl } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'Zcash Mining Statistics & Pool Distribution | ZecBlock',
  description: 'Explore Zcash hashrate, observed orphan rates, mining pool shares, block production, fees, and miner reward flows. Compare 24h, 7d, and 30d orphan observations.',
  path: '/mining',
  index: true,
  networks: ['mainnet'],
  imageAlt: 'ZecBlock Zcash mining statistics and pool distribution',
});

export default function MiningLayout({ children }: { children: React.ReactNode }) {
  const url = `${getBaseUrl()}/mining`;
  const schema = {'@context':'https://schema.org','@type':'WebPage','@id':`${url}#webpage`,url,name:metadata.title,description:metadata.description,isPartOf:{'@id':`${getBaseUrl()}/#website`}};
  return <><script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify(schema).replace(/</g,'\\u003c')}} />{children}</>;
}
