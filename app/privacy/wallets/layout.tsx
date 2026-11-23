import { buildPageMetadata, getBaseUrl } from '@/lib/seo';
import { PageAbout } from '@/components/HomeAbout';

export const metadata = buildPageMetadata({
  title: 'Zcash Wallet Signals | ZecBlock',
  description:
    'Explore observed Zcash fee patterns and wallet implementation signals. Compare transaction matches with clear coverage and attribution limits.',
  path: '/privacy/wallets',
  networks: ['mainnet'],
  keywords: [
    'zcash wallet fingerprint',
    'zcash anonymity set',
    'zip-317 fee lanes',
    'zcash privacy analysis',
    'wallet usage distribution',
  ],
});

export default function WalletsLayout({ children }: { children: React.ReactNode }) {
  const url = `${getBaseUrl()}/privacy/wallets`;
  const schema = {'@context':'https://schema.org','@type':'WebPage','@id':`${url}#webpage`,url,name:metadata.title,description:metadata.description,isPartOf:{'@id':`${getBaseUrl()}/#website`}};
  return <><script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify(schema).replace(/</g,'\\u003c')}} />{children}<PageAbout path="/privacy/wallets" /></>;
}
