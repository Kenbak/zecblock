/** html-to-image copies computed styles, so attribution must be visible while it clones.
 * Restore styles even if capture fails; never mutate chart data or recreate canvases.
 */
export async function withChartAttribution<T>(root: HTMLElement, capture: () => Promise<T>): Promise<T> {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('.chart-signature, .chart-export-attribution'));
  const previous = nodes.map(node => ({ value: node.style.getPropertyValue('display'), priority: node.style.getPropertyPriority('display') }));
  nodes.forEach(node => node.style.setProperty('display', node.classList.contains('chart-export-attribution') ? 'flex' : 'block', 'important'));
  try {
    return await capture();
  } finally {
    nodes.forEach((node, index) => {
      const { value, priority } = previous[index];
      if (value) node.style.setProperty('display', value, priority);
      else node.style.removeProperty('display');
    });
  }
}

type Rgba = [number, number, number, number];

/** Any CSS colour (rgb, oklch, color-mix…) as sRGB 0–255 with alpha 0–1, via a 1×1 canvas. */
function toRgba(color: string): Rgba | null {
  if (!color || color === 'transparent') return [0, 0, 0, 0];
  const match = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (match) {
    const alpha = match[4] == null ? 1 : match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]);
    return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
  }
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return a === 0 ? [0, 0, 0, 0] : [r, g, b, a / 255];
}

/** Paint `top` over `bottom` (both straight alpha). */
function over(top: Rgba, bottom: Rgba): Rgba {
  const alpha = top[3] + bottom[3] * (1 - top[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  const channel = (i: number) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / alpha;
  return [channel(0), channel(1), channel(2), alpha];
}

const FALLBACK_BACKGROUND: Rgba = [11, 12, 14, 1];

/**
 * The colour a viewer actually sees behind the element: glass cards are
 * translucent, so their own background would export as a transparent PNG.
 * Composite the element's background over each ancestor's until opaque.
 */
export function opaqueBackground(element: HTMLElement): string {
  let color: Rgba = [0, 0, 0, 0];
  for (let node: HTMLElement | null = element; node && color[3] < 0.999; node = node.parentElement) {
    const layer = toRgba(getComputedStyle(node).backgroundColor);
    if (layer && layer[3] > 0) color = over(color, layer);
  }
  if (color[3] < 0.999) color = over(color, FALLBACK_BACKGROUND);
  return `rgb(${color.slice(0, 3).map(Math.round).join(', ')})`;
}

/** Legacy interactive panels keep their full visual snapshot; catalog plots use ChartExport. */
export async function captureElementPng(element: HTMLElement): Promise<Blob> {
  const { toBlob } = await import('html-to-image');
  const blob = await withChartAttribution(element, () => toBlob(element, {
    backgroundColor: opaqueBackground(element), pixelRatio: 2,
    filter: node => !(node instanceof HTMLElement && node.dataset.html2canvasIgnore),
  }));
  if (!blob) throw new Error('Image unavailable');
  return blob;
}
