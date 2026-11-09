'use client';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { ValuationChart } from './ValuationChart';
import { useApiQuery } from '@/hooks/useApiQuery';
interface SearchSnapshot { capturedAt:string; importedAt:string; points:{date:string;value:number|null;belowOne:boolean;partial:boolean}[] }


export const GOOGLE_TRENDS_URL = 'https://trends.google.com/trends/explore?date=today%2012-m&q=zcash&hl=en';

export function SearchInterest() {
  const { theme } = useTheme(); const c = getChartColors(theme);
  const {data,loading,error}=useApiQuery<{snapshot:SearchSnapshot|null}>('/v1/valuation/search-interest',undefined,{refreshInterval:300_000});
  const trends=data?.snapshot;
  const complete = (trends?.points??[]).filter(p => !p.partial);
  const latest = complete.at(-1);
  const partial = (trends?.points??[]).find(p => p.partial);
  // Connect the provisional segment to the last complete week without treating it as complete.
  const chartData = (trends?.points??[]).map(p => ({date:p.date, interest:p.partial?null:p.value, provisional:p.partial||p.date===latest?.date?p.value:null}));
  return <ValuationChart
    title="Search interest in “zcash”"
    description="Worldwide · Weekly relative search interest (0–100)."
    data={chartData} loading={loading} format={v=>v.toFixed(0)} domain={[0,100]} intervalDays={7}
    series={[{key:'interest',label:'Completed weeks',color:c.gold},{key:'provisional',label:'Incomplete week',color:c.transparent,dashed:true}]}
    controls={<a href={GOOGLE_TRENDS_URL} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-secondary">Open Google Trends ↗</a>}
    footer={<><a href={GOOGLE_TRENDS_URL} className="underline underline-offset-4">Google Trends</a>{trends ? <>{partial && ' · Incomplete week'}{error && ' · Refresh delayed'}</> : !loading && ' · Snapshot unavailable'}</>}
  />;
}
