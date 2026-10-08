import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getBaseUrl, getNetwork } from '@/lib/seo';

const COPY = {
  mainnet: { headline: ['A clearer view', 'of Zcash.'], descriptor: 'Zcash blockchain explorer', label: null },
  testnet: { headline: ['The Zcash', 'testnet explorer.'], descriptor: 'Blocks, transactions, TAZ', label: 'TESTNET' },
  'crosslink-testnet': { headline: ['The Crosslink', 'testnet explorer.'], descriptor: 'Finality and staking', label: 'CROSSLINK' },
} as const;

const network = getNetwork();
const copy = COPY[network];
const host = new URL(getBaseUrl()).host;

export const alt = `ZecBlock — ${copy.headline.join(' ')} ${copy.descriptor}.`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// The homepage block-grid motif. Satori has no CSS grid or masks, so the
// edge fade is computed per cell from its distance to the gold block.
const CELL = 56;
const STEP = 76;
const GRID_LEFT = 800;
const GRID_TOP = 49;
const COLS = 6;
const ROWS = 7;
const GOLD = { col: 2, row: 3 };

function cellOpacity(col: number, row: number): number {
  const distance = Math.hypot(col - GOLD.col, (row - GOLD.row) * 1.2);
  return Math.max(0.12, 1 - distance / 4.2);
}

export default async function OpenGraphImage() {
  // Next also imports this module for page metadata. Only the image handler
  // should read assets, which are not included in ordinary page-function bundles.
  const [geistData, monoData, logoData] = await Promise.all([
    readFile(join(process.cwd(), 'assets/og/Geist-Medium.ttf')),
    readFile(join(process.cwd(), 'assets/og/GeistMono-Medium.ttf')),
    // Dark share card, so use the white-lettering logotype.
    readFile(join(process.cwd(), 'public/brand/zecblock-logotype.png')),
  ]);

  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', position: 'relative', background: '#0B0C0E', fontFamily: 'Geist' }}>
      {Array.from({ length: ROWS * COLS }, (_, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const isGold = col === GOLD.col && row === GOLD.row;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: GRID_LEFT + col * STEP,
              top: GRID_TOP + row * STEP,
              width: CELL,
              height: CELL,
              ...(isGold
                ? { background: '#F8BC21' }
                : { border: '1.5px solid #484D54', opacity: cellOpacity(col, row) }),
            }}
          />
        );
      })}
      <div style={{ position: 'absolute', left: 80, top: 80, bottom: 76, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {/* Supplied identity is embedded unchanged. */}
          <img src={`data:image/png;base64,${logoData.toString('base64')}`} alt="" width={258} height={60} />
          {copy.label && (
            <span style={{ marginLeft: 24, padding: '4px 12px', border: '1.5px solid #484D54', borderRadius: 4, fontFamily: 'Geist Mono', fontSize: 20, letterSpacing: 2, color: '#9CA4B0' }}>{copy.label}</span>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {copy.headline.map((line) => (
            <div key={line} style={{ fontSize: 92, lineHeight: 1.04, letterSpacing: -3.5, color: '#F1F3F5' }}>{line}</div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 40, fontFamily: 'Geist Mono', fontSize: network === 'mainnet' ? 26 : 22, color: '#9CA4B0' }}>
            <span>{copy.descriptor}</span>
            <span style={{ margin: '0 16px', color: '#484D54' }}>·</span>
            <span style={{ color: '#F1F3F5' }}>{host}</span>
          </div>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: 'Geist', data: geistData, weight: 500, style: 'normal' },
        { name: 'Geist Mono', data: monoData, weight: 500, style: 'normal' },
      ],
    },
  );
}
