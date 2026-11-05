import { loadFactCard } from '@/lib/fact-cards-server';
import { factCardResponse } from '@/lib/fact-card-response';
import { NU7_CARDS, type Nu7CardId } from '@/lib/nu7-cards';
import { getNetwork } from '@/lib/seo';

export const runtime = 'nodejs';

/** NU7 share cards, drawn by the shared /cards template. */
export async function GET(_request: Request, { params }: { params: Promise<{ card: string }> }) {
  const { card: id } = await params;
  const network = getNetwork();
  if (network === 'crosslink-testnet' || !NU7_CARDS.includes(id as Nu7CardId)) return new Response('Not found', { status: 404 });
  return factCardResponse(await loadFactCard(`nu7-${id}`, network), network);
}
