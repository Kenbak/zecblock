'use client';

import { useEffect } from 'react';
import { RouteError } from '@/components/RouteError';

export default function NetworkError({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log an error identifier, not a potentially sensitive URL or payload.
    console.error('ZecBlock network render failed', error.digest || error.name);
  }, [error]);
  return <RouteError reset={reset} subject="network page" titleAsHeading={true} />;
}
