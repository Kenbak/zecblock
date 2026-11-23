import { getNetwork } from '@/lib/seo';
import { SITE_URL, findLlmsDoc, getLlmsDocs } from '@/lib/llms/docs';
import { markdownRouteSegments } from '@/lib/llms/paths';

// Markdown version of each page, reached at the page URL plus `.md` through a
// rewrite in next.config.ts. Every document is built once per deploy and
// served from the CDN; unknown paths 404. Mainnet only.
export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams() {
  if (getNetwork() !== 'mainnet') return [];
  return getLlmsDocs().map(doc => ({ path: markdownRouteSegments(doc.markdownPath) }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const doc = getNetwork() === 'mainnet' ? findLlmsDoc(`/${path.join('/')}.md`) : undefined;
  if (!doc) return new Response('Not found', { status: 404 });
  // The HTML page is canonical; shared data page types have no single page.
  const links = [`<${SITE_URL}/llms.txt>; rel="describedby"`];
  if (!doc.path.endsWith('/') || doc.path === '/') links.unshift(`<${SITE_URL}${doc.path}>; rel="canonical"`);
  return new Response(doc.markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      Link: links.join(', '),
    },
  });
}
