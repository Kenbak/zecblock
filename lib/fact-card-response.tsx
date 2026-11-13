import 'server-only';
import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FactCardImage } from '@/components/cards/FactCardImage';
import { EXPORT_SIZE } from '@/lib/chart-sharing';
import type { FactCard } from '@/lib/fact-cards';

const LOGO_TYPES: Record<string, string> = { png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg' };

/** Row logos are local public files, inlined for the renderer. A logo that cannot be read is simply not drawn. */
async function rowLogos(card: FactCard): Promise<Record<string, string>> {
  const rows = card.visual?.kind === 'ranking' ? card.visual.rows : [];
  const paths = [...new Set(rows.map(row => row.logo).filter((path): path is string => typeof path === 'string' && /^\/[a-z0-9/_-]+\.(png|svg|jpg)$/.test(path)))];
  const entries = await Promise.all(paths.map(async path => {
    try {
      const data = await readFile(join(process.cwd(), 'public', path));
      // Some public marks carry a .png name over JPEG bytes; the renderer needs the real type.
      const type = data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : data[0] === 0x89 && data[1] === 0x50 ? 'image/png' : LOGO_TYPES[path.split('.').pop()!];
      return [path, `data:${type};base64,${data.toString('base64')}`] as const;
    } catch {
      return null;
    }
  }));
  return Object.fromEntries(entries.filter(entry => entry != null));
}

/** Card images are live: short shared cache, never indexed as pages. */
export async function factCardResponse(card: FactCard | null, network: string): Promise<Response> {
  // A card without authoritative data is not drawn; a zero would be a false claim.
  if (!card) return new Response('Card data unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60', 'X-Robots-Tag': 'noindex' } });
  const [logo, font] = await Promise.all([
    readFile(join(process.cwd(), 'public/brand/zecblock-logotype.png')),
    readFile(join(process.cwd(), 'public/fonts/chart-export/Geist-Regular.ttf')),
  ]);
  const logos = await rowLogos(card);
  const observed = new Date().toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC');
  return new ImageResponse(<FactCardImage card={card} logo={`data:image/png;base64,${logo.toString('base64')}`} network={network} observed={observed} logos={logos} />, {
    ...EXPORT_SIZE,
    fonts: [{ name: 'ZecBlock Export', data: font, weight: 400, style: 'normal' }],
    headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=600', 'X-Robots-Tag': 'noindex', 'Access-Control-Allow-Origin': '*' },
  });
}
