'use client';

import { getChainLogoSrc } from '@/lib/chain-logos';

// Token icons from /public/tokens/ (sourced from zipher-app)
function getTokenIcon(symbol: string): string | null {
  const key = symbol.toLowerCase();
  const map: Record<string, string> = {
    usdc: '/tokens/usdc.png',
    usdt: '/tokens/usdt.png',
    btc: '/tokens/btc.png',
    eth: '/tokens/eth.png',
    sol: '/tokens/sol.png',
    zec: '/tokens/zec.png',
    near: '/tokens/near.png',
    bnb: '/tokens/bnb.png',
    doge: '/tokens/doge.png',
    xrp: '/tokens/xrp.png',
    matic: '/tokens/matic.png',
    pol: '/tokens/pol.png',
    avax: '/tokens/avax.png',
    trx: '/tokens/trx.png',
    dai: '/tokens/dai.png',
    link: '/tokens/link.png',
    uni: '/tokens/uni.png',
    arb: '/tokens/arb.png',
    op: '/tokens/op.png',
    apt: '/tokens/apt.png',
    sui: '/tokens/sui.png',
    ton: '/tokens/ton.png',
    ada: '/tokens/ada.png',
    shib: '/tokens/shib.png',
    pepe: '/tokens/pepe.png',
    wbtc: '/tokens/wbtc.png',
    weth: '/tokens/weth.png',
    xmr: '/tokens/xmr.png',
    cbzec: '/tokens/cbzec.png',
    cbbtc: '/tokens/cbbtc.png',
    mon: '/chains/monad.svg',
  };
  return map[key] || null;
}

// Skip the chain badge when the token IS the chain's native asset
const NATIVE_PAIRS: Record<string, string> = {
  eth: 'eth',
  sol: 'sol',
  btc: 'btc',
  near: 'near',
  bnb: 'bnb',
  bsc: 'bnb',
  avax: 'avax',
  doge: 'doge',
  xrp: 'xrp',
  trx: 'trx',
  zec: 'zec',
  ton: 'ton',
  apt: 'apt',
  sui: 'sui',
  ltc: 'ltc',
  ada: 'ada',
  monad: 'mon',
  dash: 'dash',
};

interface TokenChainIconProps {
  token: string;
  chain: string;
  size?: number;
  className?: string;
}

export function TokenChainIcon({ token, chain, size = 32, className = '' }: TokenChainIconProps) {
  const tokenKey = token.toLowerCase();
  const chainKey = chain.toLowerCase();
  const badgeSize = size <= 18 ? Math.max(Math.round(size * 0.38), 6) : Math.max(Math.round(size * 0.5), 10);
  const isNative = NATIVE_PAIRS[chainKey] === tokenKey;
  const showBadge = !isNative && chainKey !== tokenKey;

  const tokenUrl = getTokenIcon(tokenKey) || getChainLogoSrc(tokenKey);
  const chainUrl = getChainLogoSrc(chainKey);

  return (
    <div className={`relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }}>
      {tokenUrl ? (
        <img
          src={tokenUrl}
          alt={token}
          width={size}
          height={size}
          className="rounded-full"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <div
          className="rounded-full flex items-center justify-center text-white font-semibold bg-muted"
          style={{ width: size, height: size, fontSize: Math.max(12, size * 0.4) }}
        >
          {token.charAt(0).toUpperCase()}
        </div>
      )}

      {showBadge && chainUrl && (
        <div
          className="absolute -bottom-0.5 -right-0.5 rounded-full bg-cipher-surface-solid p-[2px]"
          style={{ width: badgeSize + 4, height: badgeSize + 4 }}
        >
          <img
            src={chainUrl}
            alt={chain}
            width={badgeSize}
            height={badgeSize}
            className="rounded-full w-full h-full"
            onError={(e) => {
              (e.target as HTMLImageElement).parentElement!.style.display = 'none';
            }}
          />
        </div>
      )}
    </div>
  );
}
