'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { PageSectionNav } from '@/components/PageSectionNav';
import { MetricCard, SectionHeader } from '@/components/ui';
import { MetricSkeletons } from '@/components/ui/Skeleton';
import { PeriodPillTags } from '@/components/ui/PeriodPillTags';
import { ValuationChart } from '@/components/valuation/ValuationChart';
import { SearchInterest } from '@/components/valuation/SearchInterest';
import { dailyMarketContext, finite, positive, modeledPremium, quoteIsFresh, snapshotIsRecent, utcDay, type PriceQuote, type ValuationPoint, type ValuationSnapshot } from '@/lib/valuation';
import { useUrlState } from '@/lib/use-url-state';

type Period = '30d'|'90d'|'1y'|'2y'|'all';
const PERIODS: {key:Period;label:string}[] = [{key:'30d',label:'30D'},{key:'90d',label:'90D'},{key:'1y',label:'1Y'},{key:'2y',label:'2Y'},{key:'all',label:'ALL'}];
const SECTIONS = [{id:'overview',label:'Overview'},{id:'price',label:'Price & cost basis'},{id:'activity',label:'Spending & holding'},{id:'attention',label:'Adoption & attention'},{id:'methodology',label:'Methodology'}];
interface AgePoint {date:string;lt1m:number;b1_3m:number;b3_6m:number;b6_12m:number;b1_2y:number;gt2y:number;total:number;[key:string]:unknown}
interface DormancyPoint {date:string;cdd:number|null;avgDormancy:number|null;[key:string]:unknown}
interface Pools {current:{chainSupply:number;shielded:number};deltas:{shielded?:{'7d'?:number}};asOf?:string}
const usd = (v:number) => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:Math.abs(v)>=1e6?'compact':'standard',maximumFractionDigits:2}).format(v);
const number = (v:number) => new Intl.NumberFormat('en-US',{notation:Math.abs(v)>=10000?'compact':'standard',maximumFractionDigits:1}).format(v);
const pct = (v:number) => `${v>0?'+':''}${v.toFixed(1)}%`;
const date = (v:string|undefined|null) => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleDateString('en-US',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}) : 'Unavailable';
const show = (v:unknown, f:(v:number)=>string) => finite(v)?f(v):'—';

