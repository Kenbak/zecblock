'use client';

import { useState } from 'react';
import Image from 'next/image';
import { MiningSectionIcon } from '@/components/icons/home-section';

const POOL_LOGOS: Readonly<Record<string, string>> = {
  '2miners': '/brands/mining/2miners.png',
  '2minerssolo': '/brands/mining/2miners.png',
  antpool: '/brands/mining/antpool.png',
  f2pool: '/brands/mining/f2pool.svg',
  foundry: '/brands/mining/foundry.png',
  foundryusa: '/brands/mining/foundry.png',
  foundryusapool: '/brands/mining/foundry.png',
  luxor: '/brands/mining/luxor.svg',
  kupool: '/brands/mining/kupool.png',
  sluiceypool: '/brands/mining/sluicey.svg',
  viabtc: '/brands/mining/viabtc.png',
  viabtcsolo: '/brands/mining/viabtc.png',
};

/** Brand marks identify existing pool labels; they do not change attribution. */
export function PoolLogo({ name, className = '' }: { name: string; className?: string }) {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const src = Object.hasOwn(POOL_LOGOS, key) ? POOL_LOGOS[key] : undefined;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  return (
    <span aria-hidden="true" className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${className}`}>
      {src && src !== failedSrc ? (
        <Image
          src={src}
          alt=""
          width={20}
          height={20}
          className="h-5 w-5 object-contain"
          unoptimized
          onError={() => setFailedSrc(src)}
        />
      ) : <MiningSectionIcon className="h-4 w-4 text-muted" />}
    </span>
  );
}
