import { getApiUrl } from '@/lib/api-config';

/** Only Ask transport changes in a staging build; evidence keeps its public API. */
export function getAskApiUrl(): string {
  return process.env.NEXT_PUBLIC_ASK_STAGING === 'true'
    ? '/api/ask-staging/v1/ask'
    : `${getApiUrl()}/v1/ask`;
}

export function isAuthenticatedAskStaging(capability: { authenticatedStaging?: boolean }): boolean {
  return process.env.NEXT_PUBLIC_ASK_STAGING === 'true' && capability.authenticatedStaging === true;
}
