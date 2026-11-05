'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ResponsiveContainer, ComposedChart, Line, Area, Bar, XAxis, YAxis, CartesianGrid, ReferenceLine } from 'recharts';
import { CHART_CATALOG, catalogRows, latestCatalogObservation, formatCatalogValue, type CatalogChart } from '@/lib/chart-catalog';
import { poolDateAxis } from '@/lib/pool-display';
import { getChartColors } from '@/lib/chart-theme';
import { useTheme } from '@/contexts/ThemeContext';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ChartTooltip } from '@/components/charts/ChartTooltip';
import { ShareableCard } from '@/components/ShareableCard';
import { chartSharePath, chartSnapshotLabel, chartDateRange, chartRangeRows, chartEndpoint, CHART_RANGES, type ChartRange } from '@/lib/chart-sharing';
import { NETWORK } from '@/lib/api-config';
import { ChartSkeleton } from '@/components/ui/Skeleton';

const CATEGORIES=['All',...new Set(CHART_CATALOG.map(c=>c.category))];
const TOOLS=[
  {title:'Node map & topology',href:'/network/nodes#node-explorer',description:'Explore observed node geography and advertised peer relationships. Graph positions are not geography.'},
  {title:'Mempool explorer',href:'/mempool',description:'Inspect pending transactions as bubbles or a treemap. Sizes represent the selected metric.'},
  {title:'Supply timeline',href:'/pools#overview',description:'Move through recorded supply snapshots and inspect the shielded pool split.'},
  {title:'Ironwood migration',href:'/ironwood',description:'Explore pool migration, supply verification and observed inflows.'},
  {title:'Privacy risk scanner',href:'/privacy-risks',description:'Inspect public transaction patterns flagged by heuristics, with their evidence and limitations.'},
  {title:'Network pulse',href:'/pulse',description:'Explore statistical anomalies detected in indexed network activity.'},
  {title:'Usage clock',href:'/usage-clock',description:'Explore transaction activity by time of day.'},
  {title:'Turnstile tracker',href:'/turnstile',description:'Follow the publicly observable path of value after deshielding.'},
];

