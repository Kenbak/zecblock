// Only aggregate visits to these public landing pages. Never send identifiers,
// questions, search parameters, fragments, or arbitrary paths to analytics.
const PUBLIC_PAGES = new Set([
  '/', '/about', '/press', '/learn', '/docs', '/tools', '/charts', '/network',
  '/network/attestations', '/network/wallet-servers', '/mining', '/pools', '/privacy', '/privacy-risks',
  '/ironwood', '/turnstile', '/zodl', '/pulse', '/crosschain', '/usage-clock',
  '/valuation', '/blocks', '/txs', '/mempool', '/newsletter', '/governance',
  '/privacy-policy', '/terms',
]);
export function analyticsPageUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || !PUBLIC_PAGES.has(url.pathname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}
