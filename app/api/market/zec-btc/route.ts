import { getNetwork } from '@/lib/seo';
import { isZecBtcPeriod } from '@/lib/zec-btc';
import { getZecBtcSnapshot } from '@/lib/zec-btc-source';

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
  const params = new URL(request.url).searchParams;
  const period = params.get('period') ?? '30d';
  if ([...params.keys()].some(key => key !== 'period')
    || params.getAll('period').length > 1 || !isZecBtcPeriod(period)) {
    return Response.json({ error: 'Invalid period' }, { status: 400, headers: HEADERS });
  }
  const snapshot = await getZecBtcSnapshot(period);
  return Response.json(snapshot, {
    status: snapshot.quote || snapshot.history ? 200 : 503,
    headers: HEADERS,
  });
}
