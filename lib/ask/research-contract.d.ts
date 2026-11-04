import type {ZodType} from 'zod';
export interface ResearchQuery {version:3;sql:string;limit:number}
export interface ResearchResult {query:ResearchQuery;columns:{key:string;label:string;type:'number'|'boolean'|'text'}[];rows:(string|null)[][];truncated:boolean;datasets:string[];fingerprint:string;retrievedAt:string;indexedThrough:string;coverage:string;units:string}
export type ResearchHighlight='peak'|'low'|'latest'|'change';
export interface ResearchChart {view:'table'|'line'|'area'|'bar';x:number;y:number;series?:number[];stacked?:boolean;highlight?:ResearchHighlight}
export interface ResearchNarrative {question:string;answer:string;fingerprint:string;inputMode:'ask'|'sql';locale?:string}
interface ResearchDocumentFields {format:'zecblock-research';id:string;title:string;notes:string;query:ResearchQuery;chart:ResearchChart;result:ResearchResult|null;savedAt:string}
export type ResearchDocument = ResearchDocumentFields & ({version:1;narrative?:never}|{version:2;narrative?:ResearchNarrative});
export interface ResearchLibrary {format:'zecblock-library';version:1;documents:ResearchDocument[];dashboards:{id:string;title:string;items:string[]}[]}
export const sqlQuerySchema:ZodType<ResearchQuery>;
export const researchResultSchema:ZodType<ResearchResult>;
export const researchNarrativeSchema:ZodType<ResearchNarrative>;
export const researchDocumentSchema:ZodType<ResearchDocument>;
export const researchLibrarySchema:ZodType<ResearchLibrary>;
export const chartSchema:ZodType<ResearchChart>;
