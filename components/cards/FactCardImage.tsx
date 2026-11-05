import type { CardColor, CardRow, FactCard } from '@/lib/fact-cards';
import { getChartColors } from '@/lib/chart-theme';

/**
 * 1200×675 fact-card template for next/og. Satori needs explicit flex on any
 * element with several children, and inline styles only.
 */
const TEXT = '#F1F3F5';
const SECONDARY = '#C2C7CF';
const MUTED_TEXT = '#9CA4B0';
const TRACK = '#20242A';
const MUTED_FILL = '#565D68';

function palette(): Record<CardColor, string> {
  const c = getChartColors('dark');
  return {
    gold: c.gold, shielded: c.shielded, transparent: c.transparent, ironwood: c.ironwood, orchard: c.orchard, sapling: c.sapling,
    sprout: c.sprout, shielding: c.shielding, deshielding: c.deshielding, purple: c.purple, muted: MUTED_FILL,
  };
}

function Ranking({ rows, colors, width }: { rows: CardRow[]; colors: Record<CardColor, string>; width: number }) {
  const max = Math.max(...rows.map(row => row.value), Number.EPSILON);
  const labelWidth = Math.round(width * 0.36);
  const barWidth = width - labelWidth - 16;
  return <div style={{ display: 'flex', flexDirection: 'column', width, gap: 14 }}>
    {rows.map(row => <div key={row.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 19 }}>
        <span style={{ color: TEXT, width: labelWidth, overflow: 'hidden', whiteSpace: 'nowrap' }}>{row.label}</span>
        <span style={{ color: SECONDARY }}>{row.display}</span>
      </div>
      <div style={{ display: 'flex', height: 10, width: barWidth + labelWidth + 16, background: TRACK, borderRadius: 5 }}>
        <div style={{ display: 'flex', width: Math.max(4, row.value / max * (barWidth + labelWidth + 16)), background: colors[row.color ?? 'gold'], borderRadius: 5 }} />
      </div>
    </div>)}
  </div>;
}

function Split({ rows, colors }: { rows: CardRow[]; colors: Record<CardColor, string> }) {
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0) || 1;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: 1000 }}>
    <div style={{ display: 'flex', height: 16, borderRadius: 8, background: TRACK, overflow: 'hidden' }}>
      {rows.map(row => <div key={row.label} style={{ display: 'flex', width: `${Math.max(0, row.value) / total * 100}%`, background: colors[row.color ?? 'gold'] }} />)}
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 28, rowGap: 8, fontSize: 18 }}>
      {rows.map(row => <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'flex', width: 11, height: 11, borderRadius: 2, background: colors[row.color ?? 'gold'] }} />
        <span style={{ color: TEXT }}>{row.label}</span>
        <span style={{ color: MUTED_TEXT }}>{row.display}</span>
      </div>)}
    </div>
  </div>;
}

function Visual({ card, colors }: { card: FactCard; colors: Record<CardColor, string> }) {
  const visual = card.visual;
  if (!visual) return null;
  if (visual.kind === 'progress' || visual.kind === 'share') {
    const label = visual.kind === 'progress' ? `${visual.from} → ${visual.to}` : visual.label;
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 1000 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, color: MUTED_TEXT }}>
        <span>{label}</span><span>{visual.percent.toFixed(visual.kind === 'progress' ? 2 : 1)}%</span>
      </div>
      <div style={{ display: 'flex', height: 14, borderRadius: 7, background: TRACK, overflow: 'hidden' }}>
        <div style={{ display: 'flex', width: `${visual.percent}%`, background: colors.gold, borderRadius: 7 }} />
      </div>
    </div>;
  }
  if (visual.kind === 'split') return <Split rows={visual.rows} colors={colors} />;
  if (visual.kind === 'ranking') return <Ranking rows={visual.rows} colors={colors} width={440} />;
  const max = Math.max(...visual.bars.map(bar => bar.value), Number.EPSILON);
  const slot = 1000 / Math.max(visual.bars.length, 1);
  return <svg width={1000} height={130} viewBox="0 0 1000 150" preserveAspectRatio="none">
    {visual.bars.map((bar, i) => {
      const h = Math.max(0, bar.value) / max * 140;
      const color = bar.highlight ? colors.gold : MUTED_FILL;
      return <rect key={i} x={i * slot + slot * 0.15} y={150 - h} width={slot * 0.7} height={h}
        fill={bar.projected ? 'none' : color} stroke={bar.projected ? color : 'none'} strokeDasharray={bar.projected ? '4 3' : undefined} strokeWidth={1.5} />;
    })}
  </svg>;
}

export function FactCardImage({ card, logo, network, observed }: { card: FactCard; logo: string; network: string; observed: string }) {
  const colors = palette();
  // Ranked lists sit beside the text; every other visual runs full width beneath it.
  const side = card.visual?.kind === 'ranking';
  const headlineSize = card.headline.length > 16 ? (side ? 64 : 84) : card.headline.length > 11 ? (side ? 80 : 104) : 120;
  const text = <div style={{ display: 'flex', flexDirection: 'column', width: side ? 520 : 1000 }}>
    <span style={{ fontSize: headlineSize, lineHeight: 1.05, letterSpacing: -2 }}>{card.headline}</span>
    <span style={{ fontSize: 32, color: SECONDARY, marginTop: 14 }}>{card.caption}</span>
    <span style={{ fontSize: 20, color: MUTED_TEXT, marginTop: 18, lineHeight: 1.4 }}>{card.detail}</span>
  </div>;
  return <div style={{ width: 1200, height: 675, padding: '44px 100px', background: '#0B0C0E', color: TEXT, display: 'flex', flexDirection: 'column', fontFamily: 'ZecBlock Export' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 20, color: colors.gold, letterSpacing: 2 }}>{card.eyebrow.toUpperCase()}</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logo} alt="ZecBlock" width={155} height={36} />
    </div>
    {side
      ? <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 48, flexGrow: 1, paddingBottom: 24 }}>
        {text}
        <Visual card={card} colors={colors} />
      </div>
      : <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', marginTop: card.visual ? 56 : 120 }}>{text}</div>
        <div style={{ display: 'flex', marginTop: 40 }}><Visual card={card} colors={colors} /></div>
      </div>}
    <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #2C3037', paddingTop: 15, marginTop: 'auto', fontSize: 14, color: MUTED_TEXT }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span>Source: {card.source} · {network}</span><span>Rendered {observed}</span></div>
      <span style={{ color: TEXT, alignSelf: 'flex-end', fontSize: 18 }}>zecblock.com</span>
    </div>
  </div>;
}
