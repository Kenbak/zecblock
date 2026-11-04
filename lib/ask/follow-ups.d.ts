import type { AnalysisSpec } from './contract';
import type { ResearchResult } from './research-contract';
export function analysisFollowUps(spec: AnalysisSpec | null): string[];
export function researchFollowUps(result?: ResearchResult | null): string[];