export function CatalogCard({chart, initialData, initialFetchedAt, initialSnapshotNotice, initialRange='30d', initialSeries, standalone=false}:{chart:CatalogChart; initialData?: unknown; initialFetchedAt?: number; initialSnapshotNotice?: string; initialRange?: ChartRange; initialSeries?: string[]; standalone?: boolean}) {
  const ref=useRef<HTMLElement>(null);
  const [visible,setVisible]=useState(standalone);
  const [width,setWidth]=useState(500);
  const [hidden,setHidden]=useState<string[]>(initialSeries ? chart.series.filter(s=>!initialSeries.includes(s.key)).map(s=>s.key) : []);
  const [range,setRange]=useState<ChartRange>(initialRange);
  const [expanded,setExpanded]=useState(standalone);
  const {theme}=useTheme();const colors=getChartColors(theme);
  useEffect(()=>{
    const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'300px'});
    if(ref.current) observer.observe(ref.current);
    return()=>observer.disconnect();
  },[]);
  const {data,loading,error}=useApiQuery<unknown>(chartEndpoint(chart),undefined,{initialData,initialFetchedAt,enabled:visible,refreshInterval:300000,timeoutMs:30000});
  const allRows=useMemo(()=>catalogRows(chart,data),[chart,data]);
  const rows=useMemo(()=>chartRangeRows(chart,allRows,range),[chart,allRows,range]);
  const shown=chart.series.filter(s=>!hidden.includes(s.key));
  const latest=latestCatalogObservation(rows,shown);
  const hasData=!!latest;
  const dateAxis=useMemo(()=>poolDateAxis(chart.axis?[]:rows.map(r=>new Date(Number(r.x)).toISOString()),width-85),[chart.axis,rows,width]);
  const isDate=!chart.axis;
  const windowLabel=isDate?(range==='all'?'All available history':`${range.toUpperCase()} within available history`):chart.window;
  const label=(x:unknown)=>isDate?new Date(Number(x)).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'}):chart.axis==='height'?`Block ${Number(x).toLocaleString('en-US')}`:String(x);
  const sharePath=chartSharePath(chart.id,range,hidden.length?shown.map(s=>s.key):undefined);
  const exportData=useMemo(()=>({chart:{...chart,series:chart.series.filter(s=>!hidden.includes(s.key))},rows,network:NETWORK,asOf:chart.axis==='category'?chartSnapshotLabel(data):undefined}),[chart,rows,hidden,data]);
  const category=chart.axis==='category';
  const height=expanded?Math.max(340,category?rows.length*30:400):240;
  return <article ref={ref} id={chart.id} className={`min-w-0 scroll-mt-56 sm:scroll-mt-36 ${expanded?'xl:col-span-2':''}`}>
    <ShareableCard title={chart.title} shareText={`${chart.title} · ${chartDateRange(chart,rows)}`} sharePath={sharePath} exportData={exportData} expandedToolbar={expanded} fileName={`zecblock-${chart.id}.png`} branding="compact" compact className="h-full" exportDisabled={!hasData || loading} footerNote={latest&&!category?`Latest observation · ${label(latest.x)}`:windowLabel}>
      <p className="text-xs text-muted leading-relaxed min-h-12 mb-3">{chart.description}</p>
      <div className="flex flex-wrap justify-between gap-2 text-caption font-mono text-muted mb-3"><span>{chart.unit}</span><span>{windowLabel}</span></div>
      {expanded&&!chart.axis&&<div className="mb-4 flex flex-wrap items-center gap-2" aria-label="Chart observation range"><span className="text-caption text-muted mr-2">Within available history</span>{CHART_RANGES.map(value=><button key={value} type="button" className={`filter-btn ${range===value?'filter-btn-active':''}`} aria-pressed={range===value} onClick={()=>setRange(value)}>{value==='all'?'All':value.toUpperCase()}</button>)}</div>}
      {!visible||loading?<ChartSkeleton height={height}/>:!hasData?<div role="status" className="min-h-[240px] flex flex-col items-center justify-center gap-3 text-xs text-muted text-center"><span>{error?'Could not load this data.':'No verified observations available.'}</span><Link href={chart.href} className="underline underline-offset-4">View source analysis →</Link></div>:
        <div role="img" aria-label={`${chart.title}. ${chart.description} Units: ${chart.unit}.`}>
          <ResponsiveContainer width="100%" height={height} initialDimension={{width:500,height}} onResize={w=>setWidth(w)}><ComposedChart data={rows} layout={category?'vertical':'horizontal'} margin={{top:12,right:12,left:0,bottom:8}}>
            <CartesianGrid vertical={category} horizontal={!category} stroke={colors.gridStroke}/>
            {category?<><XAxis type="number" tickFormatter={v=>formatCatalogValue(Number(v),chart.unit,true)} tick={{fill:colors.axis,fontSize:12}} axisLine={false} tickLine={false}/><YAxis type="category" dataKey="x" width={Math.min(175,Math.max(105,width*0.3))} interval={!expanded&&rows.length>12?'preserveStartEnd':0} minTickGap={5} tickFormatter={value=>String(value).length>18?`${String(value).slice(0,17)}…`:String(value)} tick={{fill:colors.axis,fontSize:12}} axisLine={false} tickLine={false}/></>:<><XAxis type="number" dataKey="x" scale={isDate?'time':'linear'} domain={['dataMin','dataMax']} ticks={isDate?dateAxis.ticks:undefined} tickCount={4} minTickGap={40} tickFormatter={x=>isDate?dateAxis.format(Number(x)):Number(x).toLocaleString('en-US')} tick={{fill:colors.axis,fontSize:12}} axisLine={false} tickLine={false}/><YAxis width={62} domain={chart.percent?[0,100]:undefined} tickFormatter={v=>formatCatalogValue(Number(v),chart.unit,true)} tick={{fill:colors.axis,fontSize:12}} axisLine={false} tickLine={false}/></>}
            <ChartTooltip labelFormatter={label} formatter={(value,name)=>[`${formatCatalogValue(Number(value),chart.unit)}${['%','Multiple','Ratio'].includes(chart.unit)?'':` ${chart.unit}`}`,String(name)]}/>
            {chart.reference!=null&&<ReferenceLine y={chart.reference} stroke={colors.referenceLine} strokeDasharray="4 4"/>}
            {shown.map(s=>chart.kind==='bar'?<Bar key={s.key} dataKey={s.key} name={s.label} fill={colors[s.color]} maxBarSize={category?12:20} isAnimationActive={false}/>:chart.kind==='area'?<Area key={s.key} dataKey={s.key} name={s.label} stroke={colors[s.color]} fill={colors[s.color]} fillOpacity={0.35} stackId={chart.stack?'total':undefined} type="linear" isAnimationActive={false} connectNulls={false}/>:<Line key={s.key} dataKey={s.key} name={s.label} stroke={colors[s.color]} strokeWidth={2} dot={rows.length===1} type="linear" isAnimationActive={false} connectNulls={false}/>)}
          </ComposedChart></ResponsiveContainer>
        </div>}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 min-h-6" aria-label={`${chart.title} legend`}>{chart.series.map(s=><button type="button" key={s.key} aria-pressed={!hidden.includes(s.key)} onClick={()=>setHidden(prev=>prev.includes(s.key)?prev.filter(k=>k!==s.key):prev.length<chart.series.length-1?[...prev,s.key]:prev)} className={`flex items-center gap-2 py-1 text-caption text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold ${hidden.includes(s.key)?'opacity-40':''}`}><span className="w-2 h-2 rounded-sm" style={{backgroundColor:colors[s.color]}}/>{s.label}</button>)}</div>
      {error&&hasData&&<p role="status" className="text-caption text-warning mt-3">Refresh failed. Showing the last received observations.</p>}
      {initialSnapshotNotice&&data===initialData?<p role="status" className="text-caption text-muted mt-3">{initialSnapshotNotice}. Showing the last available observations.</p>:null}
      <div className="flex flex-wrap justify-between gap-3 mt-3 text-caption font-mono" data-html2canvas-ignore="true"><Link href={chart.href} className="text-muted hover:text-primary underline-offset-4 hover:underline">Explore analysis →</Link><Link href={sharePath} className="text-muted hover:text-primary underline-offset-4 hover:underline">Chart page ↗</Link>{!standalone&&<button type="button" onClick={()=>setExpanded(!expanded)} aria-expanded={expanded} className="text-muted hover:text-primary">{expanded?'Compact view':'Expand chart'}</button>}</div>
    </ShareableCard>
  </article>;
}

