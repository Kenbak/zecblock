import type {ZodType} from 'zod';
import type {ResearchResult} from './research-contract';
import type {SQLFeedback} from './sql-feedback';
export interface ResearchJobTicket {id:string;token:string}
export interface ResearchJobStatus {id:string;state:'queued'|'running'|'succeeded'|'failed'|'cancelled';createdAt:string;startedAt:string|null;finishedAt:string|null;queuePosition:number;maxRunSeconds:30;error:'timeout'|'resource'|'query'|'source'|'dataset'|'quota'|'unavailable'|'interrupted'|null;quota?:{code:'ask-sql-global-day'|'ask-sql-busy'|'ask-sql-queue'|'ask-sql-visitor';retryAfter:number};sql?:SQLFeedback;result:ResearchResult|null}
export const jobTicketSchema:ZodType<ResearchJobTicket>;
export const jobStatusSchema:ZodType<ResearchJobStatus>;
