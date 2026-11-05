/** Shared v1 transport contract. HTTP errors and malformed envelopes never become page data. */
export interface ApiPage {
  limit: number;
  hasNext: boolean;
  hasPrev: boolean;
  nextCursor: string | null;
  prevCursor: string | null;
  total?: number | null;
}
export interface ApiMeta {
  requestId: string;
  network: 'mainnet' | 'testnet' | 'crosslink-testnet';
  generatedAt: string;
  indexedHeight: number | null;
  source: { indexedHeight: number | null; observedAt: string | null };
  freshness: { status: 'fresh' | 'stale' | 'unknown' | 'unavailable'; ageSeconds: number | null };
  page?: ApiPage;
}
export interface ApiEnvelope<T> { data: T; meta: ApiMeta }
export class ApiError extends Error {
  // `extensions` holds the problem document's extension members unvalidated;
  // consumers must schema-check any member before displaying it.
  constructor(message: string, readonly status: number, readonly type?: string, readonly requestId?: string, readonly retryAfter?: string | null, readonly code?: string, readonly extensions?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function readApiResponse<T = unknown>(response: Response): Promise<ApiEnvelope<T>> {
  let body: unknown;
  try { body = await response.json(); } catch {
    throw new ApiError(response.ok ? 'The API returned an invalid response.' : `Request failed (HTTP ${response.status}).`, response.status);
  }
  return parseApiResponse<T>(response, body);
}

/** Reuse envelope validation after a server caller has bounded JSON size and read time. */
export function parseApiResponse<T = unknown>(response: Response, body: unknown): ApiEnvelope<T> {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  if (!response.ok) {
    throw new ApiError(
      typeof record?.detail === 'string' ? record.detail : `Request failed (HTTP ${response.status}).`,
      response.status,
      typeof record?.type === 'string' ? record.type : undefined,
      response.headers.get('x-request-id') ?? undefined,
      response.headers.get('retry-after'),
      typeof record?.code === 'string' ? record.code : undefined,
      record ?? undefined,
    );
  }
  const meta = record?.meta as Partial<ApiMeta> | undefined;
  if (!record || !Object.hasOwn(record, 'data') || !meta || typeof meta.requestId !== 'string'
      || !['mainnet', 'testnet', 'crosslink-testnet'].includes(meta.network ?? '')) {
    throw new ApiError('The API returned an incompatible response.', 502);
  }
  return record as unknown as ApiEnvelope<T>;
}
/** Data-only consumers use the same checked envelope parser as pagination/provenance consumers. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readApiData<T = any>(response: Response): Promise<T> {
  return (await readApiResponse<T>(response)).data;
}

export async function readApiCollection<T>(response: Response): Promise<{ items: T[]; page: ApiPage }> {
  const { data, meta } = await readApiResponse<T[]>(response);
  const page = meta.page;
  if (!Array.isArray(data) || !page || !Number.isInteger(page.limit)
      || typeof page.hasNext !== 'boolean' || typeof page.hasPrev !== 'boolean'
      || (page.nextCursor !== null && typeof page.nextCursor !== 'string')
      || (page.prevCursor !== null && typeof page.prevCursor !== 'string')) {
    throw new ApiError('The API returned an invalid collection.', 502);
  }
  return { items: data, page };
}

/** URL validation only: cursor contents remain opaque to the application. */
export function parseApiCursor(value: string | undefined): string | null {
  return value && value.length <= 4096 && /^[A-Za-z0-9_-]{20,}$/.test(value) ? value : null;
}
