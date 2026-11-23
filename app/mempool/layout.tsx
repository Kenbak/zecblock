import { buildPageMetadata } from '@/lib/seo';
import { PageAbout } from '@/components/HomeAbout';

export const metadata = buildPageMetadata({
  title: 'Zcash Mempool: Pending Transactions | ZecBlock',
  description: 'Watch pending and unconfirmed Zcash transactions in real time, including transaction size, fee rate, and confirmation status.',
  keywords: ['zcash mempool', 'zcash pending transactions', 'zcash unconfirmed transactions', 'ZEC mempool', 'zcash transaction pool', 'zcash fee rate'],
  path: '/mempool',
});

export default function MempoolLayout({ children }: { children: React.ReactNode }) {
  return <>{children}<PageAbout path="/mempool" /></>;
}
