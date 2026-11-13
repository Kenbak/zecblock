import type { CardColor, CardRow, FactCard } from '@/lib/fact-cards';
import { getChartColors } from '@/lib/chart-theme';

/**
 * 1200×675 fact-card template for next/og. One fact per card: a headline, a
 * caption, at most one short line of context and one quiet visual. Satori
 * needs explicit flex on any element with several children, and inline styles
 * only.
 */
const TEXT = '#F1F3F5';
const SECONDARY = '#C2C7CF';
const MUTED_TEXT = '#9CA4B0';
const TRACK = '#1B1E23';
const MUTED_FILL = '#565D68';
const LOGO_DISC = '#E9ECEF';
const CONTENT = 1040;

function palette(): Record<CardColor, string> {
  const c = getChartColors('dark');
  return {
    gold: c.gold, shielded: c.shielded, transparent: c.transparent, ironwood: c.ironwood, orchard: c.orchard, sapling: c.sapling,
    sprout: c.sprout, shielding: c.shielding, deshielding: c.deshielding, purple: c.purple, muted: MUTED_FILL,
  };
}

/** Compared values, never summed. Four rows at most, so each one can be read at a glance. */
function Ranking({ rows, colors, logos }: { rows: CardRow[]; colors: Record<CardColor, string>; logos: Record<string, string> }) {
  const shown = rows.slice(0, 4);
  const max = Math.max(...shown.map(row => row.value), Number.EPSILON);
  const width = 440;
  return <div style={{ display: 'flex', flexDirection: 'column', width, gap: 26 }}>
    {shown.map(row => {
      const logo = row.logo ? logos[row.logo] : undefined;
      return <div key={row.label} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* A light disc keeps dark marks legible on the dark card. */}
            {logo ? <div style={{ display: 'flex', width: 34, height: 34, borderRadius: 17, background: LOGO_DISC, alignItems: 'center', justifyContent: 'center' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logo} alt="" width={26} height={26} style={{ objectFit: 'contain', borderRadius: 13 }} />
            </div> : null}
            <span style={{ color: TEXT }}>{row.label}</span>
          </div>
          <span style={{ color: SECONDARY }}>{row.display}</span>
        </div>
        <div style={{ display: 'flex', height: 6, width, background: TRACK, borderRadius: 3 }}>
          <div style={{ display: 'flex', width: Math.max(6, row.value / max * width), background: colors[row.color ?? 'gold'], borderRadius: 3 }} />
        </div>
      </div>;
    })}
  </div>;
}

function Split({ rows, colors }: { rows: CardRow[]; colors: Record<CardColor, string> }) {
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0) || 1;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 20, width: CONTENT }}>
    <div style={{ display: 'flex', height: 12, borderRadius: 6, background: TRACK, overflow: 'hidden', gap: 3 }}>
      {rows.map(row => <div key={row.label} style={{ display: 'flex', flexGrow: Math.max(0, row.value) / total, flexBasis: 0, background: colors[row.color ?? 'gold'] }} />)}
    </div>
    <div style={{ display: 'flex', columnGap: 36, fontSize: 20 }}>
      {rows.map(row => <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ display: 'flex', width: 10, height: 10, borderRadius: 5, background: colors[row.color ?? 'gold'] }} />
        <span style={{ color: SECONDARY }}>{row.label}</span>
        <span style={{ color: TEXT }}>{row.display}</span>
      </div>)}
    </div>
  </div>;
}

function Visual({ card, colors, logos }: { card: FactCard; colors: Record<CardColor, string>; logos: Record<string, string> }) {
  const visual = card.visual;
  if (!visual) return null;
  if (visual.kind === 'progress' || visual.kind === 'share') {
    const label = visual.kind === 'progress' ? `${visual.from} → ${visual.to}` : visual.label;
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: CONTENT }}>
      <div style={{ display: 'flex', height: 12, borderRadius: 6, background: TRACK, overflow: 'hidden' }}>
        <div style={{ display: 'flex', width: `${visual.percent}%`, background: colors.gold, borderRadius: 6 }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 20, color: MUTED_TEXT }}>
        <span>{label}</span><span style={{ color: TEXT }}>{visual.percent.toFixed(visual.kind === 'progress' ? 2 : 1)}%</span>
      </div>
    </div>;
  }
  if (visual.kind === 'split') return <Split rows={visual.rows} colors={colors} />;
  if (visual.kind === 'ranking') return <Ranking rows={visual.rows} colors={colors} logos={logos} />;
  const max = Math.max(...visual.bars.map(bar => bar.value), Number.EPSILON);
  const slot = CONTENT / Math.max(visual.bars.length, 1);
  return <svg width={CONTENT} height={110} viewBox={`0 0 ${CONTENT} 110`} preserveAspectRatio="none">
    {visual.bars.map((bar, i) => {
      const h = Math.max(2, Math.max(0, bar.value) / max * 110);
      const color = bar.highlight ? colors.gold : '#343941';
      return <rect key={i} x={i * slot + slot * 0.2} y={110 - h} width={slot * 0.6} height={h} rx={3}
        fill={bar.projected ? 'none' : color} stroke={bar.projected ? color : 'none'} strokeDasharray={bar.projected ? '4 3' : undefined} strokeWidth={1.5} />;
    })}
  </svg>;
}

export function FactCardImage({ card, logo, network, observed, logos = {} }: { card: FactCard; logo: string; network: string; observed: string; logos?: Record<string, string> }) {
  const colors = palette();
  // Ranked lists sit beside the text; every other visual runs full width beneath it.
  const side = card.visual?.kind === 'ranking';
  const headlineSize = card.headline.length > 16 ? (side ? 64 : 88) : card.headline.length > 11 ? (side ? 84 : 112) : (side ? 112 : 136);
  const text = <div style={{ display: 'flex', flexDirection: 'column', width: side ? 520 : CONTENT }}>
    <span style={{ fontSize: headlineSize, lineHeight: 1, letterSpacing: -3 }}>{card.headline}</span>
    <span style={{ fontSize: 34, color: TEXT, marginTop: 22, lineHeight: 1.25 }}>{card.caption}</span>
    {card.detail ? <span style={{ fontSize: 21, color: MUTED_TEXT, marginTop: 16, lineHeight: 1.4 }}>{card.detail}</span> : null}
  </div>;
  return <div style={{ width: 1200, height: 675, padding: '48px 80px 40px', background: '#0B0C0E', color: TEXT, display: 'flex', flexDirection: 'column', fontFamily: 'ZecBlock Export' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 18, color: MUTED_TEXT, letterSpacing: 3 }}>{card.eyebrow.toUpperCase()}</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logo} alt="ZecBlock" width={138} height={32} />
    </div>
    {side
      ? <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexGrow: 1 }}>
        {text}
        <Visual card={card} colors={colors} logos={logos} />
      </div>
      : <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', flexGrow: 1 }}>
        {text}
        {card.visual ? <div style={{ display: 'flex', marginTop: 52 }}><Visual card={card} colors={colors} logos={logos} /></div> : null}
      </div>}
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, color: '#6E7682' }}>
      <span>{card.source} · {network} · {observed}</span>
      <span style={{ color: MUTED_TEXT }}>zecblock.com</span>
    </div>
  </div>;
}
