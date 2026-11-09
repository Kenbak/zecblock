import 'server-only';
import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FactCardImage } from '@/components/cards/FactCardImage';
import { EXPORT_SIZE } from '@/lib/chart-sharing';
import type { FactCard } from '@/lib/fact-cards';

/** Card images are live: short shared cache, never indexed as pages. */
export async function factCardResponse(card: FactCard | null, network: string): Promise<Response> {
  // A card without authoritative data is not drawn; a zero would be a false claim.
  if (!card) return new Response('Card data unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60', 'X-Robots-Tag': 'noindex' } });
  const [logo, font] = await Promise.all([
    readFile(join(process.cwd(), 'public/brand/zecblock-logotype.png')),
    readFile(join(process.cwd(), 'public/fonts/chart-export/Geist-Regular.ttf')),
  ]);
  const observed = new Date().toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC');
  return new ImageResponse(<FactCardImage card={card} logo={`data:image/png;base64,${logo.toString('base64')}`} network={network} observed={observed} />, {
    ...EXPORT_SIZE,
    fonts: [{ name: 'ZecBlock Export', data: font, weight: 400, style: 'normal' }],
    headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=600', 'X-Robots-Tag': 'noindex', 'Access-Control-Allow-Origin': '*' },
  });
}
