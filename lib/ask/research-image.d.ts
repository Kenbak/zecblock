import type {ResearchChart,ResearchResult} from './research-contract';
export interface PlotMarkup {width:number;height:number;markup:string}
export interface CardLegendItem {value:string;color:string}
export const WIDTH:number;
export const HEIGHT:number;
export const SCALE:number;
export const FOOTER_URL:string;
export const DARK:Record<string,string>;
export function resolveColors(markup:string):string;
export function titleLines(text:string,max?:number,lines?:number):string[];
export function dataWindow(result:ResearchResult,chart:ResearchChart):string|null;
export function cardTitle(result:ResearchResult,chart:ResearchChart,title?:string|null):string;
export function cardLegend(result:ResearchResult,chart:ResearchChart):CardLegendItem[];
export function cardSVG(card:{title:string;window:string|null;legend?:CardLegendItem[];plot?:PlotMarkup|null}):string;
export function researchCard(result:ResearchResult,chart:ResearchChart,title:string|null|undefined,plot:PlotMarkup|null):string;
export function imageName(title:string):string;
export function downloadChartImage(svg:SVGSVGElement,result:ResearchResult,chart:ResearchChart,title?:string|null):Promise<void>;
