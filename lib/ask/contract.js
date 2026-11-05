/* Shared, side-effect-free contract used by the browser and native v1 handler. */
/* eslint-disable @typescript-eslint/no-require-imports */
const { z } = require('zod');

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const metricIds = ['balances', 'flows', 'activity', 'swap_volume', 'swap_count', 'transactions', 'pulse', 'migration_share', 'chain_inflows', 'chain_outflows'];
const analysisSchema = z.object({
  version: z.literal(1),
  metric: z.enum(metricIds),
  period: z.enum(['30d', '90d', '1y']),
  pool: z.enum(['all', 'orchard', 'ironwood', 'sapling']),
  view: z.enum(['line', 'bar', 'table']),
  start: date.nullable(),
  end: date.nullable(),
}).strict().refine(spec => !spec.start || !spec.end || spec.start <= spec.end)
  .refine(spec => ['balances', 'flows', 'activity'].includes(spec.metric) || spec.pool === 'all')
  .refine(spec => !spec.metric.startsWith('swap_') || spec.period !== '1y')
  .refine(spec => !spec.metric.startsWith('chain_') || (spec.period === '30d' && spec.view !== 'line' && spec.start === null && spec.end === null));
const requestSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  context: analysisSchema.nullable(),
  challenge: z.string().max(2048).optional(),
}).strict();

const starters = [
  { id: 'balances', category: 'Shielded supply', title: 'How much ZEC is in shielded pools?', detail: 'Explore daily balances across the pools.', spec: { version: 1, metric: 'balances', period: '30d', pool: 'all', view: 'line' } },
  { id: 'compare', category: 'Pool comparison', title: 'Compare shielded pool balances', detail: 'Follow each pool over the last 90 days.', spec: { version: 1, metric: 'balances', period: '90d', pool: 'all', view: 'line' } },
  { id: 'flows', category: 'Public flows', title: 'How much ZEC enters and leaves shielded pools?', aliases: ['How much ZEC is entering and leaving?'], detail: 'Compare public shielding and deshielding.', spec: { version: 1, metric: 'flows', period: '30d', pool: 'all', view: 'bar' } },
  { id: 'activity', category: 'Activity', title: 'How active are public pool flows?', detail: 'Explore daily shielding and deshielding counts.', spec: { version: 1, metric: 'activity', period: '30d', pool: 'all', view: 'bar' } },
  { id: 'ironwood-balance', category: 'Ironwood', title: 'How has the Ironwood pool grown?', detail: 'Compare daily balances over the past 90 days.', spec: { version: 1, metric: 'balances', period: '90d', pool: 'ironwood', view: 'line' } },
  { id: 'ironwood-flows', category: 'Ironwood', title: 'How much ZEC is shielding into and deshielding from Ironwood?', detail: 'Public transparent-boundary flows, not all migration.', spec: { version: 1, metric: 'flows', period: '30d', pool: 'ironwood', view: 'bar' } },
  { id: 'ironwood-activity', category: 'Ironwood', title: 'How active are Ironwood public flows?', detail: 'Daily public flow records, not private payment counts.', spec: { version: 1, metric: 'activity', period: '30d', pool: 'ironwood', view: 'bar' } },
  { id: 'migration-share', category: 'Ironwood', title: 'How far has the Orchard to Ironwood migration progressed?', detail: 'Ironwood’s share of the combined pool balance over time.', spec: { version: 1, metric: 'migration_share', period: '90d', pool: 'all', view: 'line' } },
  { id: 'chain-inflows', category: 'Cross-chain', title: 'Which chains bring the most swap volume into ZEC?', detail: 'Rank source chains by tracked USD volume over 30 days.', spec: { version: 1, metric: 'chain_inflows', period: '30d', pool: 'all', view: 'bar' } },
  { id: 'chain-outflows', category: 'Cross-chain', title: 'Which chains receive the most swap volume from ZEC?', detail: 'Rank destination chains by tracked USD volume over 30 days.', spec: { version: 1, metric: 'chain_outflows', period: '30d', pool: 'all', view: 'bar' } },
  { id: 'swap-volume', category: 'Cross-chain', title: 'How much tracked swap volume enters and exits ZEC?', detail: 'USD value of indexed successful cross-chain swaps.', spec: { version: 1, metric: 'swap_volume', period: '30d', pool: 'all', view: 'bar' } },
  { id: 'swap-count', category: 'Cross-chain', title: 'Are there more swaps into ZEC or out of ZEC?', detail: 'Compare indexed successful swap counts over 90 days.', spec: { version: 1, metric: 'swap_count', period: '90d', pool: 'all', view: 'bar' } },
  { id: 'transactions', category: 'Network', title: 'How has shielded and transparent transaction activity changed?', detail: 'Daily transaction categories from the privacy dataset.', spec: { version: 1, metric: 'transactions', period: '30d', pool: 'all', view: 'line' } },
  { id: 'busiest-day', category: 'Network', title: 'What was the busiest day for Zcash in the last year?', aliases: ['What was the busiest day for Zcash over the past year?', 'Which day had the most Zcash transactions in the last year?'], detail: 'Compare combined daily transaction counts across completed UTC days.', spec: { version: 1, metric: 'transactions', period: '1y', pool: 'all', view: 'line' } },
  { id: 'pulse', category: 'Network', title: 'When did Network Pulse detect unusual activity?', detail: 'Recorded daily alerts grouped by severity.', spec: { version: 1, metric: 'pulse', period: '30d', pool: 'all', view: 'bar' } },
].map(starter => ({ ...starter, spec: { ...starter.spec, start: null, end: null } }));

// Only exact, advertised shortcuts bypass the model. A keyword match must
// never silently reinterpret a different question as a supported analysis.
function resolveShortcut(question, context = null) {
  const normalized = question.trim().toLowerCase().replace(/[?.!]+$/, '');
  const starter = starters.find(item => [item.title, ...(item.aliases || [])].some(title => title.toLowerCase().replace(/[?.!]+$/, '') === normalized));
  if (starter) return { ...starter.spec };
  if (!context || !analysisSchema.safeParse(context).success) return null;
  const periods = { 'show 30 days': '30d', 'show 90 days': '90d', 'show one year': '1y' };
  if (periods[normalized]) {
    const next = { ...context, period: periods[normalized], start: null, end: null };
    return analysisSchema.safeParse(next).success ? next : null;
  }
  if (['show as a table', 'show as a line chart', 'show as a bar chart'].includes(normalized)) {
    const next = { ...context, view: normalized === 'show as a table' ? 'table' : normalized === 'show as a line chart' ? 'line' : 'bar' };
    return analysisSchema.safeParse(next).success ? next : null;
  }
  const pool = ['orchard', 'ironwood', 'sapling'].find(value => normalized === `just ${value}`);
  return pool && ['balances', 'flows', 'activity'].includes(context.metric) ? { ...context, pool } : null;
}

module.exports = { analysisSchema, metricIds, requestSchema, starters, resolveShortcut };
