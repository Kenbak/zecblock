'use client';

import { useEffect } from 'react';
import { RouteError } from '@/components/RouteError';

export default function MiningError({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log an error identifier, not a potentially sensitive URL or payload.
    console.error('ZecBlock mining render failed', error.digest || error.name);
  }, [error]);
  return <RouteError reset={reset} subject="mining page" titleAsHeading={true} />;
}
