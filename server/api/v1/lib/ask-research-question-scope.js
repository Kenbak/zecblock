'use strict';
// Draft checks that compare AI-written SQL with the question it answers.
// Observed on staging: an Orchard question was answered from all shielded
// transactions, and a "last 7 days" window ended after today.
const POOLS = ['orchard', 'ironwood', 'sapling', 'sprout'];
const POOL_SOURCES = {
  orchard: 'count(*) FILTER (WHERE orchard) on transactions, daily.orchard for pool balances, or flows/flow_daily with pool = \'orchard\'',
  ironwood: 'count(*) FILTER (WHERE ironwood) on transactions, daily.ironwood for pool balances, or flows/flow_daily with pool = \'ironwood\'',
  sapling: 'count(*) FILTER (WHERE sapling) on transactions, daily.sapling for pool balances, or flows/flow_daily with pool = \'sapling\'',
  sprout: 'daily.sprout for pool balances',
};

function words(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const item of node) words(item, out); return out; }
  if (node.ColumnRef) for (const field of node.ColumnRef.fields || []) if (field.String) out.add(field.String.sval.toLowerCase());
  if (node.A_Const?.sval) out.add(String(node.A_Const.sval.sval).toLowerCase());
  for (const value of Object.values(node)) words(value, out);
  return out;
}
function literals(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const item of node) literals(item, out); return out; }
  if (typeof node.A_Const?.sval?.sval === 'string') out.push(node.A_Const.sval.sval);
  for (const value of Object.values(node)) literals(value, out);
  return out;
}

// A question that names a pool must be answered from that pool's data.
function poolQuestionDiagnostics(tree, question) {
  const asked = POOLS.filter(pool => new RegExp(`\\b${pool}\\b`, 'i').test(question || ''));
  if (!asked.length) return [];
  const used = [...words(tree.stmts?.[0]?.stmt)];
  return asked.filter(pool => !used.some(word => word.includes(pool))).map(pool => `The question asks about ${pool[0].toUpperCase() + pool.slice(1)}, but the query never uses ${pool} data. activity_daily has no per-pool counts. Use ${POOL_SOURCES[pool]}, bounded by the requested dates; do not substitute all shielded activity.`);
}

// "Last N days" ends at today's UTC midnight; only questions about today or a
// current calendar period ("this month") may reach past it. Open-ended year or
// month bounds in other questions are harmless and left alone.
const RECENT = /\b(?:last|past|previous|prior)\s+(?:\d+|one|two|three|four|five|six|seven|ten|fourteen|thirty|ninety)?\s*(?:days?|weeks?)\b/i;
const CURRENT = /\b(?:today|tonight|so far|right now|currently|current (?:day|week|month|year)|this (?:day|week|month|quarter|year)|year[- ]to[- ]date|month[- ]to[- ]date|ytd)\b/i;
function futureWindowDiagnostics(tree, question, now = new Date()) {
  if (!RECENT.test(question || '') || CURRENT.test(question || '')) return [];
  const today = now.toISOString().slice(0, 10);
  const late = literals(tree.stmts?.[0]?.stmt).map(text => /^(\d{4}-\d{2}-\d{2})/.exec(text.trim())?.[1]).filter(date => date && date > today);
  return late.length ? [`The time window ends on ${late.sort().at(-1)}, after today (${today}). "Last N days" means the N most recent completed UTC days: timestamp >= today minus N days AND timestamp < today at 00:00 UTC. Do not include today's partial day unless the question asks about today.`] : [];
}

// A column that no source of its SELECT can provide fails in PostgreSQL with
// 42703 after the draft has been spent (observed: orchard read from a daily
// summary). Only SELECTs whose sources are all catalogue datasets are checked;
// CTEs, subselects and correlated subqueries are left to the database.
const { researchCatalogue } = require('../../../../lib/ask/research-catalogue');
const datasetColumns = new Map(researchCatalogue.flatMap(d => { const cols = new Set(d.columns.split(', ')); return [[d.id, { id: d.id, cols }], [`${d.id}_query`, { id: d.id, cols }]]; }));
function sources(from, out) {
  for (const item of from || []) {
    if (item.RangeVar) { const ds = datasetColumns.get(item.RangeVar.relname); if (!ds || item.RangeVar.schemaname && item.RangeVar.schemaname !== 'analytics_public' || item.RangeVar.alias?.colnames) return false; out.set(item.RangeVar.alias?.aliasname || item.RangeVar.relname, ds); }
    else if (item.JoinExpr) { if (item.JoinExpr.usingClause || !sources([item.JoinExpr.larg, item.JoinExpr.rarg], out)) return false; }
    else return false;
  }
  return true;
}
function refs(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const item of node) refs(item, out); return out; }
  if (node.SubLink || node.SelectStmt) return out;
  if (node.ColumnRef) { const path = (node.ColumnRef.fields || []).map(f => f.String?.sval); if (path.every(Boolean)) out.push(path); return out; }
  for (const value of Object.values(node)) refs(value, out);
  return out;
}
function columnDiagnostics(tree) {
  const issues = [], ctes = new Set();
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    const s = node.SelectStmt;
    if (s) {
      for (const item of s.withClause?.ctes || []) ctes.add(item.CommonTableExpr?.ctename);
      const scope = new Map();
      if (s.fromClause?.length && sources(s.fromClause, scope) && ![...scope.keys()].some(name => ctes.has(name) && !datasetColumns.has(name))) {
        const aliases = new Set((s.targetList || []).map(t => t.ResTarget?.name).filter(Boolean));
        const all = [...scope.values()];
        const parts = [s.targetList, s.whereClause, s.havingClause, s.windowClause].map(part => refs(part, [])).flat().concat([s.groupClause, s.sortClause].map(part => refs(part, [])).flat().filter(path => path.length > 1 || !aliases.has(path[0])));
        for (const path of parts) {
          const [qualifier, name] = path.length === 2 ? path : [null, path[0]];
          if (path.length > 2 || qualifier && !scope.has(qualifier)) continue;
          const owners = qualifier ? [scope.get(qualifier)] : all;
          if (!owners.some(ds => ds.cols.has(name))) issues.push(`Column ${name} does not exist in ${owners.map(ds => `${ds.id}(${[...ds.cols].join(', ')})`).join(' or ')}. Use only those columns${name === 'orchard' || name === 'sapling' || name === 'ironwood' ? `; per-pool transaction counts need count(*) FILTER (WHERE ${name}) on transactions` : ''}.`);
        }
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(tree.stmts?.[0]?.stmt);
  return [...new Set(issues)];
}

module.exports = { poolQuestionDiagnostics, futureWindowDiagnostics, columnDiagnostics };
