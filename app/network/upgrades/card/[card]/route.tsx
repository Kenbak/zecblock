import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readApiData } from '@/lib/api-client';
import { getApiUrlForNetwork } from '@/lib/api-config';
import { loadBlockSpeedSnapshot } from '@/lib/block-speed-server';
import { EXPORT_SIZE } from '@/lib/chart-sharing';
import { getChartColors } from '@/lib/chart-theme';
import { blocksCard, countdownCard, NU7_CARDS, nsmCard, readinessCard, type Nu7Card, type Nu7CardId } from '@/lib/nu7-cards';
import { loadUpgradeTrackers } from '@/lib/upgrade-trackers-server';
import { fetchWithDeadline } from '@/lib/server-fetch';
import { getNetwork } from '@/lib/seo';

export const runtime = 'nodejs';

const MUTED = '#565D68';

async function apiData(network: 'mainnet' | 'testnet', path: string): Promise<unknown> {
  try {
    const response = await fetchWithDeadline(`${getApiUrlForNetwork(network)}${path}`, { next: { revalidate: 60 } });
    return response.ok ? await readApiData(response) : null;
  } catch {
    return null;
  }
}

async function buildCard(id: Nu7CardId, network: 'mainnet' | 'testnet'): Promise<Nu7Card | null> {
  if (id === 'countdown') return countdownCard(network, (await loadUpgradeTrackers(network)).snapshot);
  if (id === 'blocks') return blocksCard((await loadBlockSpeedSnapshot(network)).story);
  if (id === 'nsm') return nsmCard(network, await apiData(network, '/v1/network/accounting/history?period=all') as Parameters<typeof nsmCard>[1]);
  return readinessCard(network, await apiData(network, '/v1/network/nodes/upgrade-readiness') as Parameters<typeof readinessCard>[1]);
}

function Visual({ card, gold }: { card: Nu7Card; gold: string }) {
  const visual = card.visual;
  if (!visual) return null;
  if (visual.kind === 'progress' || visual.kind === 'share') {
    const label = visual.kind === 'progress' ? `${visual.from} → ${visual.to}` : visual.label;
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 1000 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, color: '#9CA4B0' }}>
        <span>{label}</span><span>{visual.percent.toFixed(visual.kind === 'progress' ? 2 : 1)}%</span>
      </div>
      <div style={{ display: 'flex', height: 14, borderRadius: 7, background: '#20242A', overflow: 'hidden' }}>
        <div style={{ display: 'flex', width: `${visual.percent}%`, background: gold, borderRadius: 7 }} />
      </div>
    </div>;
  }
  const max = Math.max(...visual.bars.map(bar => bar.value), 1);
  const slot = 1000 / visual.bars.length;
  return <svg width={1000} height={150} viewBox="0 0 1000 150">
    {visual.bars.map((bar, i) => {
      const h = bar.value / max * 140;
      const color = bar.nu7 ? gold : MUTED;
      return <rect key={i} x={i * slot + slot * 0.15} y={150 - h} width={slot * 0.7} height={h}
        fill={bar.projected ? 'none' : color} stroke={bar.projected ? color : 'none'} strokeDasharray={bar.projected ? '4 3' : undefined} strokeWidth={1.5} />;
    })}
  </svg>;
}

/** 1200×675 cards in the chart-export template, one fact each. */
export async function GET(_request: Request, { params }: { params: Promise<{ card: string }> }) {
  const { card: id } = await params;
  const network = getNetwork();
  if (network === 'crosslink-testnet' || !NU7_CARDS.includes(id as Nu7CardId)) return new Response('Not found', { status: 404 });
  const card = await buildCard(id as Nu7CardId, network);
  // A card that has no authoritative data yet (e.g. NSM before activation) is not drawn.
  if (!card) return new Response('NU7 card data unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
  const gold = getChartColors('dark').gold;
  const [logo, font] = await Promise.all([
    readFile(join(process.cwd(), 'public/brand/zecblock-logotype.png')),
    readFile(join(process.cwd(), 'public/fonts/chart-export/Geist-Regular.ttf')),
  ]);
  const observed = new Date().toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC');
  return new ImageResponse(<div style={{ width: 1200, height: 675, padding: '44px 100px', background: '#0B0C0E', color: '#F1F3F5', display: 'flex', flexDirection: 'column', fontFamily: 'ZecBlock Export' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 20, color: gold, letterSpacing: 2 }}>{card.eyebrow.toUpperCase()}</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`data:image/png;base64,${logo.toString('base64')}`} alt="ZecBlock" width={155} height={36} />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: card.visual ? 56 : 120 }}>
      <span style={{ fontSize: card.headline.length > 14 ? 92 : 120, lineHeight: 1.05, letterSpacing: -2 }}>{card.headline}</span>
      <span style={{ fontSize: 32, color: '#C2C7CF', marginTop: 14 }}>{card.caption}</span>
      <span style={{ fontSize: 20, color: '#9CA4B0', marginTop: 18 }}>{card.detail}</span>
    </div>
    <div style={{ display: 'flex', marginTop: 40 }}><Visual card={card} gold={gold} /></div>
    <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #2C3037', paddingTop: 15, marginTop: 'auto', fontSize: 14, color: '#9CA4B0' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span>Source: {card.source} · {network}</span><span>Rendered {observed}</span></div>
      <span style={{ color: '#F1F3F5', alignSelf: 'flex-end', fontSize: 18 }}>zecblock.com</span>
    </div>
  </div>, {
    ...EXPORT_SIZE,
    fonts: [{ name: 'ZecBlock Export', data: font, weight: 400, style: 'normal' }],
    headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=600', 'X-Robots-Tag': 'noindex' },
  });
}
