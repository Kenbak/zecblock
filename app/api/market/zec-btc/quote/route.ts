import { getNetwork } from '@/lib/seo';
import { getZecBtcQuote } from '@/lib/zec-btc-source';

const HEADERS = {
  'Cache-Control': 'no-store',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, follow',
};

export async function GET(request: Request) {
  if (getNetwork() !== 'mainnet') {
    return Response.json({ error: 'Not found' }, { status: 404, headers: HEADERS });
  }
  if (new URL(request.url).search) {
    return Response.json({ error: 'Query parameters are not supported' }, { status: 400, headers: HEADERS });
  }
  const snapshot = await getZecBtcQuote();
  return Response.json(snapshot, {
    status: snapshot.quote ? 200 : 503,
    headers: HEADERS,
  });
}
