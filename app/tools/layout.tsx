import { buildPageMetadata } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'Zcash Tools | ZecBlock',
  description: 'Zcash tools to decode and broadcast transactions, decrypt shielded memos, compare public flow amounts, simulate block times, convert ZEC units and search anchor roots.',
  keywords: [
    'zcash tools',
    'zcash developer tools',
    'zcash raw transaction',
    'zcash tx decoder',
    'zcash broadcast transaction',
    'zcash blockchain tools',
    'ZEC developer',
  ],
  path: '/tools',
});

export default function ToolsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
