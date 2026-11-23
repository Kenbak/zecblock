import { buildPageMetadata } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'Zcash Network Pulse — Statistical Anomaly Feed | ZecBlock',
  description:
    'Auto-detected on-chain anomalies for Zcash: unusual transaction volumes, shielding spikes, cross-chain flows, fee surges, and valuation signals.',
  keywords: [
    'zcash anomalies',
    'zcash pulse',
    'zcash on-chain events',
    'zcash network activity',
    'zcash statistical events',
  ],
  path: '/pulse',
  networks: ['mainnet'],
  imageAlt: 'ZecBlock Zcash network pulse — anomaly feed',
});

export default function PulseLayout({ children }: { children: React.ReactNode }) {
  return children;
}
