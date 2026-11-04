/* eslint-disable @typescript-eslint/no-require-imports */
const { z } = require('zod');
const field = z.string().regex(/^[a-z][a-z_]{0,31}$/);
const date = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const filterSchema = z.object({ field, op: z.enum(['eq', 'ne', 'gte', 'lte']), value: z.string().min(1).max(128) }).strict();
const querySchema = z.object({ version: z.literal(2), dataset: z.enum(['daily', 'blocks', 'transactions', 'flows', 'swaps']), start: date, end: date, bucket: z.enum(['none', 'day', 'week', 'month']), dimensions: z.array(field).max(2), filters: z.array(filterSchema).max(4), measures: z.array(z.object({ field, operation: z.enum(['count', 'sum', 'avg', 'min', 'max', 'last']), filters: z.array(filterSchema).max(2) }).strict()).min(1).max(4), calculations: z.array(z.object({ operation: z.enum(['ratio', 'difference']), left: z.number().int().min(0).max(3), right: z.number().int().min(0).max(3) }).strict()).max(2), order: z.object({ column: z.number().int().min(0).max(8), direction: z.enum(['asc', 'desc']) }).strict(), limit: z.number().int().min(1).max(25) }).strict();
module.exports = { querySchema };
