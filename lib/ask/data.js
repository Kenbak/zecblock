// Pure shared normalization and exact arithmetic. No transport or provider access.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeEvidence = normalizeEvidence;
exports.formatValue = formatValue;
exports.summarizeEvidence = summarizeEvidence;
exports.snapshotInput = snapshotInput;
exports.describeMetric = describeMetric;
exports.formatChain = formatChain;
function formatChain(chain) {
    const names = { eth: 'Ethereum', btc: 'Bitcoin', sol: 'Solana', tron: 'Tron', near: 'NEAR', bsc: 'BNB Chain', arb: 'Arbitrum', base: 'Base', pol: 'Polygon', xrp: 'XRP Ledger', ltc: 'Litecoin', avax: 'Avalanche', op: 'Optimism', doge: 'Dogecoin', sui: 'Sui' };
    return Object.hasOwn(names, chain) ? names[chain] : chain.toUpperCase();
}
const chainNote = 'Ranked by approximate USD source valuations of indexed successful swaps created in the rolling past 30 days. Inflows use the source chain; outflows use the destination chain. ZEC-to-ZEC records are excluded. Missing USD valuations may contribute zero in the upstream aggregate. Coverage follows indexed integrations, not all exchanges or net capital flow.';
const descriptions = {
    migration_share: { title: 'Orchard → Ironwood migration progress', unit: '%', source: '/ironwood', sourceLabel: 'Ironwood migration', csvUnit: 'basis_points', note: 'Progress proxy: Ironwood ÷ (Orchard + Ironwood) × 100, matching the migration dashboard. This is a share of the combined pool balance, not the percentage of original Orchard funds proven to have migrated. Ironwood also receives other inflows. A zero combined balance is unavailable. Changes are percentage points; CSV uses basis points.' },
    chain_inflows: { title: 'Top source chains into ZEC', unit: 'USD', source: '/crosschain', sourceLabel: 'Cross-chain swaps', csvUnit: 'usd_cents', note: chainNote },
    chain_outflows: { title: 'Top destination chains from ZEC', unit: 'USD', source: '/crosschain', sourceLabel: 'Cross-chain swaps', csvUnit: 'usd_cents', note: chainNote },
    balances: { title: 'Shielded pool balances', unit: 'ZEC', source: '/pools#supply', sourceLabel: 'Shielded pools', csvUnit: 'zatoshi', note: 'Daily indexed pool snapshots. Changes in balances are not the same as public net flows. Historical pool breakdown availability follows the source API.' },
    flows: { title: 'Public shielding & deshielding', unit: 'ZEC', source: '/pools#flows', sourceLabel: 'Shielded pools', csvUnit: 'zatoshi', note: 'Public ZEC entering and leaving shielded pools. Fully shielded payment amounts are private and are not measured here. These are not cross-chain swap volumes or a complete migration measure.' },
    activity: { title: 'Public pool flow activity', unit: 'flows', source: '/pools#flows', sourceLabel: 'Shielded pools', csvUnit: 'flow_count', note: 'Counts of indexed public shielding and deshielding flow records, not all Zcash transactions or private payments. A transaction may contribute multiple flow records.' },
    swap_volume: { title: 'Tracked cross-chain swap volume', unit: 'USD', source: '/crosschain', sourceLabel: 'Cross-chain swaps', csvUnit: 'usd_cents', note: 'Indexed successful cross-chain swaps, grouped by swap creation day. USD valuations from the source are approximate and rounded to cents per daily bucket. Coverage follows our indexed integrations; this is not all exchange volume, all ZEC buying/selling, or net capital entering Zcash. Swaps without a recorded USD value may contribute zero to these totals.' },
    swap_count: { title: 'Tracked cross-chain swap counts', unit: 'swaps', source: '/crosschain', sourceLabel: 'Cross-chain swaps', csvUnit: 'swap_count', note: 'Counts of indexed successful cross-chain swaps, grouped by swap creation day. Inflows swap into ZEC; outflows swap out of ZEC. Coverage follows indexed integrations, not all exchanges or unique traders.' },
    transactions: { title: 'Shielded & transparent transaction activity', unit: 'transactions', source: '/privacy', sourceLabel: 'Privacy statistics', csvUnit: 'transaction_count', note: 'Indexed daily non-coinbase transactions, split into mutually exclusive shielded and transparent categories. Their sum excludes mining reward transactions. These counts do not reveal private payment amounts, shielded addresses, or unique users. Missing days are not assumed to be zero.' },
    pulse: { title: 'Network Pulse alerts', unit: 'alerts', source: '/pulse', sourceLabel: 'Network Pulse', csvUnit: 'alert_count', note: 'Recorded anomaly alerts grouped by day and severity, not a live network-health score. Pulse compares metrics with a 90-day rolling baseline. Mild: absolute z-score below 3; strong: 3 to below 4; extreme: 4 or above. Days without records can mean no detected anomaly or missing detector coverage; they are not filled with zero. Alerts do not prove a cause or predict price.' },
};
function describeMetric(metric) {
    if (!Object.hasOwn(descriptions, metric)) throw new Error('Unsupported metric');
    return descriptions[metric];
}
function snapshotInput(spec, evidence) {
    return JSON.stringify([spec.metric, spec.period, spec.pool, spec.start, spec.end,
        summarizeEvidence(evidence, spec, spec.start || '', spec.end || '').points]);
}
const pools = ['ironwood', 'orchard', 'sapling', 'sprout'];
const labels = { ironwood: 'Ironwood', orchard: 'Orchard', sapling: 'Sapling', sprout: 'Sprout', shield: 'Shielding', deshield: 'Deshielding' };
const integer = (value) => typeof value === 'string' && /^\d{1,22}$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
function normalizeEvidence(spec, data, meta) {
    const balances = spec.metric === "balances";
    const info = describeMetric(spec.metric);
    if (spec.metric.startsWith('chain_')) {
        if (meta.network !== 'mainnet' || data.period !== '30d' || !Array.isArray(data.chains) || data.chains.length > 200) throw new Error('Invalid chain rankings');
        const direction = spec.metric === 'chain_inflows' ? 'inflow' : 'outflow';
        const seen = new Set();
        const points = data.chains.filter(row => row.direction === direction && row.chain !== 'zec').map(row => {
            if (typeof row.chain !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(row.chain) || seen.has(row.chain)) throw new Error('Invalid chain identifier');
            seen.add(row.chain);
            const value = typeof row.volumeUsd === 'number' && Number.isFinite(row.volumeUsd) && row.volumeUsd >= 0 ? integer(Math.round(row.volumeUsd * 100)) : null;
            return { date: row.chain, values: { volume: value } };
        }).sort((a, b) => a.values.volume === null ? (b.values.volume === null ? a.date.localeCompare(b.date) : 1) : b.values.volume === null ? -1 : BigInt(a.values.volume) === BigInt(b.values.volume) ? a.date.localeCompare(b.date) : BigInt(a.values.volume) > BigInt(b.values.volume) ? -1 : 1);
        return { key: `${spec.metric}:${spec.period}:${spec.pool}`, dimension: 'chain', points, meta, receivedAt: new Date().toISOString(), series: [{ key: 'volume', label: direction === 'inflow' ? 'Into ZEC' : 'Out of ZEC', color: direction === 'inflow' ? 'shielding' : 'deshielding' }], ...info };
    }
    let rows = data.points;
    if (['balances', 'migration_share'].includes(spec.metric) && Array.isArray(rows) && rows.some(row => row.hasPoolBreakdown === true && !pools.some(pool => Object.hasOwn(row, `${pool}Zat`))))
        throw new Error('The pool source did not return the requested exact zatoshi format.');
    let fields;
    let cutoff = '';
    if (spec.metric === 'migration_share') {
        if (!Array.isArray(rows)) throw new Error('Invalid pool history');
        rows = rows.map(row => {
            const ironwood = integer(row.ironwoodZat); const orchard = integer(row.orchardZat);
            const total = ironwood !== null && orchard !== null ? BigInt(ironwood) + BigInt(orchard) : BigInt(0);
            return { date: row.date, share: row.hasPoolBreakdown === true && total > BigInt(0) ? ((BigInt(ironwood) * BigInt(10000) + total / BigInt(2)) / total).toString() : null };
        });
        fields = [['share', 'share', 'Ironwood share', 'ironwood']];
    } else if (spec.metric.startsWith('swap_')) {
        rows = data.data;
        fields = [['inflow', spec.metric === 'swap_volume' ? 'inflowVolume' : 'inflowCount', 'Into ZEC', 'shielding'], ['outflow', spec.metric === 'swap_volume' ? 'outflowVolume' : 'outflowCount', 'Out of ZEC', 'deshielding']];
    } else if (spec.metric === 'transactions') {
        rows = data.trends?.daily;
        const days = spec.period === '1y' ? 365 : Number(spec.period.slice(0, -1));
        const anchor = meta.generatedAt || new Date().toISOString();
        cutoff = new Date(Date.parse(anchor.slice(0, 10)) - days * 86400000).toISOString().slice(0, 10);
        fields = [['shielded', 'shielded', 'Shielded', 'shielded'], ['transparent', 'transparent', 'Transparent', 'transparent']];
    } else if (spec.metric === 'pulse') {
        if (!Array.isArray(data.events) || data.events.length > 5000 || data.events.length !== data.total) throw new Error('Incomplete Pulse data');
        const byDay = new Map(); const seen = new Set();
        for (const event of data.events) {
            const date = typeof event.date === 'string' ? event.date.slice(0, 10) : '';
            const key = `${date}:${event.metric}`;
            if (seen.has(key) || typeof event.metric !== 'string' || !['mild', 'strong', 'extreme'].includes(event.severity)) throw new Error('Invalid Pulse observation');
            seen.add(key);
            if (!byDay.has(date)) byDay.set(date, { date, mild: 0, strong: 0, extreme: 0 });
            byDay.get(date)[event.severity]++;
        }
        rows = [...byDay.values()];
        fields = [['mild', 'mild', 'Mild', 'transparent'], ['strong', 'strong', 'Strong', 'gold'], ['extreme', 'extreme', 'Extreme', 'distinctive']];
    }
    if (meta.network !== 'mainnet' || !Array.isArray(rows) || rows.length > 400)
        throw new Error('The source returned incompatible data.');
    if (!fields) fields = (balances ? (spec.pool === 'all' ? [...pools] : [spec.pool]) : ['shield', 'deshield']).map(key => [key, balances ? `${key}Zat` : spec.metric === 'activity' ? `${key}Tx` : key, labels[key], key === 'shield' ? 'shielding' : key === 'deshield' ? 'deshielding' : key]);
    const points = rows.map((raw) => {
        const date = typeof raw.date === 'string' ? raw.date.slice(0, 10) : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)
            throw new Error('The source returned an invalid observation date.');
        return { date, values: Object.fromEntries(fields.map(([key, field]) => {
            const value = raw[field];
            const cents = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
            return [key, balances && raw.hasPoolBreakdown !== true ? null : integer(info.unit === 'USD' ? cents : value)];
        })) };
    }).filter(point => !cutoff || point.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date));
    if (new Set(points.map(point => point.date)).size !== points.length)
        throw new Error('The source returned duplicate daily observations.');
    if (points.length > 1 && Date.parse(points.at(-1).date) - Date.parse(points[0].date) > 400 * 86400000)
        throw new Error('The source returned an unsupported observation window.');
    return {
        key: `${spec.metric}:${spec.period}:${spec.pool}`,
        points, meta, receivedAt: new Date().toISOString(),
        series: fields.map(([key, , label, color]) => ({ key, label, color })),
        ...info,
    };
}
/** Preserve integer zatoshis through all calculations; round only for display. */
function formatValue(value, unit, signed = false) {
    if (value === null)
        return 'Unavailable';
    const exact = BigInt(value);
    const magnitude = exact < BigInt(0) ? -exact : exact;
    const prefix = exact < BigInt(0) ? '−' : signed && exact > BigInt(0) ? '+' : '';
    if (unit !== 'ZEC' && unit !== 'USD' && unit !== '%')
        return `${prefix}${magnitude.toLocaleString('en-US')}`;
    const hundredths = unit === 'USD' || unit === '%' ? magnitude : (magnitude + BigInt(500000)) / BigInt(1000000);
    return `${prefix}${(hundredths / BigInt(100)).toLocaleString('en-US')}.${String(hundredths % BigInt(100)).padStart(2, '0')}`;
}
function summarizeEvidence(evidence, spec, start = '', end = '') {
    const points = evidence.points.filter(point => (!start || point.date >= start) && (!end || point.date <= end));
    const totals = evidence.series.map(series => {
        const first = points[0]?.values[series.key] ?? null;
        const last = points.at(-1)?.values[series.key] ?? null;
        const complete = points.length > 0 && points.every(point => point.values[series.key] !== null);
        const value = ['balances', 'migration_share'].includes(spec.metric) ? last : complete ? points.reduce((total, point) => total + BigInt(point.values[series.key]), BigInt(0)).toString() : null;
        const change = ['balances', 'migration_share'].includes(spec.metric) && first !== null && last !== null && points.length > 1 ? (BigInt(last) - BigInt(first)).toString() : null;
        return { ...series, value, change };
    });
    return { points, totals, start: evidence.dimension === 'chain' ? null : points[0]?.date ?? null, end: evidence.dimension === 'chain' ? null : points.at(-1)?.date ?? null };
}
