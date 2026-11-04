'use client';
import {useId,useSyncExternalStore} from 'react';
import {ResponsiveContainer,ComposedChart,Bar,Cell,Line,Area,XAxis,YAxis,CartesianGrid,ReferenceDot,ReferenceLine} from 'recharts';
import {shortLabel,supportsLine,chartLabel,chartSeries,chartValues,axisFor,dateFormatter,axisDateFormatter,chartHighlight,SERIES_COLORS} from '@/lib/ask/research-display';
import {ChartTooltip} from '@/components/charts/ChartTooltip';
import type {ResearchResult,ResearchChart} from '@/lib/ask/research-contract';
import styles from './research.module.css';
const compact=(value:unknown)=>new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:2}).format(Number(value));
const tick={fill:'var(--color-text-muted)',fontSize:12};
// Exact cell text with digit grouping ("343844.96" → "343,844.96"); decimals are never rounded.
const grouped=(value:string|null)=>value===null?'Unavailable':value.replace(/^([-+]?)(\d+)/,(_,sign,digits)=>sign+digits.replace(/\B(?=(\d{3})+(?!\d))/g,','));
const decimals=(value:string|null)=>/\.(\d+)$/.exec(value||'')?.[1].length??0;
const reducedMotion=()=>typeof window!=='undefined'&&window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const subscribe=(notify:()=>void)=>{const query=typeof window!=='undefined'?window.matchMedia?.('(prefers-reduced-motion: reduce)'):null;query?.addEventListener('change',notify);return ()=>query?.removeEventListener('change',notify);};
const HIGHLIGHT_LABEL={latest:'Latest',change:'Latest',peak:'Peak',low:'Low'} as const;
export default function ResearchPlot({result,chart}:{result:ResearchResult;chart:ResearchChart}){
 const gradient=useId().replace(/:/g,'');
 const still=useSyncExternalStore(subscribe,reducedMotion,()=>true);
 const ordered=chart.view==='line'||chart.view==='area';
 if(ordered&&!supportsLine(result,chart.x))return <p className="text-sm text-secondary">Choose an ordered date or numeric label column, or use a bar chart.</p>;
 const values=chartValues(result,chart);
 if(!values.length)return <p className="text-sm text-secondary">Choose a numeric value column to draw this chart.</p>;
 const many=values.length>1;
 // One value: bars carry every text column in their label ("deshield · ironwood")
 // and are coloured by a small categorical column (shield/deshield…). Several
 // values: one colour per value column, grouped or stacked.
 const series=chart.view==='bar'&&!many?chartSeries(result,chart.x):null;
 const stacked=!!chart.stacked&&many&&chart.view!=='line';
 const axes=stacked?values.map(()=>'left' as const):axisFor(result,values),right=axes.includes('right');
 const data=result.rows.map(row=>({x:chart.view==='bar'?chartLabel(result,row,chart.x,series?.column):row[chart.x]??'Unavailable',...Object.fromEntries(values.map(i=>[`v${i}`,row[i]===null?null:Number(row[i])])),...Object.fromEntries(values.map(i=>[`s${i}`,row[i]])),fill:series?series.colorFor(row[series.column]):SERIES_COLORS[0]}));
 if(data.some(d=>values.some(i=>{const v=(d as Record<string,unknown>)[`v${i}`];return v!==null&&!Number.isFinite(v);})))return <p className="text-sm text-secondary">Choose a numeric value column to draw this chart.</p>;
 const name=(i:number,k:number)=>`${result.columns[i].label.replaceAll('_',' ')}${axes[k]==='right'?' (right axis)':''}`;
 // Ordered labels are raw values; dates read as "Oct 2025" or "Oct 28" on the axis. The tooltip
 // shows readable dates and each value's exact cell text, never the drawn float.
 const dates=ordered?axisDateFormatter(result,chart.x):null;
 const xLabel=(value:unknown)=>shortLabel(dates&&typeof value==='string'?dates(value):value);
 const labelDates=dateFormatter(result,chart.x);
 const pointLabel=(value:string|null)=>value===null?'Unavailable':labelDates?labelDates(value):value;
 // Up to sixteen bars each keep a label, angled when long or many. Denser bars
 // (a month of days) label evenly spaced bars instead; every bar keeps its tooltip.
 const dense=chart.view==='bar'&&data.length>16;
 const crowded=chart.view==='bar'&&!dense&&(data.length>6||data.some(d=>String(d.x).length>12));
 const mark=chartHighlight(result,chart);
 const animate=!still,motion={isAnimationActive:animate,animationDuration:700,animationEasing:'ease-out' as const};
 const legend=series?series.legend.map(item=>({value:item.value,color:item.color})):many?values.map((i,k)=>({value:name(i,k),color:SERIES_COLORS[k]})):[];
 const label=values.map(i=>result.columns[i].label).join(', ');
 const primary=SERIES_COLORS[0];
 const places=Math.min(4,Math.max(decimals(mark?.value??null),decimals(mark?.kind==='change'?mark.from.value:null)));
 const delta=mark?.kind==='change'?`${mark.delta>0?'+':mark.delta<0?'−':''}${Math.abs(mark.delta).toLocaleString('en-US',{minimumFractionDigits:places,maximumFractionDigits:places})}`:'';
 return <div role="img" aria-label={`${chart.view} chart of ${label} by ${result.columns[chart.x]?.label}; exact values in the table`}>
  {mark||legend.length?<div className={styles.plotHead}>
   {mark?<div className={styles.plotStat} aria-hidden="true">
    <span className={styles.plotStatLabel}>{HIGHLIGHT_LABEL[mark.kind]} · {result.columns[chart.y].label.replaceAll('_',' ')} · {pointLabel(mark.label)}{mark.partial?' (to date)':''}</span>
    <span className={styles.plotStatRow}>
     <span className={styles.plotStatValue}>{grouped(mark.value)}</span>
     {mark.kind==='change'?<span className={styles.plotStatChange} data-direction={mark.delta>0?'up':mark.delta<0?'down':'flat'}>{delta}{mark.pct!==null?` (${mark.pct>0?'+':''}${mark.pct.toFixed(1)}%)`:''} since {pointLabel(mark.from.label)}</span>:null}
    </span>
   </div>:<span/>}
   {legend.length?<ul className="flex flex-wrap justify-end gap-4 text-xs text-secondary" aria-hidden="true">{legend.map(item=><li key={item.value} className="flex items-center gap-2"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{background:item.color}}/>{item.value}</li>)}</ul>:null}
  </div>:null}
  <ResponsiveContainer width="100%" height={280}>
   <ComposedChart data={data} margin={{top:12,right:right?4:36,bottom:0,left:0}} barCategoryGap={data.length>20?'12%':'22%'}>
    <defs>{values.map((i,k)=><linearGradient key={i} id={`${gradient}-${k}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" style={{stopColor:SERIES_COLORS[k],stopOpacity:stacked?0.5:0.32}}/><stop offset="100%" style={{stopColor:SERIES_COLORS[k],stopOpacity:stacked?0.18:0}}/></linearGradient>)}</defs>
    <CartesianGrid vertical={false} strokeDasharray="2 6" stroke="var(--color-border)"/>
    <XAxis dataKey="x" tick={tick} tickLine={false} axisLine={{stroke:'var(--color-border)'}} interval={chart.view==='bar'&&!dense?0:'preserveStartEnd'} minTickGap={dense?16:24} tickFormatter={xLabel} angle={crowded?-30:0} textAnchor={crowded?'end':'middle'} height={crowded?72:36}/>
    {/* Bars start at zero; a level over time reads best on its own range. */}
    <YAxis yAxisId="left" tick={tick} tickLine={false} axisLine={false} width={52} tickFormatter={compact} domain={ordered&&!stacked?['auto','auto']:[0,'auto']}/>
    {right?<YAxis yAxisId="right" orientation="right" tick={tick} tickLine={false} axisLine={false} width={52} tickFormatter={compact} domain={ordered?['auto','auto']:[0,'auto']}/>:null}
    <ChartTooltip contentStyle={{maxWidth:'min(420px,80vw)',overflowWrap:'anywhere'}} labelFormatter={value=>typeof value==='string'?pointLabel(value):value} formatter={(value,_name,item)=>{const key=String(item?.dataKey??'');const exact=(item?.payload as Record<string,string|null>|undefined)?.['s'+key.slice(1)];return exact===undefined?value:grouped(exact);}}/>
    {values.map((i,k)=>{
     const common={yAxisId:axes[k],dataKey:`v${i}`,name:name(i,k),...motion,...(stacked?{stackId:'stack'}:{})};
     if(chart.view==='bar')return <Bar key={i} {...common} fill={SERIES_COLORS[k]} radius={stacked&&k<values.length-1?0:[3,3,0,0]} maxBarSize={56}>
      {series||mark&&!many?data.map((d,n)=><Cell key={n} fill={series?d.fill:primary} fillOpacity={mark&&!many&&mark.row!==n?0.42:1}/>):null}
     </Bar>;
     if(chart.view==='area')return <Area key={i} {...common} type="monotone" stroke={SERIES_COLORS[k]} strokeWidth={2} fill={`url(#${gradient}-${k})`} activeDot={{r:4,strokeWidth:0}} connectNulls={false}/>;
     return <Line key={i} {...common} type="monotone" stroke={SERIES_COLORS[k]} strokeWidth={2} dot={false} activeDot={{r:4,strokeWidth:0}} connectNulls={false}/>;
    })}
    {mark?.kind==='change'?<ReferenceLine yAxisId="left" y={Number(mark.from.value)} stroke="var(--color-text-muted)" strokeDasharray="4 4" strokeOpacity={0.6} ifOverflow="extendDomain"/>:null}
    {mark?.kind==='change'?<ReferenceDot yAxisId="left" x={data[mark.from.row].x} y={Number(mark.from.value)} r={4} fill="var(--color-surface-solid)" stroke="var(--color-text-muted)" strokeWidth={2}/>:null}
    {mark&&chart.view!=='bar'?<ReferenceDot yAxisId="left" x={data[mark.row].x} y={Number(mark.value)} r={5} fill="var(--color-surface-solid)" stroke={primary} strokeWidth={2.5}/>:null}
   </ComposedChart>
  </ResponsiveContainer>
 </div>;
}
