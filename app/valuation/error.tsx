'use client';

import { useEffect } from 'react';
import { RouteError } from '@/components/RouteError';

export default function ValuationError({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log an error identifier, not a potentially sensitive URL or payload.
    console.error('ZecBlock valuation render failed', error.digest || error.name);
  }, [error]);
  return <RouteError reset={reset} subject="valuation page" titleAsHeading={true} />;
}
