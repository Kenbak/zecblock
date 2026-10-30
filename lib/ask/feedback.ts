import { readApiResponse } from '@/lib/api-client';
import { getAskApiUrl } from './api-base';

// Mirrors server/api/v1/lib/ask-feedback.js. Anything else is rejected there.
export const answerRoutes = ['run_sql', 'decline', 'clarify', 'explain_topic', 'open_chart', 'get_block', 'get_transaction', 'needs_query', 'lookup', 'guide', 'classifier', 'sql', 'unknown'] as const;
export const answerReasons = ['wrong_number', 'misunderstood', 'should_answer', 'refused_wrongly', 'unclear', 'chart_not_useful'] as const;
const locales = ['auto', 'en', 'fr', 'es', 'de', 'pt', 'ja', 'zh', 'ko', 'ar', 'ru'];
export type AnswerVote = 'up' | 'down';
export type AnswerRoute = typeof answerRoutes[number];
export type AnswerReason = typeof answerReasons[number];
export const SHARED_ANSWER_LIMIT = 4000, SHARED_SQL_LIMIT = 6000;
export interface AnswerRating { vote: AnswerVote; reason?: AnswerReason }
export interface AnswerFeedback extends AnswerRating {
  route: AnswerRoute; template: boolean; locale: string; page: string; replaces?: AnswerRating;
  shareId?: string; shared?: { question: string; answer: string; sql?: string };
}
export function answerRoute(route: string | undefined): AnswerRoute {
  return (answerRoutes as readonly string[]).includes(route || '') ? route as AnswerRoute : 'unknown';
}
export function feedbackLocale(locale: string | undefined) { return locale && locales.includes(locale) ? locale : 'auto'; }
export async function sendAnswerFeedback(feedback: AnswerFeedback, signal?: AbortSignal): Promise<{ recorded: boolean; shared: boolean }> {
  const response = await fetch(`${getAskApiUrl()}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal, body: JSON.stringify(feedback) });
  return (await readApiResponse<{ recorded: boolean; shared: boolean }>(response)).data;
}
