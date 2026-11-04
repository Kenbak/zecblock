'use strict';
// AI-draft quality only. Unknown lineage remains queryable; no SQL is rewritten.
const strictFunctions = new Set(['abs', 'round', 'ceil', 'ceiling', 'floor', 'trunc', 'sqrt']);
const ranks = new Set(['row_number', 'rank', 'dense_rank']);
const arithmetic = new Set(['+', '-', '*', '/', '%']);
const diagnostic = 'A lag/lead-derived nullable change is the primary descending ranking key with omitted null ordering. PostgreSQL DESC defaults to NULLS FIRST, so an unavailable boundary change can receive rank one. Use explicit DESC NULLS LAST when ranking known changes, or preserve each row\'s change instead of exposing it only for rank one. Preserve the requested measures, dates, filters and per-row results; explicit intentional NULLS FIRST remains valid.';
const reference = node => node?.ColumnRef?.fields?.map(field => field.String?.sval);
const functionName = node => node?.funcname?.at(-1)?.String?.sval;
const unwrap = node => node?.TypeCast ? unwrap(node.TypeCast.arg) : node;
const terms = node => node?.BoolExpr?.boolop === 'AND_EXPR' ? node.BoolExpr.args.flatMap(terms) : [node];
function nullRankingDiagnostics(tree) {
  const issues = new Set(); let visited = 0;
  function select(statement, inherited = new Map(), depth = 0) {
    if (!statement || depth > 32 || ++visited > 12000) return new Map();
    const scope = new Map(inherited);
    const rename = (columns, names) => names?.length ? new Map([...columns].map(([name, value], i) => [names[i]?.String?.sval || name, value])) : columns;
    for (const item of statement.withClause?.ctes || []) {
      const cte = item.CommonTableExpr;
      if (cte) scope.set(cte.ctename, rename(select(cte.ctequery?.SelectStmt, scope, depth + 1), cte.aliascolnames));
    }
    if (statement.op && statement.op !== 'SETOP_NONE') {
      select(statement.larg, scope, depth + 1); select(statement.rarg, scope, depth + 1);
      return new Map();
    }
    const source = node => {
      if (node.JoinExpr) return [...source(node.JoinExpr.larg), ...source(node.JoinExpr.rarg)];
      if (node.RangeVar) {
        const range = node.RangeVar;
        return [{ alias: range.alias?.aliasname || range.relname, columns: rename(!range.schemaname && scope.get(range.relname) || new Map(), range.alias?.colnames) }];
      }
      if (node.RangeSubselect) {
        const range = node.RangeSubselect;
        return [{ alias: range.alias?.aliasname, columns: rename(select(range.subquery?.SelectStmt, scope, depth + 1), range.alias?.colnames) }];
      }
      return [];
    };
    const sources = (statement.fromClause || []).flatMap(source);
    const simple = sources.length === 1 && !statement.fromClause?.[0]?.JoinExpr && !statement.groupClause?.length && !statement.withClause?.recursive;
    const columnName = node => {
      const path = reference(node);
      return simple && path?.length && path.length <= 2 && path.every(Boolean) && (path.length === 1 || path[0] === sources[0].alias) ? path.at(-1) : null;
    };
    const strictExpression = node => node?.A_Expr?.kind === 'AEXPR_OP' && arithmetic.has(node.A_Expr.name?.[0]?.String?.sval);
    function key(node) {
      if (!node) return null;
      if (node.TypeCast) return key(node.TypeCast.arg);
      const name = columnName(node); if (name) return 'column:' + name;
      if (node.A_Const) return JSON.stringify(node.A_Const);
      if (strictExpression(node)) {
        const expr = node.A_Expr, left = expr.lexpr ? key(expr.lexpr) : '', right = key(expr.rexpr);
        return left !== null && right !== null ? expr.name[0].String.sval + '(' + left + ',' + right + ')' : null;
      }
      if (node.FuncCall && strictFunctions.has(functionName(node.FuncCall))) {
        const args = (node.FuncCall.args || []).map(key);
        return args.every(value => value !== null) ? functionName(node.FuncCall) + '(' + args.join(',') + ')' : null;
      }
      return null;
    }
    const nonnull = new Set();
    function markNonnull(node) {
      const value = key(node); if (value !== null) nonnull.add(value);
      if (node?.TypeCast) markNonnull(node.TypeCast.arg);
      else if (strictExpression(node)) {
        if (node.A_Expr.lexpr) markNonnull(node.A_Expr.lexpr);
        markNonnull(node.A_Expr.rexpr);
      } else if (node?.FuncCall && strictFunctions.has(functionName(node.FuncCall))) {
        for (const arg of node.FuncCall.args || []) markNonnull(arg);
      }
    }
    for (const term of terms(statement.whereClause)) if (term?.NullTest?.nulltesttype === 'IS_NOT_NULL') markNonnull(term.NullTest.arg);
    function nullableLag(node) {
      if (!simple || !node || ++visited > 12000 || nonnull.has(key(node))) return false;
      if (node.TypeCast) return nullableLag(node.TypeCast.arg);
      const name = columnName(node); if (name) return sources[0].columns.get(name) === true;
      if (strictExpression(node)) return nullableLag(node.A_Expr.lexpr) || nullableLag(node.A_Expr.rexpr);
      const call = node.FuncCall;
      if (!call) return false;
      const nameOfCall = functionName(call);
      if (['lag', 'lead'].includes(nameOfCall) && call.over) {
        const offset = call.args?.[1] ? unwrap(call.args[1])?.A_Const?.ival?.ival ?? (unwrap(call.args[1])?.A_Const?.ival ? 0 : null) : 1;
        const fallback = call.args?.[2];
        return Number.isInteger(offset) && offset !== 0 && (!fallback || unwrap(fallback)?.A_Const?.isnull === true);
      }
      return strictFunctions.has(nameOfCall) && !call.over && !call.agg_filter && (call.args || []).some(nullableLag);
    }
    const windows = new Map((statement.windowClause || []).map(item => [item.WindowDef?.name, item.WindowDef]));
    function inspect(node) {
      if (!node || typeof node !== 'object' || ++visited > 12000) return;
      if (node.SelectStmt) { select(node.SelectStmt, scope, depth + 1); return; }
      const call = node.FuncCall;
      if (call && ranks.has(functionName(call)) && call.over) {
        const window = call.over.orderClause?.length ? call.over : windows.get(call.over.name || call.over.refname);
        const sort = window?.orderClause?.[0]?.SortBy;
        if (sort?.sortby_dir === 'SORTBY_DESC' && (!sort.sortby_nulls || sort.sortby_nulls === 'SORTBY_NULLS_DEFAULT') && nullableLag(sort.node)) issues.add(diagnostic);
      }
      for (const child of Object.values(node)) inspect(child);
    }
    for (const [name, node] of Object.entries(statement)) if (!['withClause', 'fromClause', 'larg', 'rarg'].includes(name)) inspect(node);
    const columns = new Map();
    function put(name, value) { if (name) columns.set(name, columns.has(name) ? null : value); }
    for (const item of statement.targetList || []) {
      const target = item.ResTarget, fields = target?.val?.ColumnRef?.fields;
      if (simple && fields?.at(-1)?.A_Star && (fields.length === 1 || fields[0]?.String?.sval === sources[0].alias)) {
        for (const [name, value] of sources[0].columns) put(name, value === true && nullableLag({ ColumnRef: { fields: [{ String: { sval: name } }] } }));
      // Keep unnamed positions for an enclosing CTE/derived column-alias list.
      // The sentinel cannot be a compiler-admitted column identifier.
      } else put(target?.name || reference(target?.val)?.at(-1) || functionName(target?.val?.FuncCall) || '#' + columns.size, nullableLag(target?.val));
    }
    return columns;
  }
  select(tree?.stmts?.[0]?.stmt?.SelectStmt);
  return [...issues];
}
module.exports = { nullRankingDiagnostics };
