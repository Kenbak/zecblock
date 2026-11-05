import type { ZodType } from 'zod';
export interface AnalysisSpec {
  version: 1;
  metric: 'balances' | 'flows' | 'activity' | 'swap_volume' | 'swap_count' | 'transactions' | 'pulse' | 'migration_share' | 'chain_inflows' | 'chain_outflows';
  period: '30d' | '90d' | '1y';
  pool: 'all' | 'orchard' | 'ironwood' | 'sapling';
  view: 'line' | 'bar' | 'table';
  start: string | null;
  end: string | null;
}
export const analysisSchema: ZodType<AnalysisSpec>;
export const metricIds: AnalysisSpec['metric'][];
export const requestSchema: ZodType<{ question: string; context: AnalysisSpec | null; challenge?: string }>;
export const starters: { id: string; category: string; title: string; detail: string; spec: AnalysisSpec }[];
export function resolveShortcut(question: string, context?: AnalysisSpec | null): AnalysisSpec | null;
