import { cache } from 'react';
import { getZnsStatus, resolveZnsName, getZnsNameEvents } from './zns';
import type { NameResolution, NameSnapshot } from './name-types';

// Request-local deduplication: metadata, heading and detail panel share one result.
// No persistent cache: an uncertain missing name cannot hide a new registration.
export const resolveName = cache(async (name: string): Promise<NameResolution> => {
  try {
    const registration = await resolveZnsName(name, AbortSignal.timeout(3_000));
    return registration ? { state: 'registered', registration } : { state: 'available' };
  } catch {
    return { state: 'error' };
  }
});

export async function resolveNameExtras(name: string, resolution: NameResolution): Promise<NameSnapshot> {
  // Optional details have a separate, short budget and cannot discard the name.
  if (resolution.state === 'registered') {
    try {
      const result = await getZnsNameEvents(name, AbortSignal.timeout(1_000));
      return { ...resolution, events: result.events };
    } catch {
      return { ...resolution, events: null };
    }
  }
  if (resolution.state === 'available') {
    try {
      const status = await getZnsStatus(AbortSignal.timeout(1_000));
      return { ...resolution, pricing: status.pricing ?? null };
    } catch {
      return { ...resolution, pricing: null };
    }
  }
  return resolution;
}
