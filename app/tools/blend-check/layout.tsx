import { buildPageMetadata } from '@/lib/seo';
import { PageAbout } from '@/components/HomeAbout';

export const metadata = buildPageMetadata({
  title: 'Zcash Amount Frequency — Blend Check | ZecBlock',
  description: 'Compare a ZEC amount with observed public shielding and deshielding flows. Amount frequency is a heuristic, not a privacy guarantee.',
  keywords: ['zcash', 'privacy', 'blend', 'amount', 'shielded', 'transaction', 'common'],
  path: '/tools/blend-check',
  networks: ['mainnet'],
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}<PageAbout path="/tools/blend-check" /></>;
}
