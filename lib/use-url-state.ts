'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * A selector value mirrored in one URL query parameter so a chart view can be
 * shared. The server renders the fallback, keeping ISR pages static; the URL
 * value is applied after mount. Unknown values are ignored, and the fallback
 * is omitted from the URL so default views keep their canonical address.
 */
export function useUrlState<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get(key);
    if (requested !== null && (allowed as readonly string[]).includes(requested)) {
      setValue(requested as T);
    }
    // Read once on mount; later changes come from this hook's setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const update = useCallback((next: T) => {
    setValue(next);
    const params = new URLSearchParams(window.location.search);
    if (next === fallback) params.delete(key);
    else params.set(key, next);
    const search = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
    );
  }, [fallback, key]);

  return [value, update];
}
