'use client';

import { useState } from 'react';
import Image from 'next/image';
import { getEntityLogoSrc } from '@/lib/entity-logos';

/** A neutral category cue when the API has a label but no sourced entity mark. */
function EntityCategoryIcon({ category }: { category?: string | null }) {
  const financial = ['exchange', 'custodian', 'fund', 'foundation'].includes(category?.toLowerCase() ?? '');
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted" aria-hidden="true" focusable="false">
      {financial ? <><path d="m3 8 9-5 9 5H3ZM4 21h16M6 8v9m6-9v9m6-9v9" /></> : <><path d="M4 4h16v16H4ZM4 9h16M9 9v11" /></>}
    </svg>
  );
}

/** Decorative identity cue beside an unchanged, visible address label. */
export function EntityLogo({
  label,
  category,
  logoUrl,
  className = '',
}: {
  label: string;
  category?: string | null;
  logoUrl?: string | null;
  className?: string;
}) {
  const src = getEntityLogoSrc(label, logoUrl);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  return (
    <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${className}`} aria-hidden="true">
      {src && src !== failedSrc ? (
        <Image src={src} alt="" width={20} height={20} className="h-5 w-5 object-contain" unoptimized onError={() => setFailedSrc(src)} />
      ) : <EntityCategoryIcon category={category} />}
    </span>
  );
}
