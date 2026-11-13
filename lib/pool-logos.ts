/**
 * Local brand marks for mining-pool labels on share cards. Mirrors the map in
 * components/PoolLogo.tsx, which is a client component the image route cannot
 * import; fact-cards.test.js fails if the two drift apart.
 */
const POOL_LOGOS: Readonly<Record<string, string>> = {
  '2miners': '/brands/mining/2miners.png',
  '2minerssolo': '/brands/mining/2miners.png',
  antpool: '/brands/mining/antpool.png',
  f2pool: '/brands/mining/f2pool.svg',
  foundry: '/brands/mining/foundry.png',
  foundryusa: '/brands/mining/foundry.png',
  foundryusapool: '/brands/mining/foundry.png',
  luxor: '/brands/mining/luxor.svg',
  kupool: '/brands/mining/kupool.png',
  sluiceypool: '/brands/mining/sluicey.svg',
  viabtc: '/brands/mining/viabtc.png',
  viabtcsolo: '/brands/mining/viabtc.png',
};

export function getPoolLogoSrc(name: string): string | undefined {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return Object.hasOwn(POOL_LOGOS, key) ? POOL_LOGOS[key] : undefined;
}
