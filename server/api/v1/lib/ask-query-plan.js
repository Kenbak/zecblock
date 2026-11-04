'use strict';
// All identifiers/functions/joins originate in this reviewed catalogue.
// The caller supplies a bounded relational plan, never SQL or expressions.
const n = (label, unit = 'number', snapshot = false) => ({ label, type: 'number', unit, snapshot });
const d = (label, type = 'text') => ({ label, type, dimension: true });
const datasets = Object.freeze({
    daily: { view: 'daily_v2', time: 'date', clock: 'date', label: 'Daily network observations', topic: 'pools', fields: { transactions: n('Non-coinbase transactions', 'transactions'), shielded_transactions: n('Shielded transactions', 'transactions'), transparent_transactions: n('Transparent transactions', 'transactions'), orchard: n('Orchard balance', 'ZEC', true), ironwood: n('Ironwood balance', 'ZEC', true), sapling: n('Sapling balance', 'ZEC', true), sprout: n('Sprout balance', 'ZEC', true) }, notes: 'Maintained daily snapshots. Counts exclude coinbase. Pool balances are stocks in zatoshis: use last/min/max/avg, never sum. A balance ratio is a balance share, not traced migration.' },
    blocks: { view: 'blocks_v2', time: 'timestamp', clock: 'epoch', label: 'Canonical blocks', topic: 'block', fields: { height: d('Block height', 'number'), hash: d('Block hash'), miner: d('Miner address'), transactions: n('Included transactions', 'transactions'), bytes: n('Block size', 'bytes'), fees: n('Public fees', 'ZEC') }, notes: 'Current canonical blocks only. Included transaction counts contain coinbase. Miner is a public payout address, not an attributed mining pool.' },
    transactions: { view: 'transactions_v2', time: 'timestamp', clock: 'epoch', label: 'Confirmed transactions', topic: 'transactions', fields: { txid: d('Transaction ID'), height: d('Block height', 'number'), miner: d('Miner address'), shielded: d('Shielded components', 'boolean'), orchard: d('Orchard components', 'boolean'), ironwood: d('Ironwood components', 'boolean'), sapling: d('Sapling components', 'boolean'), bytes: n('Transaction size', 'bytes'), fees: n('Public fee', 'ZEC'), orchard_actions: n('Orchard actions'), ironwood_actions: n('Ironwood actions') }, notes: 'Non-coinbase transactions joined to current canonical blocks by hash and height, one row per transaction. Shielded components do not establish shielding direction. Private transfer amounts are unavailable. Block fields may be grouped without join fanout.' },
    flows: { view: 'flows_v2', time: 'timestamp', clock: 'epoch', label: 'Public shielding and deshielding', topic: 'pools', fields: { txid: d('Transaction ID'), height: d('Block height', 'number'), direction: d('Direction'), pool: d('Pool'), amount: n('Public boundary amount', 'ZEC') }, notes: 'Indexed boundary-flow records joined to canonical transactions and blocks. direction=shield|deshield; pool=sapling|orchard|ironwood|mixed. Amounts are exact zatoshis. Counts count flow records, not users. Historical backfill completeness is not certified; absent records do not establish zero flow.' },
    swaps: { view: 'swaps_v2', time: 'timestamp', clock: 'timestamp', label: 'Tracked successful cross-chain swaps', topic: 'crosschain', fields: { direction: d('Direction'), chain: d('Counterparty chain'), token: d('Counterparty token'), usd: n('Reported counterparty value', 'USD') }, notes: 'Source: public.cross_chain_swaps (legacy-success-index, the currently serving public cross-chain source). Successful external swaps dated by creation time; direction derives from source/destination ZEC chains, ZEC-to-ZEC routes are excluded, and legacy zero USD sentinels become unavailable. Inflow uses source chain/token/USD; outflow uses destination chain/token/USD. Valuations are estimates; missing valuations remain null. This is not all exchange activity.' },
});
const { querySchema } = require('../../../../lib/ask/query-contract');
function compileQuery(input, now = Date.now(), definitions = datasets, schema = 'ask_public') {
    if (!['ask_public','analytics_public'].includes(schema)) throw Error('Unknown compiler schema');
    const plan = querySchema.parse(input), definition = definitions[plan.dataset];
    if (!definition) throw Error('Dataset unavailable in this store');
    const days = (Date.parse(plan.end) - Date.parse(plan.start)) / 86400000 + 1;
    if (days < 1 || days > 366 || plan.end >= new Date(now).toISOString().slice(0, 10))
        throw Error('Invalid query window');
    const values = [plan.start, plan.end], columns = [], expressions = [];
    const bind = v => { values.push(v); return `$${values.length}`; };
    const getField = name => { if (!Object.hasOwn(definition.fields, name))
        throw Error('Unknown public field'); return definition.fields[name]; };
    const filters = list => list.map(f => {
        const spec = getField(f.field);
        if (spec.type === 'number' && !/^-?(?:0|[1-9]\d{0,24})(?:\.\d{1,8})?$/.test(f.value) || spec.type === 'boolean' && !['true', 'false'].includes(f.value) || spec.type !== 'number' && !['eq', 'ne'].includes(f.op))
            throw Error('Invalid typed filter');
        // ZEC fields are stored as zatoshis; filter units follow storage units too.
        return `${f.field} ${{ eq: '=', ne: '<>', gte: '>=', lte: '<=' }[f.op]} ${bind(f.value)}::${{ number: 'numeric', boolean: 'boolean', text: 'text' }[spec.type]}`;
    }).join(' AND ') || 'TRUE';
    const where = filters(plan.filters);
    if (plan.bucket !== 'none') {
        const time = definition.clock === 'epoch' ? `pg_catalog.to_timestamp(${definition.time}) AT TIME ZONE 'UTC'` : definition.clock === 'timestamp' ? `${definition.time} AT TIME ZONE 'UTC'` : 'date::timestamp';
        expressions.push(`pg_catalog.date_trunc('${plan.bucket}',${time})::date`);
        columns.push({ key: 'd0', label: 'Period', type: 'date', unit: '' });
    }
    if (new Set(plan.dimensions).size !== plan.dimensions.length)
        throw Error('Duplicate dimension');
    for (const name of plan.dimensions) {
        const spec = getField(name);
        if (!spec.dimension)
            throw Error('Not a dimension');
        expressions.push(name);
        columns.push({ key: `d${expressions.length - 1}`, label: spec.label, type: spec.type, unit: '', field: name });
    }
    const countDimensions = columns.length, missing = [];
    const aggregate = plan.measures.map((m, i) => {
        const spec = m.field === 'records' ? n('Records', plan.dataset === 'transactions' ? 'transactions' : 'records') : getField(m.field);
        if (m.operation === 'count' ? m.field !== 'records' : spec.type !== 'number' || spec.dimension || m.field === 'records')
            throw Error('Invalid measure');
        if (spec.snapshot && m.operation === 'sum' || m.operation === 'last' && !spec.snapshot)
            throw Error('Invalid stock aggregation');
        const condition = filters(m.filters);
        const expression = m.operation === 'count' ? `count(*) FILTER (WHERE ${condition})` : m.operation === 'last' ? `(array_agg(${m.field} ORDER BY ${definition.time} DESC) FILTER (WHERE ${condition} ))[1]` : `${m.operation}(${m.field}::numeric) FILTER (WHERE ${condition})`;
        missing.push(`${m.operation === 'count' ? '0::bigint' : `count(*) FILTER (WHERE ${condition} AND ${m.field} IS NULL)`} AS u${i}`);
        columns.push({ key: `m${i}`, label: `${{ count: 'Count', sum: 'Total', avg: 'Average', min: 'Minimum', max: 'Maximum', last: 'Last' }[m.operation]} ${spec.label.toLowerCase()}${m.filters.length ? ` (${m.filters.map(f => `${f.field} ${f.op} ${f.value}`).join(', ')})` : ''}`, type: 'number', unit: spec.unit });
        return `${expression} AS m${i}`;
    });
    const calculations = plan.calculations.map((c, i) => {
        if (c.left >= plan.measures.length || c.right >= plan.measures.length || c.left === c.right)
            throw Error('Invalid calculation references');
        const a = columns[countDimensions + c.left], b = columns[countDimensions + c.right];
        if (a.unit !== b.unit)
            throw Error('Incompatible calculation units');
        columns.push({ key: `c${i}`, label: `${a.label} ${c.operation === 'ratio' ? '/' : '−'} ${b.label}`, type: 'number', unit: c.operation === 'ratio' ? '%' : a.unit });
        return `${c.operation === 'ratio' ? `100*m${c.left}::numeric/NULLIF(m${c.right},0)` : `m${c.left}-m${c.right}`} AS c${i}`;
    });
    if (plan.order.column >= columns.length)
        throw Error('Invalid order column');
    const timeWhere = definition.clock === 'epoch' ? `${definition.time} >= EXTRACT(EPOCH FROM $1::date::timestamp AT TIME ZONE 'UTC')::bigint AND ${definition.time} < EXTRACT(EPOCH FROM ($2::date+1)::timestamp AT TIME ZONE 'UTC')::bigint` : definition.clock === 'timestamp' ? `${definition.time} >= $1::date::timestamp AT TIME ZONE 'UTC' AND ${definition.time} < ($2::date+1)::timestamp AT TIME ZONE 'UTC'` : 'date >= $1::date AND date <= $2::date';
    const dims = expressions.map((e, i) => `${e} AS d${i}`), grouped = `SELECT ${[...dims, ...aggregate, ...missing].join(',')} FROM ${schema}.${definition.view} WHERE ${timeWhere} AND ${where}${dims.length ? ` GROUP BY ${expressions.join(',')}` : ''}`;
    const projection = columns.map(c => c.type === 'number' ? `pg_catalog.round(${c.key}::numeric,6)::text AS ${c.key}` : `${c.key}::text AS ${c.key}`).join(',') + plan.measures.map((m, i) => `,u${i}::text AS u${i}`).join(''), orderKey = columns[plan.order.column].key, limit = bind(plan.limit);
    return { plan, days, definition, columns, text: `WITH grouped AS (${grouped}), calculated AS (SELECT grouped.*${calculations.length ? ',' + calculations.join(',') : ''} FROM grouped) SELECT ${projection} FROM calculated ORDER BY calculated.${orderKey} ${plan.order.direction.toUpperCase()} NULLS LAST${columns.filter(c => c.key !== orderKey).map(c => `,calculated.${c.key} ASC NULLS LAST`).join('')} LIMIT ${limit}::int`, values };
}
const catalogue = Object.entries(datasets).map(([dataset, d]) => ({ dataset, label: d.label, fields: d.fields, notes: d.notes }));
const views = ['daily_v1', ...Object.values(datasets).map(d => d.view)];
module.exports = { querySchema, compileQuery, datasets, catalogue, views };
