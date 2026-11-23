'use strict';

// Weekly exchange net flows: each entity's bar grows from the centre axis
// (right = net in, left = net out), then the signed values appear and hold.
const { createCanvas } = require('canvas');
const cards = require('./zecblock-cards');
const { encodeGif } = require('./gif-encoder');

const { W, H, C, TONES } = cards;
const FPS = 15, GROW = 36, HOLD = 60;
const ease = t => 1 - (1 - t) ** 3;

async function renderNetflowGif(story, output, { ffmpeg = 'ffmpeg' } = {}) {
  const card = story.evidence?.card, v = card?.visual;
  if (v?.kind !== 'netflow' || !card.hero || !card.line) throw new Error('Story has no net-flow card');
  cards.ensureFonts();
  const logos = await cards.netflowLogos(v);
  const accent = TONES[card.tone] || C.gold;
  const base = createCanvas(W, H), b = base.getContext('2d');
  await cards.drawFrame(b, card.kicker, accent);
  cards.drawCompactHeading(b, card, accent);
  cards.drawFooter(b, card.source, card.date);
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  const draw = frame => {
    ctx.drawImage(base, 0, 0);
    cards.drawNetflowRows(ctx, v, logos, frame >= GROW ? 1 : ease(frame / GROW));
    return canvas.toBuffer('raw');
  };
  return encodeGif({ width: W, height: H, inputFps: FPS, count: GROW + HOLD, frame: draw, output, ffmpeg });
}

module.exports = { renderNetflowGif };
