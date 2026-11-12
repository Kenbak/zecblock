import { findFactCard } from '@/lib/fact-cards';
import { loadFactCard } from '@/lib/fact-cards-server';
import { factCardResponse } from '@/lib/fact-card-response';
import { getNetwork } from '@/lib/seo';

export const runtime = 'nodejs';

/** Live 1200×675 PNG for one fact card; embeddable as a plain <img>. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const network = getNetwork();
  const def = findFactCard(id);
  if (network === 'crosslink-testnet' || !def || !(def.networks as readonly string[]).includes(network)) {
    return new Response('Card not found', { status: 404, headers: { 'X-Robots-Tag': 'noindex' } });
  }
  return factCardResponse(await loadFactCard(id, network), network);
}
