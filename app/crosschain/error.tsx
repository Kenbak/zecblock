'use client';

import { useEffect } from 'react';
import { RouteError } from '@/components/RouteError';

export default function CrosschainError({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log an error identifier, not a potentially sensitive URL or payload.
    console.error('ZecBlock crosschain render failed', error.digest || error.name);
  }, [error]);
  return <RouteError reset={reset} subject="cross-chain page" titleAsHeading={true} />;
}
