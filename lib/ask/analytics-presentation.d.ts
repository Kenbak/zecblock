import type { AskAnalytics } from './chat';
export function formatAnalyticsDate(value: string, locale?: string): string;
export function formatAnalyticsRange(start: string, end: string, locale?: string): string;
export function analyticsPeriod(plan: AskAnalytics['plan'], row: AskAnalytics['rows'][number]): { start: string; end: string; partial: boolean };
