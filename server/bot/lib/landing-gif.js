'use strict';

// "Where it lands": a large swap or shield/deshield shown against every
// comparable event in its ranking window. The window fills in as a size
// histogram, then the new event drops in as a pin at its exact size: smaller
// events dim, larger ones take the event's colour, and the rank appears.
//
// The histogram is read from the same rows the story was ranked against, and
// its total must equal the story's sample count, so the picture and the
// "Top x%" claim cannot disagree. Any failure falls back to the still card.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const cards = require('./zecblock-cards');
const f = require('./editorial-format');
const { encodeGif } = require('./gif-encoder');

const { W, H, PAD, C } = cards;
const FPS = 15;
const GROW = 40, DROP = 14, HOLD = 48;
const BINS_PER_DECADE = 8;
const MAX_DECADES = 8;
const DIM = '#2A2E35', BAR = '#4A5059';
// Chart band: room for the headline above and the footer below.
const X0 = PAD, X1 = W - PAD, BASE = 522, TOP = 388, PIN = BASE - 112;

/** 'swap', 'flow', 'exchange' or null: which stories get a landing GIF. */
function landingKind(story) {
  if (story?.type === 'swap') return 'swap';
  if (story?.type === 'exchange_flow') return 'exchange';
  if (story?.type === 'flow_shield' || story?.type === 'flow_deshield') return 'flow';
  return null;
}

/** The exact ranking sample, as counts per log bin (8 per decade). */
async function loadDistribution(db, story, sql = require('./editorial-data')) {
  const e = story.evidence, kind = landingKind(story);
  let rows;
  // Exchange flows are ranked in memory; the story carries that exact histogram.
  if (kind === 'exchange') rows = e.distribution?.bins || [];
  else if (kind === 'swap') {
    const venue = e.venue || 'near';
    const at = new Date(e.swap_created_at).toISOString();
    const base = venue === 'near' ? `${sql.VALID_SWAPS}` : `${sql.VALID_VENUE_SWAPS}`;
    const params = venue === 'near' ? [at] : [at, venue];
    ({ rows } = await db.query(`SELECT floor(log(source_amount_usd)*${BINS_PER_DECADE})::int AS bin, count(*)::int AS n
      FROM (${base} AND swap_created_at < $1::timestamptz AND swap_created_at >= $1::timestamptz - interval '30 days') h
      GROUP BY 1 ORDER BY 1`, params));
  } else if (kind === 'flow') {
    const at = Number(e.block_time);
    if (!Number.isSafeInteger(at)) throw new Error('Flow has no block time');
    ({ rows } = await db.query(`SELECT floor(log(amount_zat::numeric/1e8)*${BINS_PER_DECADE})::int AS bin, count(*)::int AS n
      FROM (${sql.VALID_FLOWS} AND sf.flow_type=$1 AND sf.block_time < $2 AND sf.block_time >= $2 - 90*86400) h
      GROUP BY 1 ORDER BY 1`, [e.flow_type, at]));
  } else throw new Error('No landing GIF for this story type');
  const bins = rows.map(row => ({ bin: Number(row.bin), n: Number(row.n) }));
  const total = bins.reduce((sum, row) => sum + row.n, 0);
  if (!bins.every(row => Number.isInteger(row.bin) && Number.isInteger(row.n) && row.n > 0)) throw new Error('Invalid distribution rows');
  if (total !== Number(e.sample_count)) throw new Error(`Distribution has ${total} rows, story ranked against ${e.sample_count}`);
  return { bins, total };
}

/** Everything the frames need, from the story and its distribution. Pure, so it is testable without canvas. */
function landingModel(story, distribution) {
  const e = story.evidence, card = e.card, kind = landingKind(story);
  if (!card?.hero || !card.line || !card.kicker) throw new Error('Story has no card');
  const value = kind === 'swap' ? Number(e.source_amount_usd) : Number(e.amount_zat) / 1e8;
  const entity = kind === 'exchange' ? require('./exchange-flows').ENTITIES[e.entity] : null;
  if (kind === 'exchange' && !entity) throw new Error('Unknown exchange entity');
  if (!(value > 0)) throw new Error('Story has no size');
  const greater = Number(e.greater_count), equal = Number(e.equal_count), n = distribution.total;
  const valueBin = Math.floor(Math.log10(value) * BINS_PER_DECADE);
  const bins = distribution.bins.map(row => row.bin);
  const hi = Math.ceil((Math.max(valueBin, ...bins) + 1) / BINS_PER_DECADE);
  const lo = Math.max(Math.floor(Math.min(valueBin, ...bins) / BINS_PER_DECADE), hi - MAX_DECADES);
  const count = (hi - lo) * BINS_PER_DECADE;
  // Anything below the axis start joins the first bar rather than disappearing.
  const counts = Array(count).fill(0);
  for (const row of distribution.bins) counts[Math.max(0, row.bin - lo * BINS_PER_DECADE)] += row.n;
  const window = kind === 'flow' ? 90 : 30;
  const largest = greater === 0 && equal === 0;
  const what = kind === 'swap' ? `${f.VENUES[e.venue || 'near']} ZEC swaps`
    : kind === 'exchange' ? `exchange & custody ${e.direction}s`
      : `${e.flow_type === 'shield' ? 'shielding' : 'deshielding'} transactions`;
  return {
    kind, card, value, lo, hi, counts, total: n,
    counter: `${what} · last ${window} days`,
    label: largest ? `Largest in ${window} days` : `Top ${f.tailText(e.tailPct)}%`,
    sub: largest ? null : equal > 0 ? `${cards.fmt(greater + equal)} were as big or bigger` : `${cards.fmt(greater)} were bigger`,
    ticks: Array.from({ length: Math.floor((hi - lo) / 2) + 1 }, (_, i) => lo + 2 * i).filter(d => d < hi)
      .map(d => ({ decade: d, label: tickLabel(kind, d) })),
    route: kind === 'swap' ? { from: card.visual?.from, to: card.visual?.to } : null,
    logo: entity ? require('path').join(cards.ENTITY_LOGOS, entity.logo) : null,
  };
}

