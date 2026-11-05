'use client';
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { NETWORK } from '@/lib/api-config';
import { analysisSchema, type AnalysisSpec } from '@/lib/ask/contract';
import { ASK_CHART_EVENT } from '@/lib/ask/widget-context';
import { ZiftMark } from './ZiftMark';
const AskPanel = dynamic(() => import('./AskPanel'), { ssr: false });
export function AskWidget() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [chart, setChart] = useState<{ pathname: string; spec: AnalysisSpec; serial: number } | null>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    function onChart(event: Event) {
      const detail = (event as CustomEvent).detail;
      const parsed = analysisSchema.safeParse(detail?.spec);
      if (NETWORK !== 'mainnet' || pathname === '/zift' || detail?.pathname !== pathname || !parsed.success) return;
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setChart(previous => ({ pathname, spec: parsed.data, serial: (previous?.serial || 0) + 1 }));
      setLoaded(true); setOpen(true);
    }
    window.addEventListener(ASK_CHART_EVENT, onChart);
    return () => window.removeEventListener(ASK_CHART_EVENT, onChart);
  }, [pathname]);
  if (NETWORK !== 'mainnet' || pathname === '/zift') return null;
  function close() { setOpen(false); (returnFocus.current?.isConnected ? returnFocus.current : launcher.current)?.focus(); }
  return <>
    <button ref={launcher} type="button" onClick={() => { returnFocus.current = launcher.current; setLoaded(true); setOpen(true); }} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? 'ask-page-panel' : undefined} className="fixed bottom-4 right-4 z-40 hidden md:flex items-center gap-2 rounded-full border border-cipher-border bg-cipher-surface px-4 py-3 text-sm text-primary shadow-lg hover:bg-glass-3" style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom))' }}><ZiftMark size={16} /> Ask Zift</button>
    {loaded ? <AskPanel key={`${pathname}:${chart?.pathname === pathname ? chart.serial : 0}`} pathname={pathname} initialSpec={chart?.pathname === pathname ? chart.spec : undefined} open={open} onClose={close} /> : null}
  </>;
}
