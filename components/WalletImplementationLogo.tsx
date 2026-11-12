'use client';

import { useState } from 'react';
import Image from 'next/image';
import { getWalletImplementationLogos, getWalletReadinessLogos, type WalletLogoAsset } from '@/lib/wallet-logos';
import { SoftwareSectionIcon } from '@/components/icons/home-section';

function WalletMark({ src }: { src: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
      {failedSrc !== src ? (
        <Image src={src} alt="" width={20} height={20} className="h-5 w-5 object-contain" unoptimized onError={() => setFailedSrc(src)} />
      ) : <SoftwareSectionIcon className="h-4 w-4 text-muted" />}
    </span>
  );
}

function WalletLogos({ logos }: { logos: readonly WalletLogoAsset[] }) {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1">
      {logos.length ? logos.map(logo => <WalletMark key={logo.id} src={logo.src} />) : (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          <SoftwareSectionIcon className="h-4 w-4 text-muted" />
        </span>
      )}
    </span>
  );
}

/** Decorative identity marks only for the implementation-card's visible name. */
export function WalletImplementationLogo({ name }: { name: string }) {
  return <WalletLogos logos={getWalletImplementationLogos(name)} />;
}

/** The directory names a wallet directly; SDK and library rows keep a neutral mark. */
export function WalletReadinessLogo({ name }: { name: string }) {
  return <WalletLogos logos={getWalletReadinessLogos(name)} />;
}
