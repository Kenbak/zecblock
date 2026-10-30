'use strict';
// Follow-up memory. After each answer the server writes a small typed scope of
// what actually ran (datasets, measures, pools, date window, grain, subject).
// The client sends it back with the next question and the agent reads it to
// resolve "and in August?" or "just Orchard". It is built only from the
// compiled SQL, its result columns or a preset chart spec, never from
// question text or cell values, and is schema-checked in both directions.
const { parse } = require('pgsql-parser');
const { turnScopeSchema, scopePools } = require('../../../../lib/ask/chat');
const { researchIds } = require('../../../../lib/ask/research-catalogue');
const { windowBounds } = require('./ask-research-reply');

const label = /^[a-z][a-z0-9_]{0,47}$/;
const timeLabel = /^(?:date|day|week|month|year|period|bucket|week_start|month_start|height|timestamp)$/;
const empty = { version: 1, datasets: [], measures: [], pools: [], window: null, period: null, grain: null, metric: null, subject: null };
const checked = value => { const parsed = turnScopeSchema.safeParse(value); return parsed.success ? parsed.data : undefined; };

function outputNames(tree) {
  const select = tree?.stmts?.[0]?.stmt?.SelectStmt;
  return (select?.targetList || []).map(target => target.ResTarget?.name || target.ResTarget?.val?.ColumnRef?.fields?.at(-1)?.String?.sval).filter(Boolean);
}

// columns: result columns when the query has run; a queued job has only its SQL.
async function sqlScope({ sql, datasets = [], columns = null }) {
  let tree = null;
  try { tree = await parse(sql); } catch { /* scope without parsed facts */ }
  const names = (columns ? columns.map(column => column.label) : outputNames(tree)).map(name => String(name).toLowerCase());
  const measures = [...new Set(names.filter(name => label.test(name)))].slice(0, 6);
  const numeric = columns ? columns.filter(column => column.type === 'number').map(column => String(column.label).toLowerCase()) : measures;
  const text = sql.toLowerCase();
  const bounds = tree ? windowBounds(tree) : null;
  const trunc = /date_trunc\(\s*'(day|week|month|year)'/.exec(text)?.[1];
  const grain = trunc || (/'yyyy-mm-dd'/.test(text) || names.includes('date') ? 'day' : null);
  return checked({
    ...empty, kind: 'sql',
    datasets: [...new Set(datasets)].filter(id => researchIds.includes(id)).slice(0, 6),
    measures,
    // Pool names the SQL itself filters or selects: a column, alias or literal.
    pools: scopePools.filter(pool => new RegExp(`(?<![a-z0-9_])${pool}(?![a-z0-9])`).test(text)),
    window: bounds ? { start: bounds[0], end: bounds.at(-1) } : null,
    grain,
    subject: numeric.find(name => label.test(name) && !timeLabel.test(name)) || null,
  });
}

function chartScope(spec) {
  return checked({ ...empty, kind: 'chart', metric: spec.metric, period: spec.period, pools: spec.pool === 'all' ? [] : [spec.pool], grain: 'day', window: spec.start && spec.end && spec.start < spec.end ? { start: spec.start, end: spec.end } : null });
}

// The scope of a finished reply, or undefined for prose-only answers.
async function turnScopeFor(reply) {
  if (reply.turnScope) return checked(reply.turnScope);
  try {
    if (reply.research) return await sqlScope({ sql: reply.research.query.sql, datasets: reply.research.datasets, columns: reply.research.columns });
    if (reply.spec) return chartScope(reply.spec);
    if (reply.blocks?.rows?.length) return checked({ ...empty, kind: 'block' });
    if (reply.transactions?.rows?.length) return checked({ ...empty, kind: 'transaction' });
  } catch { /* a reply never fails for want of a scope */ }
  return undefined;
}

module.exports = { sqlScope, chartScope, turnScopeFor };
