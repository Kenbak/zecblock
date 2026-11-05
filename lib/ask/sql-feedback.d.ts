import type {ZodType} from 'zod';
export interface SQLFeedback {stage:'syntax'|'policy'|'database'|'cost';message:string;hint?:string;code?:string;line?:number;column?:number}
export const sqlFeedbackSchema:ZodType<SQLFeedback>;
export function policyFeedback(error:unknown,sql:string):SQLFeedback|null;
export function databaseFeedback(error:unknown):SQLFeedback|null;
export function costFeedback(estimate:number,budget:number):SQLFeedback;
export function lineColumn(sql:string,position:number):{line?:number;column?:number};
export const USER_CODES:ReadonlySet<string>;
