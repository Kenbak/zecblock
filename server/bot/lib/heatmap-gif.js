'use strict';

// Weekly shielding heatmap: seven UTC days by 24 hours. The week plays back
// hour by hour, each cell lighting up as its shielding arrives, and the
// busiest hour is ringed at the end. Shade is the square root of the hour's
// ZEC relative to the 95th-percentile hour (capped at full): one very large
// transaction would otherwise turn every other hour almost black.
const { createCanvas, loadImage } = require('canvas');
const cards = require('./zecblock-cards');
const { encodeGif } = require('./gif-encoder');

const { W, H, PAD, C } = cards;
const FPS = 15, PLAY = 84, RING = 10, HOLD = 42;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const GX = PAD + 64, GY = 296, GW = W - PAD - GX, ROW = 28, GAP = 4;
const CELL_W = (GW - 23 * GAP) / 24;
const EMPTY = '#15171B';

/** Cell shades 0..1 from exact zatoshi strings; 0 means no shielding that hour. Pure, for tests. */
function shades(cells) {
  if (!Array.isArray(cells) || cells.length !== 168 || !cells.every(zat => /^\d+$/.test(String(zat)))) throw new Error('Heatmap needs 168 hourly cells');
  const values = cells.map(zat => Number(zat) / 1e8);
  const nonzero = values.filter(v => v > 0).sort((a, b) => a - b);
  if (!nonzero.length) throw new Error('Heatmap has no shielding');
  const scale = nonzero[Math.min(nonzero.length - 1, Math.floor(0.95 * nonzero.length))];
  return values.map(v => (v > 0 ? Math.max(0.12, Math.min(1, Math.sqrt(v / scale))) : 0));
}

function cellRect(slot) {
  const day = Math.floor(slot / 24), hour = slot % 24;
  return { x: GX + hour * (CELL_W + GAP), y: GY + day * (ROW + GAP), w: CELL_W, h: ROW };
}

async function renderHeatmapGif(story, output, { ffmpeg = 'ffmpeg' } = {}) {
  const card = story.evidence?.card, v = card?.visual;
  if (v?.kind !== 'heatmap' || !card.hero || !card.line) throw new Error('Story has no heatmap card');
  const level = shades(v.cells);
  if (!Number.isInteger(v.busiest) || v.busiest < 0 || v.busiest > 167) throw new Error('Heatmap has no busiest hour');
  cards.ensureFonts();
  const base = createCanvas(W, H), b = base.getContext('2d');
  b.fillStyle = C.bg; b.fillRect(0, 0, W, H);
  b.font = 'normal 20px GeistMono'; b.fillStyle = C.gold; b.fillText('>', PAD, 96);
  b.fillStyle = C.muted; b.fillText(card.kicker.toUpperCase(), PAD + 26, 96);
  const logo = await loadImage(cards.LOGO);
  const lh = 30, lw = logo.width * lh / logo.height; b.drawImage(logo, W - PAD - lw, 73, lw, lh);
  b.font = '500 96px Geist'; b.fillStyle = C.gold; b.fillText(card.hero, PAD - 4, 200);
  const heroW = b.measureText(card.hero).width;
  b.font = '500 33px Geist'; b.fillStyle = C.muted; b.fillText(card.unit || '', PAD - 4 + heroW + 16, 200);
  b.font = '500 32px Geist'; b.fillStyle = C.text;
  if (b.measureText(card.line).width > W - 2 * PAD) throw new Error('Card line exceeds safe bounds');
  b.fillText(card.line, PAD, 252);
  b.font = 'normal 17px GeistMono'; b.fillStyle = C.faint;
  DAYS.forEach((day, i) => b.fillText(day, PAD, GY + i * (ROW + GAP) + 20));
  for (const hour of [0, 6, 12, 18]) b.fillText(`${String(hour).padStart(2, '0')}:00`, cellRect(hour).x, GY + 7 * (ROW + GAP) + 18);
  for (let slot = 0; slot < 168; slot++) { const r = cellRect(slot); b.fillStyle = EMPTY; b.fillRect(r.x, r.y, r.w, r.h); }
  cards.drawFooter(b, card.source, card.date);

  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  const draw = frame => {
    ctx.drawImage(base, 0, 0);
    const reached = Math.min(168, Math.round((frame / PLAY) * 168));
    for (let slot = 0; slot < reached; slot++) {
      if (!level[slot]) continue;
      const r = cellRect(slot);
      // The newest cells flash brighter for a moment as the week plays.
      const fresh = Math.max(0, 1 - (reached - slot) / 6);
      ctx.globalAlpha = Math.min(1, level[slot] + 0.5 * fresh);
      ctx.fillStyle = C.gold; ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.globalAlpha = 1;
    if (frame >= PLAY) {
      const r = cellRect(v.busiest), t = Math.min(1, (frame - PLAY) / RING);
      ctx.strokeStyle = C.text; ctx.lineWidth = 2;
      const grow = 10 * (1 - t);
      ctx.strokeRect(r.x - 3 - grow, r.y - 3 - grow, r.w + 6 + 2 * grow, r.h + 6 + 2 * grow);
    }
    return canvas.toBuffer('raw');
  };
  return encodeGif({ width: W, height: H, inputFps: FPS, count: PLAY + RING + HOLD, frame: draw, output, ffmpeg });
}

module.exports = { renderHeatmapGif, shades, cellRect };
