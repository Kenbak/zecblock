'use strict';
// Share → Download image: a 1200×675 dark card (drawn at 2×) with a short
// title, the data window, the chart as drawn and its legend, and a small
// ZecBlock · Zift footer. Composed as one SVG string and rasterised in the
// browser; nothing leaves the page and no external host is contacted.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {chartLegend,chartValues,dateFormatter,SERIES_COLORS}=require('./research-display');

const WIDTH=1200,HEIGHT=675,SCALE=2,PAD=56;
const FOOTER_URL='zecblock.com/zift';
const DEFAULT_TITLE='My Zcash analysis';
// Dark-theme values of the tokens the chart draws with (app/globals.css :root).
// The card is always dark, whatever theme the page is showing.
const DARK={
  '--color-bg':'#0B0C0E','--color-surface-solid':'#111316','--color-border':'#24272D',
  '--color-gold':'#F8BC21','--color-yellow':'#F8BC21','--color-purple':'#B6A0E0',
  '--color-green':'#65C79A','--color-orange':'#E2A66E',
  '--color-shielding':'#65C79A','--color-deshielding':'#E2A66E',
  '--color-text-primary':'#F1F3F5','--color-text-secondary':'#C2C7CF','--color-text-muted':'#9CA4B0',
};
const SANS="ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
// var(--token) and var(--token, fallback) become dark hex values; an unknown
// token falls back to muted text rather than rendering black.
function resolveColors(markup){
  let out=String(markup);
  for(let i=0;i<4&&out.includes('var(');i++)out=out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,(_,name,fallback)=>DARK[name]||fallback?.trim()||DARK['--color-text-muted']);
  return out;
}
// Up to two lines of about 48 characters, broken at spaces; longer text ends in "…".
function titleLines(text,max=48,lines=2){
  const words=String(text).replace(/\s+/g,' ').trim().split(' ').filter(Boolean),out=[];
  let line='';
  for(const word of words){
    const next=line?`${line} ${word}`:word;
    if(next.length<=max){line=next;continue;}
    if(line)out.push(line);
    line=word.length>max?word.slice(0,max-1)+'…':word;
    if(out.length===lines)break;
  }
  if(out.length<lines&&line)out.push(line);
  else if(line&&out.length===lines){out[lines-1]=out[lines-1].slice(0,max-1).replace(/[\s.,;:]+$/,'')+'…';}
  return out.slice(0,lines);
}
const day=(value,year=true)=>{const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(value);return m?`${MONTHS[Number(m[2])-1]} ${Number(m[3])}${year?`, ${m[1]}`:''}`:value;};
function utc(value){
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return null;
  const iso=date.toISOString();
  return `${day(iso)} ${iso.slice(11,16)} UTC`;
}
// The card's one line of context: the date range the chart covers (UTC days
// or months), or, for charts without dates, when the data was indexed through.
function dataWindow(result,chart){
  const format=dateFormatter(result,chart.x);
  const values=format?result.rows.map(row=>row[chart.x]).filter(v=>v!==null&&v!=='').sort():[];
  if(values.length){
    const first=values[0],last=values[values.length-1],monthly=/^[A-Z][a-z]{2} \d{4}$/.test(format(first));
    if(monthly)return first===last?`${format(first)} · UTC`:`${format(first)} – ${format(last)} · UTC`;
    if(first===last)return `${day(first)} · UTC`;
    return `${day(first,first.slice(0,4)!==last.slice(0,4))} – ${day(last)} · UTC`;
  }
  const through=utc(result.indexedThrough);
  return through?`Indexed through ${through}`:null;
}
// The card names what it shows: the question or saved name, else "values by labels".
function cardTitle(result,chart,title){
  const named=String(title||'').trim();
  if(named&&named!==DEFAULT_TITLE)return named;
  const label=i=>result.columns[i]?.label.replaceAll('_',' ')||'';
  return `${chartValues(result,chart).map(label).join(', ')} by ${label(chart.x)}`;
}
// Legend for the card: the chart's own legend, or the single value column's name.
function cardLegend(result,chart){
  const legend=chartLegend(result,chart);
  if(legend.length)return legend.map(item=>({value:item.value,color:resolveColors(item.color)}));
  const y=chartValues(result,chart)[0];
  return y===undefined?[]:[{value:result.columns[y].label.replaceAll('_',' '),color:resolveColors(SERIES_COLORS[0])}];
}
// One SVG for the whole card. `plot` is the chart's drawn markup (children of
// the Recharts <svg>) with its width and height; it is scaled to fit its area.
function cardSVG({title,window:range,legend=[],plot}){
  const lines=titleLines(title);
  const titleSize=lines.length>1?30:34;
  let y=PAD+titleSize-6;
  const titleText=lines.map((line,i)=>`<text x="${PAD}" y="${y+i*(titleSize+8)}" font-size="${titleSize}" font-weight="600" fill="${DARK['--color-text-primary']}">${escape(line)}</text>`).join('');
  y+=(lines.length-1)*(titleSize+8);
  const rangeText=range?`<text x="${PAD}" y="${y+32}" font-size="18" fill="${DARK['--color-text-muted']}">${escape(range)}</text>`:'';
  if(range)y+=32;
  // Legend: one row, entries in order; long entries are shortened to fit.
  let lx=PAD;const ly=y+40;
  const room=WIDTH-PAD*2,each=legend.length?Math.floor(room/legend.length):room,chars=Math.max(8,Math.floor((each-40)/9));
  const legendText=legend.map(item=>{
    const text=item.value.length>chars?item.value.slice(0,chars-1)+'…':item.value;
    const out=`<rect x="${lx}" y="${ly-12}" width="14" height="14" rx="3" fill="${escape(item.color)}"/><text x="${lx+22}" y="${ly}" font-size="17" fill="${DARK['--color-text-secondary']}">${escape(text)}</text>`;
    lx+=Math.min(each,text.length*9.5+56);return out;
  }).join('');
  if(legend.length)y=ly;
  const top=y+28,bottom=HEIGHT-84,footerY=HEIGHT-36;
  const plotMarkup=plot?`<svg x="${PAD-16}" y="${top}" width="${WIDTH-PAD*2+32}" height="${bottom-top}" viewBox="0 0 ${plot.width} ${plot.height}" preserveAspectRatio="xMidYMid meet" overflow="visible" font-family="${MONO}">${resolveColors(plot.markup).replace(/font-size="12"/g,'font-size="13.5"')}</svg>`:'';
  // Axis ticks are 12px on the page; a shared image is read smaller, so they grow a little.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH*SCALE}" height="${HEIGHT*SCALE}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="${SANS}">`+
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${DARK['--color-bg']}"/>`+
    titleText+rangeText+legendText+plotMarkup+
    `<line x1="${PAD}" x2="${WIDTH-PAD}" y1="${HEIGHT-72}" y2="${HEIGHT-72}" stroke="${DARK['--color-border']}"/>`+
    `<text x="${PAD}" y="${footerY}" font-size="18" font-weight="600" fill="${DARK['--color-text-primary']}">ZecBlock <tspan fill="${DARK['--color-text-muted']}" font-weight="400">·</tspan> <tspan fill="${DARK['--color-gold']}">Zift</tspan></text>`+
    `<text x="${WIDTH-PAD}" y="${footerY}" font-size="18" text-anchor="end" fill="${DARK['--color-text-muted']}" font-family="${MONO}">${FOOTER_URL}</text>`+
    `</svg>`;
}
function researchCard(result,chart,title,plot){
  return cardSVG({title:cardTitle(result,chart,title),window:dataWindow(result,chart),legend:cardLegend(result,chart),plot});
}
function imageName(title){
  const slug=String(title||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60).replace(/-+$/,'');
  return `zecblock-zift-${slug||'chart'}.png`;
}