export default function ValuationClient() {
  const {theme}=useTheme();const c=getChartColors(theme);
  const [period,setPeriod]=useUrlState<Period>('period','30d',PERIODS.map(p=>p.key)); const [profitMetric,setProfitMetric]=useState<'nupl'|'sopr'>('nupl');const [ageMetric,setAgeMetric]=useState<'avgDormancy'|'cdd'>('avgDormancy');
  const [now,setNow]=useState(0);
  useEffect(()=>{setNow(Date.now());const id=setInterval(()=>setNow(Date.now()),30_000);return()=>clearInterval(id)},[]);
  const quoteQuery=useApiQuery<PriceQuote>('/v1/network/price',undefined,{refreshInterval:30_000});
  const snapshotQuery=useApiQuery<ValuationSnapshot>('/v1/valuation/snapshot',undefined,{refreshInterval:600_000});
  const histQuery=useApiQuery<{points:ValuationPoint[]}>('/v1/valuation/history',{period:'all'});
  const ageQuery=useApiQuery<{period:string;points:AgePoint[]}>('/v1/valuation/hodl-waves',{period});
  const dormQuery=useApiQuery<{period:string;points:DormancyPoint[]}>('/v1/valuation/dormancy',{period});
  const poolsQuery=useApiQuery<Pools>('/v1/shielded-pools/overview');
  const searchQuery=useApiQuery<{snapshot:{capturedAt:string}|null}>('/v1/valuation/search-interest',undefined,{refreshInterval:300_000});
  const history=useMemo(()=>histQuery.data?.points??[],[histQuery.data]);
  const market=useMemo(()=>dailyMarketContext(history),[history]);
  const shown=useMemo(()=>{const days=period==='30d'?30:period==='90d'?90:period==='1y'?365:period==='2y'?730:Infinity;const latest=history.at(-1);return history.filter(p=>latest && utcDay(p.date)>=utcDay(latest.date)-(days-1)*86400_000).map(p=>({...p,sopr:p.soprSource==='transparent_spends'?p.sopr:null}));},[history,period]);
  const s=snapshotQuery.data;const q=quoteQuery.data;const fresh=quoteIsFresh(q,now)&&!quoteQuery.error;const recent=snapshotIsRecent(s?.date,now);
  const premium=quoteQuery.error?null:modeledPremium(s,q,now);
  const marketRecent=snapshotIsRecent(market.date??undefined,now);
  const trend=fresh&&marketRecent&&positive(market.ma200)&&positive(q?.price)?(q.price/market.ma200-1)*100:null;
  const drawdown=fresh&&marketRecent&&positive(market.high365)&&positive(q?.price)?(q.price/Math.max(market.high365,q.price)-1)*100:null;
  const expectedPeriod = period==='all' ? 'all' : `${period==='30d'?30:period==='90d'?90:period==='1y'?365:730}d`;
  const agePoints=ageQuery.data?.period===expectedPeriod?ageQuery.data.points:[];const dormPoints=dormQuery.data?.period===expectedPeriod?dormQuery.data.points:[];
  const pools=poolsQuery.data;const shieldedPct=pools?.current&&positive(pools.current.chainSupply)&&finite(pools.current.shielded)?pools.current.shielded/pools.current.chainSupply*100:null;
  const poolChange=pools?.deltas?.shielded?.['7d'];
  const criteria=[
    {label:'Market activity',value:show(q?.volume24hUsd,v=>`${usd(v)} reported 24h volume`),detail:'CoinGecko aggregate trading volume. This measures reported turnover, not order-book depth or net buying.'},
    {label:'Market trend',value:trend===null?'Unavailable':`${pct(trend)} vs 200-day average`,detail:'Current quote compared with 200 consecutive daily observations. Trend describes momentum, not fair value.'},
    {label:'Modeled cost basis',value:show(premium,v=>`${v.toFixed(2)}× estimated basis`),detail:`Current quote / modeled realized price from ${date(s?.date)}. Includes a shielded-flow estimate; disabled when inputs are stale.`},
    {label:'Spending behavior',value:s?.soprSource==='transparent_spends'?show(s.sopr,v=>`${v.toFixed(3)} SOPR`):'Actual SOPR unavailable',detail:'Use observed transparent spends. A shielded pool cost-basis ratio is not a spent-output profit ratio.'},
    {label:'Adoption & supply',value:show(shieldedPct,v=>`${v.toFixed(1)}% of issued ZEC shielded`),detail:'An aggregate usage/supply observation. It does not establish market demand or justify a target price.'},
    {label:'Search attention',value:searchQuery.data?.snapshot?'Weekly CSV · unscored':'Not connected · unscored',detail:'Historical search attention, when available. Incomplete weeks are excluded; a reliable refresh feed and historical validation are needed before assigning a weight.'},
  ];
  return <>
    <PageSectionNav sections={SECTIONS} ariaLabel="Valuation sections" />
    <section id="overview" className="scroll-mt-36 mb-12">
      <div className="flex flex-wrap justify-between items-center gap-3 mb-5"><SectionHeader label="MARKET_CONTEXT" /><span className="text-caption font-mono text-muted">{fresh?'Current quote':'Quote delayed or unavailable'} · {q?.timestamp?new Date(q.sourceUpdatedAt??q.timestamp).toLocaleString('en-GB',{timeZone:'UTC',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+' UTC':'—'}</span></div>
      {quoteQuery.loading&&snapshotQuery.loading?<MetricSkeletons labels={['ZEC / USD','24h change','200-day average','365-day drawdown']} className="sm:grid-cols-2 lg:grid-cols-4" />:<div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="ZEC / USD" value={show(q?.price,usd)} hint="CoinGecko quote · checked every 30s" />
        <MetricCard label="24h change" value={show(q?.change24h,pct)} hint={fresh?'Change reported with the current quote':'Last available quote; may be delayed'} accent={finite(q?.change24h)?q.change24h>=0?'green':'orange':'default'} />
        <MetricCard label="200-day average" value={show(market.ma200,usd)} hint={`Daily price history · ${date(market.date)}`} />
        <MetricCard label="365-day drawdown" value={show(drawdown,pct)} hint="From the higher of the daily high or current quote" />
      </div>}
      <div className="grid sm:grid-cols-3 gap-4 mt-4"><MetricCard label="Reported market cap" value={show(q?.marketCapUsd,usd)} hint="CoinGecko circulating-supply definition" /><MetricCard label="Reported volume · 24h" value={show(q?.volume24hUsd,usd)} hint={fresh?"CoinGecko aggregate trading volume":"Last available quote context"} /><MetricCard label="Volume / market cap" value={positive(q?.marketCapUsd)&&finite(q?.volume24hUsd)?(q.volume24hUsd/q.marketCapUsd*100).toFixed(1)+"%":"—"} hint="Reported 24h turnover ratio" /></div>
      <div className="card card-static mt-5"><div className="card-body">
        <div className="grid md:grid-cols-[240px_minmax(0,1fr)] gap-6 pb-6"><div><p className="text-caption font-mono text-muted mb-2">VALUATION CONTEXT</p><h2 className="text-xl font-semibold">Read the signals together</h2></div><p className="text-sm text-secondary leading-relaxed">These datasets describe price, estimated cost basis and observable behavior. They do not establish that ZEC is overvalued or undervalued. A valuation verdict requires tested thresholds, independent signals and sufficient historical coverage.</p></div>
        <details className="group border-t border-cipher-border"><summary className="flex justify-between gap-4 cursor-pointer list-none py-4 rounded-sm hover:text-primary text-sm font-mono text-secondary">Signal criteria &amp; current readings<span aria-hidden="true" className="group-open:rotate-90">›</span></summary><div className="pb-3 space-y-0">{criteria.map(r=><div key={r.label} className="grid md:grid-cols-[190px_240px_minmax(0,1fr)] gap-2 md:gap-5 border-t border-cipher-border py-5"><h3 className="text-xs font-mono text-primary">{r.label}</h3><p className="text-xs font-mono text-secondary">{r.value}</p><p className="text-xs text-muted leading-relaxed">{r.detail}</p></div>)}</div></details>
      </div></div>
    </section>
    <section id="price" className="scroll-mt-36 mb-12">
      <SectionHeader label="PRICE_AND_COST_BASIS" actions={<PeriodPillTags options={PERIODS} value={period} onChange={setPeriod} aria-label="Valuation history period" />} />
      <p className="text-xs text-muted mb-5">Daily observations through {date(market.date)} · chart period {period.toUpperCase()}. The current quote above is separate from these historical series.</p>
      <ValuationChart title="Market price & modeled realized price" description="USD per ZEC. Realized price is a model of aggregate cost basis, including shielded-flow approximations." data={shown} loading={histQuery.loading} format={usd} series={[{key:'priceUsd',label:'Daily market price',color:c.gold},{key:'realizedPrice',label:'Modeled realized price',color:c.transparent,dashed:true}]} footer="Linear scale. Missing observations leave gaps. A transfer can reset modeled cost basis without a purchase or sale." />
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 my-5">
        <MetricCard label="Modeled realized price" value={show(s?.realizedPrice,usd)} hint={`${date(s?.date)}${recent?'':' · delayed snapshot'}`} />
        <MetricCard label="Daily MVRV" value={show(s?.mvrv,v=>v.toFixed(3)+'×')} hint="Market cap / modeled realized cap" />
        <MetricCard label="30-day price change" value={show(market.change30d,pct)} hint={`Daily price to ${date(market.date)}`} />
        <MetricCard label="90-day price change" value={show(market.change90d,pct)} hint={`Daily price to ${date(market.date)}`} />
      </div>
      <div className="grid xl:grid-cols-2 gap-5">
        <div id="mvrv" className="scroll-mt-36"><ValuationChart title="MVRV · modeled cost-basis multiple" description="Above 1 means market capitalization exceeds modeled realized capitalization. It is not a fair-value threshold." data={shown} series={[{key:'mvrv',label:'MVRV',color:c.gold}]} format={v=>v.toFixed(2)+'×'} loading={histQuery.loading} reference={{value:1,label:'Market cap = modeled realized cap'}} /></div>
        <div id="nupl" className="scroll-mt-36"><span id="sopr" className="scroll-mt-36" /><ValuationChart title={profitMetric==='nupl'?'NUPL · same model, percentage view':'SOPR · transparent spends'} description={profitMetric==='nupl'?'NUPL = 1 − 1/MVRV. This is another view of the same estimate, not independent confirmation.':'Observed spent-output ratio, where available. The shielded cost-basis proxy is excluded.'} data={shown} series={[{key:profitMetric,label:profitMetric.toUpperCase(),color:c.shielding}]} format={v=>profitMetric==='nupl'?`${(v*100).toFixed(0)}%`:v.toFixed(2)} loading={histQuery.loading} reference={{value:profitMetric==='nupl'?0:1,label:profitMetric==='nupl'?'Modeled break-even':'Spent value = creation value'}} controls={<PeriodPillTags options={[{key:'nupl',label:'NUPL'},{key:'sopr',label:'SOPR'}]} value={profitMetric} onChange={setProfitMetric} aria-label="Profitability metric" />} /></div>
      </div>
    </section>
    <section id="activity" className="scroll-mt-36 mb-12"><SectionHeader label="SPENDING_AND_HOLDING" /><p className="text-xs text-muted mb-5">Transparent output behavior · {period.toUpperCase()}. Shielded note ages and private transfers cannot be observed.</p><div className="grid xl:grid-cols-2 gap-5">
      <div id="hodl-waves" className="scroll-mt-36"><ValuationChart title="Unspent ZEC by output age" description="Transparent ZEC grouped by time since output creation. Output age is not the age of an owner’s position." data={agePoints} loading={ageQuery.loading||ageQuery.isRefreshing} format={v=>number(v)+' ZEC'} series={[{key:'gt2y',label:'2y+',color:c.purple,area:true,stack:true},{key:'b1_2y',label:'1–2y',color:c.sprout,area:true,stack:true},{key:'b6_12m',label:'6–12m',color:c.transparent,area:true,stack:true},{key:'b3_6m',label:'3–6m',color:c.sapling,area:true,stack:true},{key:'b1_3m',label:'1–3m',color:c.deshielding,area:true,stack:true},{key:'lt1m',label:'<1m',color:c.gold,area:true,stack:true}]} /></div>
      <div id="dormancy" className="scroll-mt-36"><ValuationChart title={ageMetric==='cdd'?'Coin-days destroyed':'Age of spent ZEC'} description={ageMetric==='cdd'?'Value moved × output age, summed per day. Spikes show older or larger outputs moving; they do not prove selling.':'Mean age per positive-value transparent output spent per day. One unit per chart keeps the scale clear.'} data={dormPoints} loading={dormQuery.loading||dormQuery.isRefreshing} format={v=>number(v)+(ageMetric==='cdd'?'':'d')} series={[{key:ageMetric,label:ageMetric==='cdd'?'ZEC-days':'Average days',color:c.deshielding,area:true}]} controls={<PeriodPillTags options={[{key:'avgDormancy',label:'AGE'},{key:'cdd',label:'CDD'}]} value={ageMetric} onChange={setAgeMetric} aria-label="Spent output age metric" />} /></div>
    </div></section>
    <section id="attention" className="scroll-mt-36 mb-12"><SectionHeader label="ADOPTION_AND_ATTENTION" /><div className="grid sm:grid-cols-2 gap-4 mb-5"><MetricCard label="Shielded share of issued supply" value={show(shieldedPct,v=>v.toFixed(1)+'%')} hint={<Link href="/pools" className="hover:underline">Latest indexed pool balances →</Link>} accent="shielded" /><MetricCard label="Shielded balance change · 7d" value={show(poolChange,v=>`${v>0?'+':''}${number(v/1e8)} ZEC`)} hint="Balance change includes public flows, issuance and migrations" /></div><SearchInterest /></section>
    <section id="methodology" className="scroll-mt-36"><details className="group rounded-lg border border-cipher-border overflow-hidden"><summary className="cursor-pointer list-none flex justify-between items-center gap-4 p-5 sm:p-6 hover:bg-glass-3"><span><span className="block text-sm font-mono">Methodology &amp; data coverage</span><span className="block mt-2 text-xs text-muted">What the estimates mean, how fresh they are, and where the model stops.</span></span><span aria-hidden="true" className="group-open:rotate-90">›</span></summary><div className="grid md:grid-cols-2 gap-8 border-t border-cipher-border p-5 sm:p-6 text-xs text-secondary leading-relaxed">
      <div><h3 className="text-sm font-semibold text-primary mb-3">Market data &amp; time windows</h3><p>The current quote comes from the app’s CoinGecko proxy, polled every 30 seconds with a 60-second server cache. Quotes older than five minutes, failed refreshes and unknown timestamps are not treated as current. Daily model snapshots have a three-day recency limit for current-price comparisons.</p><p className="mt-3">Moving averages require consecutive daily prices. Returns use exact calendar-day comparisons. A 365-day high uses daily prices rather than intraday highs. History can remain useful even when delayed; its date stays visible.</p></div>
      <div><h3 className="text-sm font-semibold text-primary mb-3">Modeled realized capitalization</h3><p>Transparent outputs are valued at their creation-day price. The historical replay reconstructs each completed UTC day’s unspent outputs from public creation and spend records. Their creation-day USD prices provide a modeled cost basis, not an owner’s purchase price. Rows awaiting replay retain their previous estimates until verified.</p><p className="mt-3">Shielded entries add value at the entry-day price. Exits remove value at the pool’s modeled average basis; migrations transfer that basis. Private transfers and individual acquisition prices are not observable. These estimates can differ from other providers.</p><p className="mt-3">Latest modeled cap: {show(s?.realizedCapUsd,usd)} · transparent {show(s?.transparentRealizedCapUsd,usd)} · shielded {show(s?.shieldedRealizedCapUsd,usd)}.</p></div>
      <div><h3 className="text-sm font-semibold text-primary mb-3">Ratios &amp; missing observations</h3><p>MVRV is market cap divided by modeled realized cap; NUPL is (market cap − realized cap) / market cap. They share the same inputs. SOPR describes observed transparent spent outputs. A modeled shielded pool cost-basis ratio is excluded because it does not measure realized spending profit.</p><p className="mt-3">Zero is a valid observation. Missing data leaves gaps and unavailable readings. A quote multiplied into a dated model does not become a newly calculated on-chain snapshot.</p></div>
      <div><h3 className="text-sm font-semibold text-primary mb-3">Analysis framework</h3><p>Cost basis, momentum, public behavior, shielded adoption and search interest provide different context. No weighted buy/sell zone is published: thresholds need Zcash-specific historical validation and coverage checks. Search interest can rise for positive or negative reasons.</p><p className="mt-3">Reported spot volume and market capitalization come from CoinGecko with the quote. Reported turnover does not measure order-book liquidity, net buying or derivatives positioning.</p><div className="flex flex-wrap gap-4 mt-4"><a href="https://research.glassnode.com/mastering-the-mvrv-ratio/" className="underline underline-offset-4">MVRV reference</a><a href="https://developers.google.com/search/apis/trends" className="underline underline-offset-4">Google Trends API</a></div></div>
    </div></details></section>
    <nav aria-label="Related valuation analysis" className="mt-8 grid sm:grid-cols-3 gap-3">{[{href:'/pools',title:'Shielded supply',text:'Pool balances and public flows.'},{href:'/privacy',title:'Privacy participation',text:'Usage and the privacy score inputs.'},{href:'/crosschain',title:'Cross-chain activity',text:'Observed swaps and venue coverage.'}].map(l=><Link key={l.href} href={l.href} className="rounded-lg border border-cipher-border p-4 hover:bg-glass-3"><span className="text-sm font-mono">{l.title} →</span><span className="block mt-2 text-xs text-muted">{l.text}</span></Link>)}</nav>
  </>;
}
