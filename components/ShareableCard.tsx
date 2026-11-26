'use client';

import { useCallback, useRef, type ReactNode } from 'react';
import { BrandLogo } from '@/components/BrandLogo';
import { captureElementPng } from '@/lib/chart-export';
import { ChartShareControl } from '@/components/charts/ChartShareControl';
import type { ChartExportData } from '@/lib/chart-sharing';
import { NETWORK } from '@/lib/api-config';
import { ChartWatermark } from '@/components/ChartWatermark';

const publicBase = NETWORK === 'mainnet' ? 'https://zecblock.com' : NETWORK === 'testnet' ? 'https://testnet.zecblock.com' : 'https://crosslink.zecblock.com';

export function ShareableCard({title,icon,children,sourceHeight=0,isLive=false,shareText,fileName='zecblock.png',footerNote,className='mt-4',branding='logo',exportDisabled=false,compact=false,exportData,sharePath,expandedToolbar=false,animatedCapture}: {
  title:string; icon?:ReactNode; children:ReactNode; sourceHeight?:number; isLive?:boolean; shareText:string; fileName?:string;
  exportData?: ChartExportData; sharePath?: string; expandedToolbar?: boolean;
  /** Optional animated export of the card (e.g. lib/chart-gif.ts). */
  animatedCapture?: (card: HTMLElement) => Promise<Blob>;
  watermark?:boolean; footerNote?:string; className?:string; branding?:'logo'|'compact'; exportDisabled?:boolean; compact?:boolean;
}) {
  const cardRef=useRef<HTMLDivElement>(null);
  const capture=useCallback(async()=>{
    if (exportData) {
      const { captureChartPng } = await import('@/components/charts/capture-chart');
      return captureChartPng(exportData);
    }
    if(!cardRef.current) throw new Error('Chart unavailable');
    return captureElementPng(cardRef.current);
  }, [exportData]);
  const captureGif=useCallback(async()=>{
    if(!cardRef.current||!animatedCapture) throw new Error('Animation unavailable');
    return animatedCapture(cardRef.current);
  }, [animatedCapture]);
  const shareUrl = sharePath ? new URL(sharePath, publicBase).href : shareText.match(/https?:\/\/\S+/)?.[0] || publicBase;
  return <div className={className}><div ref={cardRef} className={`chart-branded relative h-full min-w-0 rounded-xl border border-cipher-border bg-cipher-card flex flex-col ${compact?'p-4':'p-4 sm:p-6'}`}>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2"><h2 className={`chart-title min-w-0 flex-1${icon ? ' flex items-center gap-2' : ''}`}>{icon ? <><span className="flex h-5 w-5 shrink-0 items-center justify-center text-cipher-gold" aria-hidden="true">{icon}</span><span>{title}</span></> : title}</h2>
      <ChartShareControl title={title} shareUrl={shareUrl} shareText={shareText} fileName={fileName} capture={capture} captureGif={animatedCapture ? captureGif : undefined} csvData={exportData} disabled={exportDisabled} expanded={expandedToolbar}/>

    </div>
    {children}
    <div className="mt-auto pt-3"><div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-cipher-border/40 pt-3 text-caption font-mono text-muted">
      <div className="chart-export-attribution items-center gap-2">{branding==='logo'&&<BrandLogo compact/>}<ChartWatermark className="!p-0"/></div>
      <span>{footerNote ?? `${isLive?'Live feed':'Snapshot'}${sourceHeight>0?` · block ${sourceHeight.toLocaleString()}`:''}`}</span>
    </div></div>
  </div></div>;
}
