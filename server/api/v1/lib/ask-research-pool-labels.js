'use strict';
// AI-drafted SQL must not relabel a measure as a specific pool. A result
// column named after a pool (orchard_transactions, ironwood_share…) has to be
// computed from that pool: one of its columns/flags, a filter naming it, or a
// CTE column that itself satisfies this rule. Observed on staging: an Orchard
// question returned activity_daily.shielded_transactions AS orchard_transactions.
const POOLS = ['orchard', 'ironwood', 'sapling', 'sprout'];
const poolsIn = name => POOLS.filter(pool => String(name || '').toLowerCase().includes(pool));

// Column names and string literals anywhere inside a node.
function evidence(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const item of node) evidence(item, out); return out; }
  if (node.ColumnRef) for (const field of node.ColumnRef.fields || []) if (field.String) out.add(field.String.sval.toLowerCase());
  if (node.A_Const?.sval) out.add(String(node.A_Const.sval.sval).toLowerCase());
  for (const [key, value] of Object.entries(node)) if (key !== 'ColumnRef') evidence(value, out);
  return out;
}

function poolLabelDiagnostics(tree) {
  const issues = new Set();
  // CTE output columns by name → the words that justify them (expression + that CTE's WHERE).
  const cteColumns = new Map();
  function visit(node, inheritedCTEs) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) visit(item, inheritedCTEs); return; }
    const select = node.SelectStmt;
    if (select) {
      for (const item of select.withClause?.ctes || []) {
        const cte = item.CommonTableExpr; visit(cte.ctequery, inheritedCTEs);
        const inner = cte.ctequery?.SelectStmt;
        const where = evidence(inner?.whereClause);
        for (const target of inner?.targetList || []) {
          const res = target.ResTarget; if (!res) continue;
          const name = res.name || res.val?.ColumnRef?.fields?.at(-1)?.String?.sval;
          if (name) cteColumns.set(name.toLowerCase(), new Set([...evidence(res.val), ...where, ...justified(res.val)]));
        }
      }
      const where = evidence(select.whereClause);
      for (const target of select.targetList || []) {
        const res = target.ResTarget; if (!res?.name) continue;
        for (const pool of poolsIn(res.name)) {
          const words = new Set([...evidence(res.val), ...where, ...justified(res.val)]);
          if (![...words].some(word => word.includes(pool))) issues.add(`Result column ${res.name} is labelled ${pool} but is not computed from ${pool} data. A column named after a pool must use that pool's own column or flag (for example transactions.${pool === 'sprout' ? 'shielded' : pool}, daily.${pool}, or a filter such as pool = '${pool}'). activity_daily.shielded_transactions counts all shielded pools combined; use count(*) FILTER (WHERE ${pool === 'sprout' ? 'shielded' : pool}) on transactions for per-pool transaction counts, or name the column shielded_*.`);
        }
      }
      for (const [key, value] of Object.entries(select)) if (key !== 'withClause' && key !== 'targetList') visit(value, inheritedCTEs);
      return;
    }
    for (const value of Object.values(node)) visit(value, inheritedCTEs);
  }
  // Words carried by CTE columns this expression references.
  function justified(expression) {
    const out = new Set();
    for (const name of evidence(expression)) for (const word of cteColumns.get(name) || []) out.add(word);
    return out;
  }
  visit(tree.stmts?.[0]?.stmt);
  return [...issues];
}

module.exports = { poolLabelDiagnostics };
