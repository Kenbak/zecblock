import { buildPageMetadata } from '@/lib/seo';
import { PageAbout } from '@/components/HomeAbout';

export const metadata = buildPageMetadata({
  title: 'Zcash Turnstile Tracker | ZecBlock',
  description:
    'Track where deshielded ZEC goes: transparent addresses, reshielding, exchanges, and other transfers. Updated every 5 minutes.',
  keywords: [
    'zcash turnstile',
    'zcash deshielding',
    'zcash shielded pool',
    'deshielded ZEC',
    'zcash exchange flow',
    'zcash privacy analytics',
    'ZEC turnstile tracker',
    'ZecBlock',
  ],
  path: '/turnstile',
  imageAlt: 'ZecBlock Turnstile Tracker — Zcash deshielding analytics',
  networks: ['mainnet'],
});

export default function TurnstileLayout({ children }: { children: React.ReactNode }) {
  return <>{children}<PageAbout path="/turnstile" /></>;
}
