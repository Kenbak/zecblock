'use strict';
const { getKnowledge, publicSources } = require('./ask-knowledge');
const { formatChain } = require('../../../../lib/ask/data');
const { decimal } = require('./ask-query-evidence');
const { datasets } = require('./ask-query-plan');
const { askStage } = require('./ask-errors');
const { renderExplanation } = require('./ask-explanation');
const { formatAnalyticsDate, formatAnalyticsRange } = require('../../../../lib/ask/analytics-presentation');
function narrativeDecimal(value, unit) {
    if (!['ZEC', 'USD', '%'].includes(unit)) return decimal(value, unit);
    const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/,'').split('.');
    const integer = BigInt(whole + fraction), scale = fraction.length + (unit === 'ZEC' ? 8 : 0);
    const places = unit === 'ZEC' && integer < 10n ** BigInt(scale) ? 8 : 2;
    const divisor = 10n ** BigInt(Math.max(0, scale - places));
    const rounded = (integer + divisor / 2n) / divisor * divisor;
    const digits = rounded.toString().padStart(fraction.length + 1, '0');
    const raw = (negative && rounded !== 0n ? '-' : '') + (fraction.length ? digits.slice(0,-fraction.length) + '.' + digits.slice(-fraction.length) : digits);
    return (rounded !== integer ? '≈' : '') + decimal(raw, unit);
}
async function queryReply(evidence, input, run, locale, answerTaskFor) {
    const result = evidence.result, records = getKnowledge([datasets[result.plan.dataset].topic]);
    // Native rows carry the complete result. Narrative can discuss the first two
    // rows, multiple measures and verified calculations, without dumping a list.
    const facts = Object.fromEntries(Object.entries(evidence.facts).filter(([key]) => !/^row_/.test(key) || /^row_[ab]_/.test(key)));
    facts.window_start = formatAnalyticsDate(result.plan.start, locale);
    facts.window_end = formatAnalyticsDate(result.plan.end, locale);
    facts.indexed_through = new Date(result.coverage.indexedThrough).toLocaleString(locale, { timeZone: 'UTC' }) + ' UTC';
    for (const [i, row] of result.rows.slice(0, 2).entries())
        for (const c of result.columns) {
            if (c.field === 'chain' && row[c.key].value) facts[`row_${String.fromCharCode(97 + i)}_${c.key.replace(/\d/g, digit => String.fromCharCode(97 + Number(digit)))}`] = formatChain(row[c.key].value);
            if (c.type === 'number' && row[c.key].value !== null) facts[`row_${String.fromCharCode(97 + i)}_${c.key.replace(/\d/g, digit => String.fromCharCode(97 + Number(digit)))}`] = narrativeDecimal(row[c.key].value, c.unit);
            if (c.type !== 'date' || !row[c.key].value)
                continue;
            const start = row[c.key].value, end = new Date(start + 'T00:00:00Z');
            if (result.plan.bucket === 'week')
                end.setUTCDate(end.getUTCDate() + 6);
            if (result.plan.bucket === 'month') {
                end.setUTCMonth(end.getUTCMonth() + 1);
                end.setUTCDate(0);
            }
            const clippedStart = start < result.plan.start ? result.plan.start : start;
            const bucketEnd = end.toISOString().slice(0, 10);
            const clippedEnd = bucketEnd > result.plan.end ? result.plan.end : bucketEnd;
            facts[`row_${String.fromCharCode(97 + i)}_${c.key.replace(/\d/g, digit => String.fromCharCode(97 + Number(digit)))}`] = formatAnalyticsRange(clippedStart, clippedEnd, locale);
            facts[`row_${String.fromCharCode(97 + i)}_bucket_status`] = clippedStart !== start || clippedEnd !== bucketEnd ? 'partial calendar bucket' : 'complete calendar bucket';
        }
    const task = answerTaskFor(facts, records, true, true);
    task.instruction += '\nWrite only one short leading finding in summary. Use plain text without decorative symbols or emojis. All numeric dates/amounts, including years, must use fact placeholders; do not spell them out to evade this requirement. Leave observations empty. The table displays every requested rank: never announce a list, enumerate other ranks, repeat a date as another period, or claim remaining rows are absent because their placeholders are not provided. Use natural metric language, such as public deshielding volume, rather than merely repeating internal field labels. This is a validated relational query result. Directly answer the question with one leading finding and at most one useful comparison or interpretation. Use the supplied column labels and fact placeholders, including calculated ratio/difference facts when present. Do not calculate new percentages mentally. A ratio means left divided by right times one hundred; it is not a percent change or a share of a larger total unless that denominator was queried. The native table already contains all rows; do not repeat the entire ranking. Read order.column and direction before describing a peak. Measures count records or sum/average the named public fields, not users or private transfer amounts. Monetary/ratio prose facts are rounded by the server and marked ≈ when approximate; exact values remain in the table. Do not append a unit that is already present in a fact. Missing measures and zero-denominator ratios are unavailable, never zero. Per-measure missing counts indicate partial aggregate totals; do not describe these as complete. Last uses the last dated snapshot, even when null. For flows, busiest without an explicit volume metric means record count; explicitly name the chosen measure. Date windows are clipped to completed UTC days, and edge calendar buckets may be partial. Use observed/indexed/tracked rather than claiming an exhaustive historical maximum when completeness is unverified. Sparse event dates do not establish missing database days or zero activity. The canonical-chain indexed-through timestamp is not certification of flow backfill coverage. When completeness is canonical-records, block/transaction counts are reconciled to a contiguous canonical chain through the selected completed window: do not claim their historical coverage is unverified. This does not certify historical flow records. The row_a_bucket_status and row_b_bucket_status describe the ranked rows, not chronological ordering. Never call the first ranked row partial when row_a_bucket_status is complete. Call only seven-selected-day weekly buckets complete; edge buckets are partial and must never be presented as complete weeks. Distinguish estimates, observations and documented protocol context. Do not infer causes, identities, or direct migration from pool stock ratios. Mention only limitations that matter to this question.';
    const raw = await run({ question: input.question, history: input.history, locale, documents: records, evidence: { ...result, facts } }, task);
    const rendered = await askStage('answer', () => renderExplanation({ summary: raw.summary, observations: raw.observations, limitation: raw.limitation }, facts));
    return { answer: [rendered.summary, ...rendered.observations, rendered.limitation].filter(Boolean).join('\n\n').replace(/\b(records|transactions|ZEC|USD|bytes)(?:\s+\1)+\b/gi, '$1'), sources: publicSources(records), spec: null, locale, analytics: result, evidenceKey: evidence.evidenceKey };
}
module.exports = { queryReply, narrativeDecimal };
