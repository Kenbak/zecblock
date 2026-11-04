'use client';

import { useEffect } from 'react';
import { RouteError } from '@/components/RouteError';

export default function IronwoodError({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log an error identifier, not a potentially sensitive URL or payload.
    console.error('ZecBlock ironwood render failed', error.digest || error.name);
  }, [error]);
  return <RouteError reset={reset} subject="Ironwood migration page" titleAsHeading={true} />;
}
