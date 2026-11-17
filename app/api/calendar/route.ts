import { NextResponse } from 'next/server';
import { getNetwork } from '@/lib/seo';
import { loadCalendar } from '@/lib/zcash-calendar-server';

/** Milestones for block pages: same source as /calendar. Mainnet only. */
export async function GET() {
  const headers = { 'X-Robots-Tag': 'noindex, follow' };
  if (getNetwork() !== 'mainnet') return NextResponse.json({ events: [] }, { headers: { ...headers, 'Cache-Control': 'public, max-age=3600' } });
  const calendar = await loadCalendar();
  return NextResponse.json(calendar, {
    headers: { ...headers, 'Cache-Control': 'public, max-age=0, must-revalidate', 'CDN-Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600', 'Vercel-CDN-Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600' },
  });
}
