// Animated GIF export for cards whose only motion is dashed "particle" paths.
// The card is captured once as a still (particles hidden), then each frame
// redraws only the particle paths with an advanced dash offset. Every path moves
// exactly one dash period per loop, so the GIF loops seamlessly.

import { captureElementPng, withChartAttribution } from './chart-export';
import { buildPalette, encodeGif } from './gif-encoder';

export const GIF_PARTICLES_ATTR = 'data-gif-particles';

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('Frame unavailable'));
  img.src = src;
});

const period = (dash: string | null) => (dash ?? '').split(/[\s,]+/).map(Number).filter(n => Number.isFinite(n) && n > 0).reduce((a, n) => a + n, 0);

/**
 * Capture `card` as a looping GIF. Particle groups are `<g data-gif-particles>`
 * inside an `<svg viewBox>`; their paths need `d`, `stroke` and `stroke-dasharray`.
 */
export async function captureParticleGif(card: HTMLElement, { frames = 36, fps = 18, layoutWidth = 1100, maxWidth = 1100 } = {}): Promise<Blob> {
  // Lay the card out at a fixed desktop width so the export never depends on the
  // visitor's screen (narrow screens scroll the diagram horizontally).
  const previousWidth = card.style.width;
  card.style.width = `${layoutWidth}px`;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    return await render(card, frames, fps, maxWidth);
  } finally {
    card.style.width = previousWidth;
  }
}

async function render(card: HTMLElement, frames: number, fps: number, maxWidth: number): Promise<Blob> {
  const groups = [...card.querySelectorAll<SVGGElement>(`g[${GIF_PARTICLES_ATTR}]`)];
  if (!groups.length) throw new Error('Nothing to animate');

  // 1. Reproduce the export layout in the live page (controls removed, attribution
  //    shown, hover highlight cleared), measure the particle layers there, and
  //    capture the still without particles. Everything is restored afterwards.
  const ignored = [...card.querySelectorAll<HTMLElement>('[data-html2canvas-ignore]')];
  const ignoredDisplay = ignored.map(n => n.style.getPropertyValue('display'));
  ignored.forEach(n => n.style.setProperty('display', 'none'));
  card.classList.add('chart-exporting');
  groups.forEach(g => g.style.setProperty('visibility', 'hidden'));
  let still: Blob;
  let cardRect: DOMRect;
  let svgRects: DOMRect[];
  try {
    ({ still, cardRect, svgRects } = await withChartAttribution(card, async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const measured = { cardRect: card.getBoundingClientRect(), svgRects: groups.map(g => g.ownerSVGElement!.getBoundingClientRect()) };
      return { ...measured, still: await captureElementPng(card) };
    }));
  } finally {
    groups.forEach(g => g.style.removeProperty('visibility'));
    card.classList.remove('chart-exporting');
    ignored.forEach((n, i) => { if (ignoredDisplay[i]) n.style.setProperty('display', ignoredDisplay[i]); else n.style.removeProperty('display'); });
  }
  const base = await loadImage(URL.createObjectURL(still));

  const width = Math.min(maxWidth, Math.round(cardRect.width));
  const scale = width / cardRect.width;
  const height = Math.round(base.naturalHeight * (width / base.naturalWidth));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas unavailable');

  // 2. Particle layers: geometry in each svg's viewBox, placed where the svg sat in the export layout.
  const layers = groups.map((g, i) => {
    const svg = g.ownerSVGElement!;
    const r = svgRects[i];
    const paths = [...g.querySelectorAll('path')].map(p => ({
      d: p.getAttribute('d') ?? '', stroke: p.getAttribute('stroke') ?? '#ffffff', width: p.getAttribute('stroke-width') ?? '2',
      dash: p.getAttribute('stroke-dasharray') ?? '', period: period(p.getAttribute('stroke-dasharray')),
    })).filter(p => p.d && p.period > 0);
    return { viewBox: svg.getAttribute('viewBox') ?? `0 0 ${r.width} ${r.height}`, x: (r.left - cardRect.left) * scale,
      y: (r.top - cardRect.top) * scale, w: r.width * scale, h: r.height * scale, paths };
  });
  const required = [...new Set(layers.flatMap(l => l.paths.map(p => p.stroke)))];

  // 3. Frames.
  const rgba: Uint8ClampedArray[] = [];
  for (let i = 0; i < frames; i++) {
    const t = i / frames;
    ctx.drawImage(base, 0, 0, width, height);
    for (const l of layers) {
      const body = l.paths.map(p => `<path d="${p.d}" fill="none" stroke="${p.stroke}" stroke-width="${p.width}" stroke-linecap="round" stroke-dasharray="${p.dash}" stroke-dashoffset="${(-p.period * t).toFixed(2)}" opacity="0.9"/>`).join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${l.viewBox}" width="${l.w}" height="${l.h}">${body}</svg>`;
      const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      ctx.drawImage(img, l.x, l.y, l.w, l.h);
    }
    rgba.push(ctx.getImageData(0, 0, width, height).data);
  }
  URL.revokeObjectURL(base.src);

  // 4. One palette for all frames keeps colors stable across the loop.
  const palette = buildPalette([rgba[0], rgba[Math.floor(frames / 2)]], required);
  return encodeGif(rgba, width, height, palette, 1000 / fps);
}
