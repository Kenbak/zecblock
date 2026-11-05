'use strict';
// Display preferences never change query order, aggregate rows, or convert units.
function defaultResearchChart(result) {
  if (!result) return {view:'table',x:0,y:0};
  // Prefer an amount/share column (zec, usd, fees, pct…) over a count of records.
  const measures=result.columns.map((c,i)=>({c,i})).filter(({c})=>c.type==='number' && !/^(?:.*_)?(?:height|timestamp|id)$/.test(c.label.toLowerCase()));
  const amount=measures.find(({c})=>/(?:zec|usd|amount|fees?|value|share|pct|percent|balance)/i.test(c.label));
  const measure=(amount||measures[0])?.i ?? -1;
  const numeric=result.columns.findIndex(c=>c.type==='number');
  return {view:'table',x:0,y:Math.max(0,measure < 0 ? numeric : measure)};
}
function shortLabel(value) {
  const text=String(value ?? 'Unavailable');
  return text.length>22 ? text.slice(0,10)+'…'+text.slice(-6) : text;
}
function supportsLine(result,x) {
  const column=result.columns[x];
  if(!column || result.rows.length<2)return false;
  const values=result.rows.map(row=>row[x]===null ? NaN : column.type==='number' ? Number(row[x]) : /^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(row[x]) ? Date.parse(row[x]) : NaN);
  if(values.some(v=>!Number.isFinite(v)))return false;
  const direction=Math.sign(values[1]-values[0]);
  return direction!==0 && values.every((value,i)=>i===0 || Math.sign(value-values[i-1])===direction);
}
function cellLink(key,value) {
  if(!value)return null;
  if((key==='txid'||key==='transaction_hash') && /^[0-9a-f]{64}$/i.test(value))return '/tx/'+value;
  if((key==='height'||key==='block_height') && /^[1-9]\d{0,8}$/.test(value))return '/block/'+value;
  if((key==='miner'||key==='address') && /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(value))return '/address/'+value;
  return null;
}
// UTC-midnight timestamps ("2025-10-01 00:00:00+00") read as dates, and a column
// of first-of-month dates reads as months ("Oct 2025"). Exact values stay in
// tooltips, CSV and exports; only the visible text changes.
const MIDNIGHT=/^(\d{4})-(\d{2})-(\d{2})(?:[ T]00:00:00(?:\.0+)?(?:Z|[+-]00(?::?00)?)?)?$/;
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function dateFormatter(result,i) {
  const column=result.columns[i];
  if(!column||column.type==='number')return null;
  const values=result.rows.map(row=>row[i]).filter(v=>v!==null&&v!=='');
  if(!values.length||!values.every(v=>MIDNIGHT.test(v)))return null;
  const monthly=values.every(v=>MIDNIGHT.exec(v)[3]==='01')&&(/month/i.test(column.label)||new Set(values).size===values.length&&values.length>1);
  return value=>{const m=MIDNIGHT.exec(value??'');if(!m)return value;return monthly?`${MONTHS[Number(m[2])-1]} ${m[1]}`:`${m[1]}-${m[2]}-${m[3]}`;};
}
// Axis ticks: daily dates within one year read "Oct 28" so the last tick fits
// at the chart edge; monthly dates keep "Oct 2025"; daily dates across years
// keep the full date. Tooltips and tables keep their own formats.
function axisDateFormatter(result,i) {
  const full=dateFormatter(result,i);
  if(!full)return null;
  const values=result.rows.map(row=>row[i]).filter(v=>v!==null&&v!=='');
  if(/^[A-Z][a-z]{2} \d{4}$/.test(full(values[0])))return full;
  if(new Set(values.map(v=>v.slice(0,4))).size!==1)return full;
  return value=>{const m=MIDNIGHT.exec(value??'');return m?`${MONTHS[Number(m[2])-1]} ${Number(m[3])}`:value;};
}
// Bar labels keep every text column ("deshield · ironwood"), led by the chosen label column.
// A column already shown by bar colour is left out of the label.
function chartLabel(result,row,x,colourColumn=-1) {
  const parts=[x,...result.columns.map((c,i)=>({c,i})).filter(({c,i})=>c.type!=='number'&&i!==x).map(({i})=>i)].filter(i=>i!==colourColumn).map(i=>{const format=dateFormatter(result,i);return format&&row[i]!==null?format(row[i]):row[i];}).filter(v=>v!==null&&v!=='');
  return parts.length?parts.join(' · '):String(row[x]??'Unavailable');
}
// Shield/deshield and inflow/outflow use the site's semantic flow colours;
// other small categories use a fixed palette. Only 2–6 distinct values colour.
const SEMANTIC={shield:'var(--color-shielding)',deshield:'var(--color-deshielding)',inflow:'var(--color-shielding)',outflow:'var(--color-deshielding)'};
const PALETTE=['var(--color-gold)','var(--color-purple)','var(--color-green)','var(--color-orange)','var(--color-text-secondary)','var(--color-yellow)'];
function chartSeries(result,x) {
  const order=[x,...result.columns.map((_,i)=>i).filter(i=>i!==x)];
  for (const i of order) {
    if (result.columns[i].type==='number') continue;
    const values=[...new Set(result.rows.map(row=>row[i]??'Unavailable'))];
    if (values.length<2||values.length>6) continue;
    const colors=new Map(values.map((v,k)=>[v,SEMANTIC[String(v).toLowerCase()]||PALETTE[k%PALETTE.length]]));
    return {column:i,legend:values.map(value=>({value,color:colors.get(value)})),colorFor:value=>colors.get(value??'Unavailable')};
  }
  return null;
}
// Value columns a chart draws, primary first; non-numeric or missing columns are skipped.
function chartValues(result,chart) {
  return [...new Set([chart.y,...(chart.series||[])])].filter(i=>result.columns[i]?.type==='number');
}
// Values too different in size to share one axis go on a right axis: anything
// more than 20× the primary's largest magnitude, or 20× smaller.
function axisFor(result,values) {
  const peak=i=>Math.max(0,...result.rows.map(row=>Math.abs(Number(row[i]))).filter(Number.isFinite));
  const base=peak(values[0]);
  return values.map((i,k)=>{if(k===0||!base)return 'left';const p=peak(i);return p&&(p/base>20||base/p>20)?'right':'left';});
}
// The first text/date column labels a chart; with none, the first column does.
function labelColumn(result) {
  const i=result.columns.findIndex(c=>c.type!=='number');
  return i<0?0:i;
}
// Ask answers open as a chart: an ordered series as an area ending on its
// latest value, a short ranking or category list as bars led by its peak.
// SQL results keep defaultResearchChart's table.
function suggestResearchChart(result) {
  const base=defaultResearchChart(result);
  if(!result||result.columns[base.y]?.type!=='number'||result.rows.length<2)return base;
  const x=labelColumn(result);
  if(x===base.y)return base;
  if(result.rows.length>=3&&supportsLine(result,x))return {view:'area',x,y:base.y,highlight:'latest'};
  const labels=result.rows.map(row=>row[x]);
  if(result.rows.length<=30&&new Set(labels).size===labels.length)return {view:'bar',x,y:base.y,highlight:'peak'};
  return base;
}
// A chart someone (or the model) proposed, kept only where it fits these rows:
// numeric distinct values, lines and areas on an ordered axis, stacking only
// for same-axis values (and, when units are known, the same unit). Returns null
// when nothing drawable is left.
function fitResearchChart(result,chart,units) {
  if(!result||!chart)return null;
  const numeric=i=>Number.isInteger(i)&&result.columns[i]?.type==='number';
  const x=Number.isInteger(chart.x)&&result.columns[chart.x]?chart.x:labelColumn(result);
  if(chart.view==='table')return numeric(chart.y)?{view:'table',x,y:chart.y}:{view:'table',x,y:defaultResearchChart(result).y};
  if(!numeric(chart.y)||chart.y===x)return null;
  const series=[...new Set((chart.series||[]).filter(i=>numeric(i)&&i!==chart.y&&i!==x))].slice(0,4);
  const ordered=supportsLine(result,x);
  const view=(chart.view==='line'||chart.view==='area')&&!ordered?'bar':chart.view;
  if(!['line','area','bar'].includes(view))return null;
  const out={view,x,y:chart.y};
  if(series.length)out.series=series;
  const values=[chart.y,...series];
  const sameUnit=!units||values.every(i=>(units[i]||'')===(units[chart.y]||''));
  if(chart.stacked&&series.length&&view!=='line'&&sameUnit&&axisFor(result,values).every(a=>a==='left'))out.stacked=true;
  if(['peak','low','latest','change'].includes(chart.highlight)&&(ordered||chart.highlight==='peak'||chart.highlight==='low'))out.highlight=chart.highlight;
  return out;
}
// The row whose period runs past the indexed data ("Oct 2026" while data ends
// Oct 29), or -1. Monthly labels are first-of-month dates; other grains use the
// smallest gap between labels (a day, a week). One row or no dates: -1.
function partialPeriod(result,x) {
  const through=Date.parse(result?.indexedThrough||'');
  if(!Number.isFinite(through)||!result.rows||result.rows.length<2)return -1;
  const days=result.rows.map(row=>/^(\d{4})-(\d{2})-(\d{2})/.exec(row[x]??''));
  if(days.some(m=>!m))return -1;
  const times=days.map(m=>Date.UTC(+m[1],+m[2]-1,+m[3]));
  const sorted=[...times].sort((a,b)=>a-b),latest=sorted.at(-1),row=times.indexOf(latest);
  const gaps=sorted.slice(1).map((t,i)=>t-sorted[i]).filter(g=>g>0);
  if(!gaps.length)return -1;
  const monthly=days.every(m=>m[3]==='01')&&gaps.every(g=>g>=28*864e5&&g<=31*864e5);
  const m=days[row],end=monthly?Date.UTC(+m[1],+m[2],1):latest+Math.min(...gaps);
  return end>through?row:-1;
}
// The row a highlight points at, read from the exact cell strings. "latest"
// and "change" follow the label column's own order (ascending or descending).
function chartHighlight(result,chart) {
  if(!chart.highlight||chart.view==='table')return null;
  const partial=partialPeriod(result,chart.x);
  const y=chart.y,all=result.rows.map((row,i)=>({i,row,n:row[y]===null?NaN:Number(row[y])})).filter(r=>Number.isFinite(r.n));
  // An incomplete latest period is never the low or the end of a change.
  const rows=chart.highlight==='peak'||chart.highlight==='latest'?all:all.filter(r=>r.i!==partial);
  if(!rows.length)return null;
  const point=r=>({row:r.i,value:r.row[y],label:r.row[chart.x],...(r.i===partial?{partial:true}:{})});
  if(chart.highlight==='peak'||chart.highlight==='low'){
    const pick=rows.reduce((best,r)=>chart.highlight==='peak'?(r.n>best.n?r:best):(r.n<best.n?r:best));
    return {kind:chart.highlight,...point(pick)};
  }
  if(!supportsLine(result,chart.x)||rows.length<2)return null;
  const column=result.columns[chart.x];
  const key=r=>column.type==='number'?Number(r.row[chart.x]):Date.parse(r.row[chart.x]);
  const ascending=key(rows.at(-1))>key(rows[0]);
  const first=ascending?rows[0]:rows.at(-1),last=ascending?rows.at(-1):rows[0];
  if(chart.highlight==='latest')return {kind:'latest',...point(last)};
  const delta=last.n-first.n;
  return {kind:'change',...point(last),from:point(first),delta,pct:first.n?delta/Math.abs(first.n)*100:null};
}
const SERIES_COLORS=['var(--color-gold)','var(--color-purple)','var(--color-green)','var(--color-orange)','var(--color-text-secondary)'];
module.exports={defaultResearchChart,axisDateFormatter,partialPeriod,suggestResearchChart,fitResearchChart,chartHighlight,labelColumn,shortLabel,supportsLine,cellLink,chartLabel,chartSeries,dateFormatter,chartValues,axisFor,SERIES_COLORS};
