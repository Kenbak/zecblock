'use strict';
// daily.orchard/ironwood/sapling/sprout are end-of-day pool balances. Summing
// them across days adds the same coins up once per day. Observed in the agent
// comparison: "is sapling dying" summed daily.sapling over 30 days and called
// the result Sapling transactions.
const STOCKS = new Set(['orchard', 'ironwood', 'sapling', 'sprout']);
const DAILY = new Set(['daily', 'daily_query']);

const lastName = fields => fields?.at(-1)?.String?.sval?.toLowerCase();
function columns(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const item of node) columns(item, out); return out; }
  if (node.ColumnRef) { const name = lastName(node.ColumnRef.fields); if (name) out.add(name); }
  for (const value of Object.values(node)) columns(value, out);
  return out;
}
// Base relations a FROM clause reads, following CTEs to their own sources.
function sources(fromClause, ctes) {
  const out = new Set();
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.RangeVar) {
      const name = node.RangeVar.relname?.toLowerCase();
      if (!node.RangeVar.schemaname && ctes.has(name)) for (const source of ctes.get(name)) out.add(source); else out.add(name);
      return;
    }
    if (node.RangeSubselect || node.SubLink) return;
    for (const value of Object.values(node)) visit(value);
  })(fromClause);
  return out;
}

function stockSumDiagnostics(tree) {
  const issues = new Set();
  (function visit(node, inherited) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) visit(item, inherited); return; }
    const select = node.SelectStmt;
    if (!select) { for (const value of Object.values(node)) visit(value, inherited); return; }
    const ctes = new Map(inherited);
    for (const item of select.withClause?.ctes || []) {
      const cte = item.CommonTableExpr;
      visit(cte.ctequery, ctes);
      ctes.set(cte.ctename.toLowerCase(), sources(cte.ctequery?.SelectStmt?.fromClause, ctes));
    }
    const readsDaily = [...sources(select.fromClause, ctes)].some(name => DAILY.has(name));
    // One daily row per date: a sum grouped by date is just that day's value.
    const perDay = (select.groupClause || []).some(item => lastName(item.ColumnRef?.fields) === 'date');
    if (readsDaily && !perDay) {
      (function find(expression) {
        if (!expression || typeof expression !== 'object') return;
        if (Array.isArray(expression)) { expression.forEach(find); return; }
        if (expression.SelectStmt) return;
        const call = expression.FuncCall;
        if (call && lastName(call.funcname) === 'sum' && !call.over) {
          for (const name of columns(call.args)) if (STOCKS.has(name)) issues.add(`daily.${name} is an end-of-day pool balance (a stock). Never SUM it across days: that counts the same coins once per day. Use the first and last observation in the window (and their change), or min, max or avg of the balance. For pool activity use flow_daily or the transactions pool flags.`);
        }
        for (const value of Object.values(expression)) find(value);
      })([select.targetList, select.havingClause]);
    }
    for (const [key, value] of Object.entries(select)) if (key !== 'withClause') visit(value, ctes);
  })(tree.stmts?.[0]?.stmt, new Map());
  return [...issues];
}

module.exports = { stockSumDiagnostics };
