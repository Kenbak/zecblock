import { buildPageMetadata, getBaseUrl, getNetwork } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'Zcash Valuation & Market Context | ZecBlock',
  description: getNetwork() === 'mainnet'
    ? 'Track ZEC price in USD and as a percentage of Bitcoin, with ZEC/BTC history, modeled cost basis, transparent spending and shielded supply.'
    : 'Explore ZEC price, modeled MVRV and realized price, transparent spending, and shielded supply, with sources and data limitations.',
  keywords: [
    'zcash MVRV',
    'zcash realized price',
    'zcash valuation',
    ...(getNetwork() === 'mainnet' ? ['ZEC BTC ratio'] : []),
    'zcash SOPR',
    'zcash NUPL',
    'on-chain analytics zcash',
  ],
  path: '/valuation',
  networks: ['mainnet'],
  imageAlt: 'ZecBlock Zcash on-chain valuation metrics',
});

export default function ValuationLayout({ children }: { children: React.ReactNode }) {
  const url = `${getBaseUrl()}/valuation`;
  const schema = {'@context':'https://schema.org','@type':'WebPage','@id':`${url}#webpage`,url,name:metadata.title,description:metadata.description,isPartOf:{'@id':`${getBaseUrl()}/#website`}};
  return <><script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify(schema).replace(/</g,'\\u003c')}} />{children}</>;
}
