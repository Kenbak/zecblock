/* eslint-disable @typescript-eslint/no-require-imports */
const {z}=require('zod');
const {researchIds}=require('./research-catalogue');
const when=z.string().datetime();
const column=z.object({key:z.string().regex(/^c\d{1,2}$/),label:z.string().max(128),type:z.enum(['number','boolean','text'])}).strict();
const sqlQuerySchema=z.object({version:z.literal(3),sql:z.string().trim().min(1).max(8192),limit:z.number().int().min(1).max(200)}).strict();
const researchResultSchema=z.object({query:sqlQuerySchema,columns:z.array(column).min(1).max(24),rows:z.array(z.array(z.string().max(2048).nullable()).max(24)).max(200),truncated:z.boolean(),datasets:z.array(z.enum(researchIds)).min(1).max(researchIds.length),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),retrievedAt:when,indexedThrough:when,coverage:z.string().max(200),units:z.string().max(300)}).strict().refine(r=>r.columns.every((c,i)=>c.key===`c${i}`)&&r.rows.every(row=>row.length===r.columns.length));
// series: extra value columns drawn with y on one chart (multi-line or grouped bars).
const columnIndex=z.number().int().min(0).max(23);
// stacked and highlight are presentation only; highlighted values are read from the rows, never stored.
const chartSchema=z.object({view:z.enum(['table','line','area','bar']),x:columnIndex,y:columnIndex,series:z.array(columnIndex).max(4).optional(),stacked:z.boolean().optional(),highlight:z.enum(['peak','low','latest','change']).optional()}).strict().refine(c=>!c.series||new Set([c.y,...c.series]).size===c.series.length+1,{message:'Chart value columns must be distinct.'});
const researchNarrativeSchema=z.object({question:z.string().min(1).max(8192),answer:z.string().min(1).max(12000),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),inputMode:z.enum(['ask','sql']),locale:z.string().min(1).max(35).optional()}).strict();
const documentFields={format:z.literal('zecblock-research'),id:z.string().uuid(),title:z.string().trim().min(1).max(120),notes:z.string().max(4000),query:sqlQuerySchema,chart:chartSchema,result:researchResultSchema.nullable(),savedAt:when};
// Legacy documents keep their strict field shape. Reading does not migrate or
// execute them; new saves may use v2 with a narrative bound to the same result.
const researchDocumentSchema=z.discriminatedUnion('version',[
 z.object({...documentFields,version:z.literal(1)}).strict(),
 z.object({...documentFields,version:z.literal(2),narrative:researchNarrativeSchema.optional()}).strict(),
]).refine(d=>(!d.result||(d.result.query.sql===d.query.sql&&d.result.query.limit===d.query.limit&&d.chart.x<d.result.columns.length&&d.chart.y<d.result.columns.length&&(d.chart.series||[]).every(i=>i<d.result.columns.length)))&&(!d.narrative||!!d.result&&d.narrative.fingerprint===d.result.fingerprint),{message:'Saved query, result and narrative must refer to the same analysis.'});
const researchLibrarySchema=z.object({format:z.literal('zecblock-library'),version:z.literal(1),documents:z.array(researchDocumentSchema).max(25),dashboards:z.array(z.object({id:z.string().uuid(),title:z.string().trim().min(1).max(120),items:z.array(z.string().uuid()).max(12)}).strict()).max(12)}).strict().refine(l=>new Set(l.documents.map(d=>d.id)).size===l.documents.length&&new Set(l.dashboards.map(d=>d.id)).size===l.dashboards.length&&l.dashboards.every(d=>new Set(d.items).size===d.items.length&&d.items.every(id=>l.documents.some(q=>q.id===id))));
module.exports={sqlQuerySchema,researchResultSchema,researchNarrativeSchema,researchDocumentSchema,researchLibrarySchema,chartSchema};
