/* eslint-disable @typescript-eslint/no-require-imports */
const {z}=require('zod');
const {researchResultSchema}=require('./research-contract');
const {sqlQuotaSchema}=require('./quota-contract');
// Optional: older API builds must be upgraded before workers emit `sql`.
const {sqlFeedbackSchema}=require('./sql-feedback');
const jobTicketSchema=z.object({id:z.string().uuid(),token:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const jobStatusSchema=z.object({id:z.string().uuid(),state:z.enum(['queued','running','succeeded','failed','cancelled']),createdAt:z.string().datetime(),startedAt:z.string().datetime().nullable(),finishedAt:z.string().datetime().nullable(),queuePosition:z.number().int().min(0).max(6),maxRunSeconds:z.literal(30),error:z.enum(['timeout','resource','query','source','dataset','quota','unavailable','interrupted']).nullable(),quota:sqlQuotaSchema.optional(),sql:sqlFeedbackSchema.optional(),result:researchResultSchema.nullable()}).strict().refine(j=>(j.state==='succeeded')===!!j.result).refine(j=>!j.quota||j.state==='failed'&&j.error==='quota').refine(j=>!j.sql||j.state==='failed'&&['query','resource'].includes(j.error));
module.exports={jobTicketSchema,jobStatusSchema};
