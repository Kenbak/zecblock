export interface NodeLocation {
  country: string;
  countryCode: string;
  city?: string | null;
  lat: number;
  lon: number;
  nodeCount: number;
  avgPingMs: number | null;
  topClient?: string | null;
  topIsp?: string | null;
}

/** Geographic cells may overlap visually, but never acquire another country's count. */
export function clusterNodeLocations(locations: readonly NodeLocation[]): NodeLocation[] {
  const clusters = new Map<string, NodeLocation>();
  for (const location of locations) {
    const key = `${location.countryCode || location.country}:${Math.round(location.lat / 8)},${Math.round(location.lon / 8)}`;
    const previous = clusters.get(key);
    if (!previous) {
      clusters.set(key, { ...location });
      continue;
    }
    const total = previous.nodeCount + location.nodeCount;
    clusters.set(key, {
      ...previous,
      lat: (previous.lat * previous.nodeCount + location.lat * location.nodeCount) / total,
      lon: (previous.lon * previous.nodeCount + location.lon * location.nodeCount) / total,
      nodeCount: total,
      city: null,
      // Cell means lack their sample sizes; a combined mean would be misleading.
      avgPingMs: null,
      topClient: previous.topClient === location.topClient ? previous.topClient : null,
      topIsp: previous.topIsp === location.topIsp ? previous.topIsp : null,
    });
  }
  return [...clusters.values()];
}
