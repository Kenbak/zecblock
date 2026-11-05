import type {ResearchResult,ResearchChart} from './research-contract';
export function defaultResearchChart(result?:ResearchResult):ResearchChart;
export function suggestResearchChart(result:ResearchResult):ResearchChart;
export function fitResearchChart(result:ResearchResult|null|undefined,chart:Partial<ResearchChart>|null|undefined,units?:string[]):ResearchChart|null;
export function labelColumn(result:ResearchResult):number;
export interface ChartPoint {row:number;value:string|null;label:string|null;partial?:true}
export function partialPeriod(result:ResearchResult,x:number):number;
export type ChartHighlight=(ChartPoint&{kind:'peak'|'low'|'latest'})|(ChartPoint&{kind:'change';from:ChartPoint;delta:number;pct:number|null});
export function chartHighlight(result:ResearchResult,chart:ResearchChart):ChartHighlight|null;
export function shortLabel(value:unknown):string;
export function supportsLine(result:ResearchResult,x:number):boolean;
export function cellLink(key:string,value:string|null):string|null;
export function chartLabel(result:ResearchResult,row:(string|null)[],x:number,colourColumn?:number):string;
export function chartSeries(result:ResearchResult,x:number):{column:number;legend:{value:string;color:string}[];colorFor:(value:string|null)=>string|undefined}|null;
export function axisDateFormatter(result:ResearchResult,i:number):((value:string)=>string)|null;
export function dateFormatter(result:ResearchResult,i:number):((value:string)=>string)|null;
export function chartValues(result:ResearchResult,chart:ResearchChart):number[];
export function axisFor(result:ResearchResult,values:number[]):('left'|'right')[];
export const SERIES_COLORS:string[];
