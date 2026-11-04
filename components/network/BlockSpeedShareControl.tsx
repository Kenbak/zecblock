'use client';

import { useCallback } from 'react';
import { ChartShareControl } from '@/components/charts/ChartShareControl';
import { NETWORK } from '@/lib/api-config';

const shareUrl = `${NETWORK === 'testnet' ? 'https://testnet.zecblock.com' : 'https://zecblock.com'}/network/block-speed`;

/** Use the same share menu as other charts, with the server-rendered card. */
export function BlockSpeedShareControl() {
  const capture = useCallback(async () => {
    const response = await fetch('/network/block-speed/image');
    if (!response.ok) throw new Error('Block speed image unavailable');
    return response.blob();
  }, []);

  return <ChartShareControl title="Zcash block speed" shareUrl={shareUrl}
    shareText="Zcash block speed and wallet confirmations with NU7"
    fileName="zecblock-block-speed.png" capture={capture} />;
}
