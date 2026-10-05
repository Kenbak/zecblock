import { CrosslinkLearn } from '@/components/CrosslinkLearn';
import { buildPageMetadata } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'Learn Crosslink - PoW+PoS Finality, Staking & v14 | ZecBlock',
  description: 'Learn how Crosslink works: hybrid PoW/PoS finality, finalizers, delegation bonds, and the v14 Round 3 staking and activation schedule.',
  keywords: ['crosslink', 'zcash crosslink', 'proof of stake', 'finality', 'staking', 'finalizer', 'cTAZ', 'zcash staking'],
  path: '/learn/crosslink',
  index: false,
});

export default function CrosslinkLearnPage() {
  return <CrosslinkLearn />;
}