function tickLabel(kind, decade) {
  const v = 10 ** decade;
  const text = v >= 1e6 ? `${v / 1e6}M` : v >= 1e3 ? `${v / 1e3}K` : String(Number(v.toPrecision(1)));
  return kind === 'swap' ? `$${text}` : `${text} ZEC`;
}

const ease = t => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

async function renderLandingGif(story, distribution, output, { ffmpeg = 'ffmpeg' } = {}) {
  const m = landingModel(story, distribution);
  cards.ensureFonts();
  const accent = cards.TONES[m.card.tone] || C.gold;
  // Static parts are drawn once; each frame copies them and adds the chart.
  const base = createCanvas(W, H), b = base.getContext('2d');
  b.fillStyle = C.bg; b.fillRect(0, 0, W, H);
  b.font = 'normal 20px GeistMono'; b.fillStyle = accent; b.fillText('>', PAD, 96);
  b.fillStyle = C.muted; b.fillText(m.card.kicker.toUpperCase(), PAD + 26, 96);
  const logo = await loadImage(cards.LOGO);
  const lh = 30, lw = logo.width * lh / logo.height; b.drawImage(logo, W - PAD - lw, 73, lw, lh);
  const heroWidth = m.route ? 640 : m.logo ? 820 : W - 2 * PAD;
  let size = 100;
  const unitGap = m.card.unit ? 16 : 0;
  for (; size >= 64; size -= 4) {
    b.font = `500 ${size}px Geist`; const w = b.measureText(m.card.hero).width;
    b.font = `500 ${Math.round(size * 0.34)}px Geist`;
    if (w + (m.card.unit ? unitGap + b.measureText(m.card.unit).width : 0) <= heroWidth) break;
  }
  if (size < 64) throw new Error('Card headline exceeds safe bounds');
  b.font = `500 ${size}px Geist`; b.fillStyle = accent; b.fillText(m.card.hero, PAD - 4, 212);
  if (m.card.unit) {
    const x = PAD - 4 + b.measureText(m.card.hero).width + unitGap;
    b.font = `500 ${Math.round(size * 0.34)}px Geist`; b.fillStyle = C.muted; b.fillText(m.card.unit, x, 212);
  }
  b.font = '500 32px Geist'; b.fillStyle = C.text;
  if (b.measureText(m.card.line).width > W - 2 * PAD) throw new Error('Card line exceeds safe bounds');
  b.fillText(m.card.line, PAD, 264);
  if (m.route?.from && m.route?.to) {
    const y = 160, x1 = W - PAD - 220, x2 = W - PAD - 40;
    await cards.chainNode(b, m.route.from, x1, y, m.route.from === 'zec' ? C.gold : C.border);
    await cards.chainNode(b, m.route.to, x2, y, m.route.to === 'zec' ? C.gold : C.border);
    b.fillStyle = C.muted; for (let x = x1 + 52; x < x2 - 62; x += 16) b.fillRect(x, y - 2, 6, 4);
    b.beginPath(); b.moveTo(x2 - 56, y - 8); b.lineTo(x2 - 56, y + 8); b.lineTo(x2 - 46, y); b.fill();
  }
  if (m.logo) await cards.entityNode(b, m.logo, W - PAD - 50, 200, accent, 44);
  b.fillStyle = C.grid; b.fillRect(X0, BASE, X1 - X0, 1);
  b.font = 'normal 17px GeistMono'; b.fillStyle = C.faint;
  const xOf = v => X0 + (Math.log10(v) - m.lo) / (m.hi - m.lo) * (X1 - X0);
  for (const tick of m.ticks) {
    const x = xOf(10 ** tick.decade), w = b.measureText(tick.label).width;
    b.fillText(tick.label, Math.min(X1 - w, Math.max(X0, x - w / 2)), BASE + 30);
  }
  cards.drawFooter(b, m.card.source, m.card.date);

  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  const markerX = xOf(m.value), bw = (X1 - X0) / m.counts.length, max = Math.max(...m.counts);
  const draw = frame => {
    ctx.drawImage(base, 0, 0);
    const grow = ease(frame / GROW), drop = ease((frame - GROW) / DROP), dropped = frame >= GROW;
    m.counts.forEach((n, i) => {
      if (!n) return;
      const local = ease(grow * 1.6 - (i / m.counts.length) * 0.6);
      const h = Math.max(3, (n / max) * (BASE - TOP)) * local;
      const l = X0 + i * bw + 1.5, r = X0 + (i + 1) * bw - 1.5, split = Math.min(r, Math.max(l, markerX));
      ctx.fillStyle = dropped && drop > 0.5 ? DIM : BAR;
      ctx.fillRect(l, BASE - h, split - l, h);
      if (r > split) {
        ctx.fillStyle = dropped ? accent : BAR;
        if (dropped) ctx.globalAlpha = 0.35 + 0.65 * drop;
        ctx.fillRect(split, BASE - h, r - split, h);
        ctx.globalAlpha = 1;
      }
    });
    ctx.font = 'normal 19px GeistMono'; ctx.fillStyle = C.muted;
    ctx.fillText(`${cards.fmt(Math.round(m.total * grow))} ${m.counter}`, PAD, 330);
    if (dropped) {
      const y = PIN - (1 - drop) * 110;
      ctx.strokeStyle = accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(markerX, y); ctx.lineTo(markerX, BASE); ctx.stroke();
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(markerX, y, 8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(markerX, BASE, 4, 0, Math.PI * 2); ctx.fill();
    }
    if (frame >= GROW + DROP) {
      ctx.globalAlpha = ease((frame - GROW - DROP) / 8);
      ctx.font = '500 32px Geist';
      const labelW = Math.max(ctx.measureText(m.label).width, m.sub ? (ctx.font = 'normal 18px GeistMono', ctx.measureText(m.sub).width) : 0);
      // Label to the right of the pin, or to its left near the right edge.
      const left = markerX + 20 + labelW > X1 ? markerX - 20 - labelW : markerX + 20;
      ctx.font = '500 32px Geist'; ctx.fillStyle = C.text; ctx.fillText(m.label, left, PIN + 11);
      if (m.sub) { ctx.font = 'normal 18px GeistMono'; ctx.fillStyle = C.muted; ctx.fillText(m.sub, left, PIN + 42); }
      ctx.globalAlpha = 1;
    }
    return canvas.toBuffer('raw');
  };
  return encodeGif({ width: W, height: H, inputFps: FPS, count: GROW + DROP + HOLD, frame: draw, output, ffmpeg });
}

/**
 * The editorial `render` hook: a landing GIF for swaps and flows, the
 * heatmap GIF for the weekly heatmap, the net-flow GIF for the weekly exchange
 * recap (still card if it fails), and the still card for everything else
 * and whenever a GIF cannot be made. A heatmap has no still card; without its
 * GIF the post goes out as text.
 */
function storyMedia({ reader, still = cards.renderEditorial, logger = console, load = loadDistribution, gif = renderLandingGif,
  heatmap = require('./heatmap-gif').renderHeatmapGif, netflow = require('./netflow-gif').renderNetflowGif,
  poolflow = require('./poolflow-gif').renderPoolflowGif } = {}) {
  return async story => {
    const isHeatmap = story?.evidence?.card?.visual?.kind === 'heatmap';
    const isNetflow = story?.evidence?.card?.visual?.kind === 'netflow';
    const isPoolflow = story?.evidence?.card?.visual?.kind === 'poolflow';
    const kind = landingKind(story);
    if ((kind && (reader || kind === 'exchange')) || isHeatmap || isNetflow || isPoolflow) {
      const file = path.join(os.tmpdir(), `zecblock-${isHeatmap ? 'heatmap' : isNetflow ? 'netflow' : isPoolflow ? 'poolflow' : 'landing'}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.gif`);
      try {
        if (isHeatmap) await heatmap(story, file);
        else if (isNetflow) await netflow(story, file);
        else if (isPoolflow) await poolflow(story, file);
        else await gif(story, await load(reader, story), file);
        return file;
      } catch (error) {
        try { fs.unlinkSync(file); } catch { /* not written */ }
        logger.warn(`[Editorial] GIF unavailable for ${story.key}${isHeatmap ? '' : ', using still card'}: ${error.message}`);
        if (isHeatmap) throw error;
      }
    }
    return still(story);
  };
}

module.exports = { landingKind, loadDistribution, landingModel, renderLandingGif, storyMedia, BINS_PER_DECADE };