// Browser only: read the drawn chart, compose the card and save it as a PNG.
function plotFrom(svg){
  const box=svg.viewBox?.baseVal,width=box?.width||Number(svg.getAttribute('width'))||svg.clientWidth,height=box?.height||Number(svg.getAttribute('height'))||svg.clientHeight;
  if(!width||!height)return null;
  const serializer=new XMLSerializer();
  return {width,height,markup:[...svg.childNodes].map(node=>serializer.serializeToString(node)).join('')};
}
function rasterise(svgText){
  return new Promise((resolve,reject)=>{
    const image=new Image();
    image.onload=()=>{
      try{
        const canvas=document.createElement('canvas');canvas.width=WIDTH*SCALE;canvas.height=HEIGHT*SCALE;
        const context=canvas.getContext('2d');
        if(!context)throw new Error('No canvas');
        context.drawImage(image,0,0,canvas.width,canvas.height);
        canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('PNG encoding failed')),'image/png');
      }catch(error){reject(error);}
    };
    image.onerror=()=>reject(new Error('The chart image could not be drawn'));
    image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svgText);
  });
}
async function downloadChartImage(svg,result,chart,title){
  const plot=plotFrom(svg);
  if(!plot)throw new Error('The chart has not been drawn yet');
  const blob=await rasterise(researchCard(result,chart,title,plot));
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=imageName(cardTitle(result,chart,title));document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

module.exports={WIDTH,HEIGHT,SCALE,FOOTER_URL,DARK,resolveColors,titleLines,dataWindow,cardTitle,cardLegend,cardSVG,researchCard,imageName,downloadChartImage};
