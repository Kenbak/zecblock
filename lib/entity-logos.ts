/**
 * Explicit aliases of names already supplied by the address-label API.
 * A matching mark identifies the label; it is not evidence of address ownership.
 */
const ENTITY_LOGOS: Readonly<Record<string, string>> = {
  gemini: '/brands/entities/gemini.png',
  'gemini cold wallet': '/brands/entities/gemini.png',
  'gemini custody': '/brands/entities/gemini.png',
  binance: '/brands/entities/binance.png',
  'binance cold wallet': '/brands/entities/binance.png',
  'binance hot wallet': '/brands/entities/binance.png',
  kraken: '/brands/entities/kraken.png',
  'kraken cold wallet': '/brands/entities/kraken.png',
  'kraken deposit': '/brands/entities/kraken.png',
  'kraken hot wallet': '/brands/entities/kraken.png',
  coinbase: '/brands/entities/coinbase.png',
  'coinbase cold wallet': '/brands/entities/coinbase.png',
  'coinbase prime custody': '/brands/entities/coinbase.png',
  'grayscale zcash trust': '/brands/entities/grayscale.png',
  'hyperunit hot wallet': '/brands/entities/hyperunit.png',
  'kucoin cold wallet': '/brands/entities/kucoin.png',
  'near intent bridge': '/brands/entities/near-intents.png',
};

export function getEntityLogoSrc(label: string, logoUrl?: string | null): string | undefined {
  const key = label.trim().toLowerCase();
  const localLogo = Object.hasOwn(ENTITY_LOGOS, key) ? ENTITY_LOGOS[key] : undefined;
  if (localLogo) return localLogo;

  // Allow future API-provided marks already stored in our local brand directory.
  // Never invent an entity from part of its name or hotlink an arbitrary remote URL.
  return logoUrl && /^\/brands\/[a-zA-Z0-9/_-]+\.(?:png|svg|webp|jpe?g)$/.test(logoUrl)
    ? logoUrl
    : undefined;
}
