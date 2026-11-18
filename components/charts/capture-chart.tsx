'use client';

import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ChartExport } from './ChartExport';
import { EXPORT_SIZE, type ChartExportData } from '@/lib/chart-sharing';

let exportFont: Promise<string> | undefined;
function loadExportFont(): Promise<string> {
  if (!exportFont) exportFont = (async () => {
    const response = await fetch('/fonts/chart-export/Geist-Regular.ttf');
    if (!response.ok) throw new Error('Export font unavailable');
    const buffer = await response.arrayBuffer();
    const font = await new FontFace('ZecBlock Export', buffer).load();
    document.fonts.add(font);
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result)); reader.onerror = reject;
      reader.readAsDataURL(new Blob([buffer], { type: 'font/ttf' }));
    });
    return `@font-face { font-family: 'ZecBlock Export'; src: url(${base64}) format('truetype'); font-weight: 400; }`;
  })().catch(error => { exportFont = undefined; throw error; });
  return exportFont;
}

export async function captureChartPng(data: ChartExportData): Promise<Blob> {
  const fontEmbedCSS = await loadExportFont();
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:1200px;pointer-events:none;';
  host.setAttribute('aria-hidden', 'true');
  host.inert = true;
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<ChartExport data={data}/>));
    await Promise.all(Array.from(host.querySelectorAll('img')).map(img => img.decode()));
    const { toBlob } = await import('html-to-image');
    const blob = await toBlob(host.firstElementChild as HTMLElement, { ...EXPORT_SIZE, pixelRatio: 1, fontEmbedCSS, backgroundColor: '#0B0C0E', includeQueryParams: true });
    if (!blob) throw new Error('Image unavailable');
    return blob;
  } finally { root.unmount(); host.remove(); }
}
