/** Shared local chain identities for swap icons and chart axes. */
const CHAIN_LOGOS: Readonly<Record<string, string>> = {
  eth: '/chains/eth.png',
  sol: '/chains/sol.png',
  btc: '/chains/btc.png',
  near: '/chains/near.png',
  base: '/chains/base.svg',
  arb: '/chains/arb.png',
  op: '/chains/op.png',
  pol: '/chains/pol.png',
  avax: '/chains/avax.png',
  bsc: '/chains/bsc.png',
  bnb: '/chains/bsc.png',
  trx: '/chains/tron.png',
  tron: '/chains/tron.png',
  zec: '/tokens/zec.png',
  apt: '/chains/aptos.png',
  aptos: '/chains/aptos.png',
  sui: '/chains/sui.png',
  ton: '/chains/ton.png',
  doge: '/chains/doge.png',
  xrp: '/chains/xrp.png',
  bch: '/chains/bch.png',
  ltc: '/chains/ltc.png',
  gnosis: '/chains/gnosis.png',
  stellar: '/chains/stellar.png',
  xlm: '/chains/stellar.png',
  starknet: '/chains/starknet.png',
  cardano: '/chains/cardano.png',
  dash: '/chains/dash.svg',
  monad: '/chains/monad.svg',
};

export function getChainLogoSrc(chain: string): string | undefined {
  const key = chain.trim().toLowerCase();
  return Object.hasOwn(CHAIN_LOGOS, key) ? CHAIN_LOGOS[key] : undefined;
}
