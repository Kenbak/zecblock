'use strict';

const { z } = require('zod');
const { querySchema, compileQuery } = require('./ask-query-plan');
const DAY = 86400000;
const metrics = Object.freeze({
  transactions: { column: '(shielded_count::numeric + transparent_count::numeric)', label: 'Non-coinbase transactions', unit: 'transactions', kind: 'count' },
  shielded_transactions: { column: 'shielded_count::numeric', label: 'Shielded transactions', unit: 'transactions', kind: 'count' },
  transparent_transactions: { column: 'transparent_count::numeric', label: 'Transparent transactions', unit: 'transactions', kind: 'count' },
  orchard_balance: { column: 'orchard_pool_size::numeric', label: 'Orchard balance', unit: 'ZEC', kind: 'snapshot' },
  ironwood_balance: { column: 'ironwood_pool_size::numeric', label: 'Ironwood balance', unit: 'ZEC', kind: 'snapshot' },
  sapling_balance: { column: 'sapling_pool_size::numeric', label: 'Sapling balance', unit: 'ZEC', kind: 'snapshot' },
  sprout_balance: { column: 'sprout_pool_size::numeric', label: 'Sprout balance', unit: 'ZEC', kind: 'snapshot' },
});
const date = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const legacyPlanSchema = z.object({
  version: z.literal(1), metric: z.enum(Object.keys(metrics)), start: date, end: date,
  bucket: z.enum(['day', 'week', 'month']), order: z.enum(['newest', 'highest', 'lowest']), limit: z.number().int().min(1).max(25),
}).strict();
function validatePlan(input, now = Date.now()) {
  const plan = legacyPlanSchema.parse(input);
  const days = (Date.parse(plan.end) - Date.parse(plan.start)) / DAY + 1;
  // Completed UTC days only. No all-history scans or future/partial-day ranks.
  if (days < 1 || days > 366 || plan.end >= new Date(now).toISOString().slice(0, 10)) throw new Error('Invalid analytics window');
  return { plan, days, definition: metrics[plan.metric] };
}
function compilePlan(input, now, profile) {
  if(profile==='logical_public_core') return require('./ask-core-catalogue').compileCorePlan(input,now);
  if (input?.version === 2) return compileQuery(input, now);
  const { plan, days, definition } = validatePlan(input, now);
  // Every identifier/expression originates here. User/model values are bound
  // parameters; there is deliberately no raw SQL, joins or expression input.
  const bucket = { day: 'day', week: 'week', month: 'month' }[plan.bucket];
  // Qualify the numeric source: the JSON projection casts value to text, and
  // ORDER BY its output alias would otherwise rank lexicographically.
  const order = { newest: 'grouped.bucket DESC', highest: 'grouped.value DESC, grouped.bucket DESC', lowest: 'grouped.value ASC, grouped.bucket DESC' }[plan.order];
  const observed = `SELECT date, ${definition.column} AS value, pg_catalog.date_trunc('${bucket}', date::timestamp)::date AS bucket
    FROM ask_public.daily_v1 WHERE date >= $1::date AND date <= $2::date`;
  const grouped = definition.kind === 'count'
    ? 'SELECT bucket, sum(value) AS value, count(*)::int AS observed_days, max(date) AS observed_through FROM observed GROUP BY bucket'
    : 'SELECT DISTINCT ON (bucket) bucket, value, count(*) OVER (PARTITION BY bucket)::int AS observed_days, date AS observed_through FROM observed ORDER BY bucket, date DESC';
  return { plan, days, definition, text: `WITH observed AS (${observed}), grouped AS (${grouped})
    SELECT bucket::text, value::text, observed_days, observed_through::text FROM grouped ORDER BY ${order} LIMIT $3::int`, values: [plan.start, plan.end, plan.limit] };
}
const planSchema = z.union([legacyPlanSchema, querySchema]);
module.exports = { planSchema, legacyPlanSchema, metrics, validatePlan, compilePlan };
