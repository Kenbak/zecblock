/** Server-only mTLS bridge. Secrets must never be imported by client components. */
export function proxyAskStaging(request: Request): Promise<Response>;
