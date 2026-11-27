'use strict';

// Weekly public shielding trend: the week plays day by day, ZEC dots streaming
// between the shielded pools and the transparent side at each day's net rate,
// then the still view (direction arrow, day that carried the week) holds.
const { createCanvas } = require('canvas');
const cards = require('./zecblock-cards');
const { encodeGif } = require('./gif-encoder');

const { W, H, C, TONES } = cards;
const FPS = 15, HOLD = 45;

async function renderPoolflowGif(story, output, { ffmpeg = 'ffmpeg' } = {}) {
  const card = story.evidence?.card, v = card?.visual;
  if (v?.kind !== 'poolflow' || !card.hero || !card.line) throw new Error('Story has no pool-flow card');
  cards.ensureFonts();
  const accent = TONES[card.tone] || C.gold;
  const base = createCanvas(W, H), b = base.getContext('2d');
  await cards.drawFrame(b, card.kicker, accent);
  cards.drawText(b, card, accent, 590);
  cards.drawFooter(b, card.source, card.date);
  const particles = cards.poolflowParticles(v), play = cards.poolflowFrames();
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  const draw = frame => {
    ctx.drawImage(base, 0, 0);
    cards.drawPoolflow(ctx, v, accent, frame < play ? frame : null, particles);
    return canvas.toBuffer('raw');
  };
  return encodeGif({ width: W, height: H, inputFps: FPS, count: play + HOLD, frame: draw, output, ffmpeg });
}

module.exports = { renderPoolflowGif };
