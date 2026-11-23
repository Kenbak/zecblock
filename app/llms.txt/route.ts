import { getNetwork } from '@/lib/seo';
import { renderLlmsTxt } from '@/lib/llms/docs';

// Built once per deploy and served from the CDN; mainnet only.
export const dynamic = 'force-static';

export function GET() {
  if (getNetwork() !== 'mainnet') return new Response('Not found', { status: 404 });
  return new Response(renderLlmsTxt(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