export function ChartsClient() {
  const [category,setCategory]=useState('All');const [query,setQuery]=useState('');
  const charts=CHART_CATALOG.filter(c=>(category==='All'||c.category===category)&&`${c.title} ${c.description} ${c.category}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-cipher-border pb-5 mb-8"><div className="flex flex-wrap gap-2" aria-label="Chart categories">{CATEGORIES.map(c=><button type="button" key={c} aria-pressed={category===c} onClick={()=>setCategory(c)} className={`filter-btn ${category===c?'filter-btn-active':''}`}>{c}</button>)}</div><label className="flex items-center gap-3 text-caption text-muted"><span className="sr-only">Find a chart</span><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Find a chart…" className="w-full sm:w-56 rounded-lg border border-cipher-border bg-cipher-surface px-3 py-2 text-sm text-primary"/></label></div>
    <div className="flex flex-wrap justify-between gap-3 mb-5 text-caption text-muted"><p role="status">{charts.length} charts{category==='All'?'':` · ${category}`}</p><a href="#interactive-tools" className="font-mono hover:text-primary">Interactive tools ↓</a></div>
    {charts.length?<div className="grid xl:grid-cols-2 gap-4 items-stretch">{charts.map(chart=><CatalogCard key={chart.id} chart={chart}/>)}</div>:<p className="py-16 text-muted text-center">No charts match. Try another term or category.</p>}
    <section id="interactive-tools" className="mt-16 scroll-mt-56 sm:scroll-mt-36"><h2 className="text-sm font-mono text-primary mb-3">{'>'} interactive_tools</h2><p className="text-xs text-muted mb-6">Open the full visualization to interact with its data and controls.</p><div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">{TOOLS.map(tool=><Link key={tool.href} href={tool.href} className="rounded-xl border border-cipher-border p-5 hover:bg-glass-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold"><div className="flex justify-between gap-3 text-sm font-semibold"><span>{tool.title}</span><span aria-hidden="true">↗</span></div><p className="text-xs text-muted leading-relaxed mt-3">{tool.description}</p></Link>)}</div></section>
    <p className="text-caption text-muted mt-8">Charts load as you browse and check for updates every five minutes while this tab is visible. Each source has its own collection schedule; the latest daily bucket may be incomplete. Dates use UTC. Missing observations stay unavailable.</p>
  </>;
}
