export interface SupplyObservation { date: string; circulating: number | null; circulatingZat?: number | string | null; height?: number | null }
export interface EmissionResponse {
  circulating: number | null;
  remaining: number | null;
  /** Current subsidy × target blocks per day; not an observed rate. */
  dailyEmissionEstimate: number | null;
  targetSpacingSeconds?: number | null;
  supplyObservedAt: string | null;
  supplyHistory: SupplyObservation[];
  cadence?: { intervalSeconds: number; startHeight: number; endHeight: number; intervals: number; lagBlocks?: number } | null;
  projection?: { dateBasis?: string; points: (SupplyObservation & { halving: number | null })[] } | null;
}

/** Keep the final observation of each UTC day; unknown values stay unknown. */
export function dailySupplyHistory(history: SupplyObservation[]) {
  const days = new Map<string, SupplyObservation>();
  for (const point of history) if (Number.isFinite(Date.parse(point.date))) days.set(point.date.slice(0, 10), point);
  return [...days.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

export function issuanceChartPoints(data: EmissionResponse | null) {
  if (!data) return [];
  const points: { time: number; observed: number | null; projected: number | null; halving: number | null }[] = [];
  for (const point of dailySupplyHistory(data.supplyHistory ?? [])) {
    const time = Date.parse(point.date);
    const previous = points.at(-1);
    if (previous && time - previous.time > 2 * 86400000) points.push({ time: previous.time + 86400000, observed: null, projected: null, halving: null });
    points.push({ time, observed: point.circulating != null && Number.isFinite(point.circulating) ? point.circulating : null, projected: null, halving: null });
  }
  for (const point of data.projection?.points ?? []) {
    const time = Date.parse(point.date);
    if (!Number.isFinite(time)) continue;
    const previous = points.at(-1);
    const projected = point.circulating != null && Number.isFinite(point.circulating) ? point.circulating : null;
    if (previous?.time === time) previous.projected = projected;
    else points.push({ time, observed: null, projected, halving: point.halving });
  }
  return points;
}
