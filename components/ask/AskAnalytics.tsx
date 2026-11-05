import { formatChain } from '../../lib/ask/data';
import type { AskAnalytics as AnalyticsResult } from '@/lib/ask/chat';
import { analyticsPeriod, formatAnalyticsDate, formatAnalyticsRange } from '../../lib/ask/analytics-presentation';

export function AskAnalytics({ result }: { result?: AnalyticsResult }) {
  if (!result) return null;
  if ('columns' in result) return <QueryTable result={result} />;
  return <section aria-label="Analytics results" className="mt-4 rounded-lg border border-cipher-border p-4 text-sm">
    <p className="font-medium text-primary">{result.label}</p>
    <p className="mt-1 text-xs text-muted">{formatAnalyticsRange(result.plan.start, result.plan.end)} UTC · {result.plan.bucket === 'day' ? 'Daily' : result.plan.bucket === 'week' ? 'Weekly' : 'Monthly'} · {result.plan.order === 'newest' ? 'Most recent first' : result.plan.order === 'highest' ? 'Highest first' : 'Lowest first'}</p>
    {result.rows.length ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs">
      <caption className="sr-only">{result.label} by {result.plan.bucket}</caption>
      <thead><tr className="border-b border-cipher-border text-muted"><th scope="col" className="pb-2 pr-3 font-normal">{result.plan.order === 'newest' ? 'Order' : 'Rank'}</th><th scope="col" className="pb-2 font-normal">Period</th><th scope="col" className="pb-2 text-right font-normal">{result.kind === 'count' ? 'Transactions' : 'Balance'}</th><th scope="col" className="pb-2 pl-3 font-normal">{result.kind === 'count' ? 'Observed days' : 'Snapshot date'}</th></tr></thead>
      <tbody>{result.rows.map((row, index) => {
        const period = analyticsPeriod(result.plan, row);
        return <tr key={row.date} className="border-b border-cipher-border last:border-0"><td className="py-3 pr-3 font-mono text-muted">{index + 1}</td><th scope="row" className="py-3 pr-3 font-normal text-secondary"><time dateTime={period.start}>{formatAnalyticsRange(period.start, period.end)}</time>{period.partial ? <span className="mt-1 block text-muted">Partial {result.plan.bucket}</span> : null}</th><td className="py-3 text-right font-mono text-primary">{row.formatted}</td><td className="py-3 pl-3 text-muted">{result.kind === 'count' ? `${row.observedDays} ${row.observedDays === 1 ? 'day' : 'days'}` : <time dateTime={row.observedThrough}>{formatAnalyticsDate(row.observedThrough)}</time>}</td></tr>;
      })}</tbody>
    </table></div> : <p className="mt-3 text-secondary">No observations were returned for this period.</p>}
    {result.coverage.missingDays > 0 ? <p className="mt-3 text-xs text-cipher-gold">{result.coverage.missingDays} {result.coverage.missingDays === 1 ? 'day has' : 'days have'} no observations. Rankings cover the available data.</p> : null}
    <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Source and methodology</summary><p className="mt-2 leading-relaxed">{result.methodology}</p><p className="mt-2">Retrieved {result.retrievedAt} · public daily snapshots</p></details>
  </section>;
}


function QueryTable({ result }: { result: import('@/lib/ask/chat').QueryResult }) {
  return <section aria-label="Analytics results" className="mt-4 rounded-lg border border-cipher-border p-4 text-sm">
    <h3 className="font-medium text-primary">{result.label}</h3>
    <p className="mt-1 text-xs text-muted">{formatAnalyticsRange(result.plan.start, result.plan.end)} UTC · {result.plan.bucket === 'none' ? 'Selected period' : result.plan.bucket === 'day' ? 'Daily' : result.plan.bucket === 'week' ? 'Weekly' : 'Monthly'}</p>
    {result.rows.length ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs">
      <caption className="sr-only">{result.label} · {result.columns[result.plan.order.column].label}, {result.plan.order.direction === 'desc' ? 'descending' : 'ascending'}</caption>
      <thead><tr className="border-b border-cipher-border text-muted"><th scope="col" className="pb-2 pr-3 font-normal">Rank</th>{result.columns.map(c => <th key={c.key} scope="col" className={`pb-2 pr-3 font-normal ${c.type === 'number' ? 'text-right' : ''}`}>{c.label}{c.key === result.columns[result.plan.order.column].key ? result.plan.order.direction === 'desc' ? ' ↓' : ' ↑' : ''}</th>)}</tr></thead>
      <tbody>{result.rows.map((row, i) => <tr key={i} className="border-b border-cipher-border last:border-0"><th scope="row" className="py-3 pr-3 font-mono font-normal text-muted">{i + 1}</th>{result.columns.map(c => {
        const cell = row[c.key];
        let value = c.field === 'chain' && cell.value ? formatChain(cell.value) : cell.formatted;
        let partial = false;
        if (c.type === 'date' && cell.value) {
          const end = new Date(cell.value + 'T00:00:00Z');
          if (result.plan.bucket === 'week') end.setUTCDate(end.getUTCDate() + 6);
          if (result.plan.bucket === 'month') { end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0); }
          const a = cell.value < result.plan.start ? result.plan.start : cell.value;
          const b = end.toISOString().slice(0, 10) > result.plan.end ? result.plan.end : end.toISOString().slice(0, 10);
          partial = a !== cell.value || b !== end.toISOString().slice(0, 10);
          value = formatAnalyticsRange(a, b);
        }
        const link = c.field === 'txid' && /^[a-f0-9]{64}$/.test(cell.value || '') ? `/tx/${cell.value}` : c.field === 'height' && /^\d{1,9}(?:\.0+)?$/.test(cell.value || '') ? `/block/${cell.value!.split('.')[0]}` : c.field === 'hash' && /^[a-f0-9]{64}$/.test(cell.value || '') ? `/block/${cell.value}` : null;
        return <td key={c.key} className={`py-3 pr-3 ${c.type === 'number' ? 'text-right font-mono text-primary' : 'text-secondary'}`}>{link ? <a href={link} className="text-cipher-gold break-all">{value}</a> : value}{cell.missing ? <span className="mt-1 block text-caption text-muted">{cell.missing} unavailable observations</span> : null}{partial ? <span className="mt-1 block text-muted">Partial {result.plan.bucket}</span> : null}</td>;
      })}</tr>)}</tbody>
    </table></div> : <p className="mt-3 text-secondary">No observations were returned for this period.</p>}
    {result.coverage.missingDays ? <p className="mt-3 text-xs text-cipher-gold">{result.coverage.missingDays} days have no daily observations. Rankings cover available data.</p> : null}
    <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Source and query</summary><p className="mt-2 leading-relaxed">{result.methodology}</p><p className="mt-2">Latest indexed canonical block time: {new Date(result.coverage.indexedThrough).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC</p><pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(result.plan, null, 2)}</pre></details>
  </section>;
}
