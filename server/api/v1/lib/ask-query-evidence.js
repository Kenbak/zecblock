'use strict';
const { createHash } = require('node:crypto');
const { askError } = require('./ask-errors');
// Decimal strings stay exact through the worker, API and UI. No Number coercion
// for zatoshis, aggregates or ratios. SQL rounds averages/ratios to six decimals.
function decimal(value, unit) {
    if (!/^-?(?:0|[1-9]\d{0,39})(?:\.\d{1,6})?$/.test(value))
        throw askError('source');
    const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
    let scale = fraction.length, integer = BigInt(whole + fraction);
    if (unit === 'ZEC')
        scale += 8;
    const digits = integer.toString().padStart(scale + 1, '0');
    const a = scale ? digits.slice(0, -scale) : digits, b = scale ? digits.slice(-scale).replace(/0+$/, '') : '';
    return `${negative && integer !== 0n ? '-' : ''}${BigInt(a).toLocaleString('en-US')}${b ? '.' + b : ''}${unit && unit !== 'number' ? ' ' + unit : ''}`;
}
function queryEvidence(compiled, rows, coverage, retrievedAt) {
    const { plan, days, definition, columns } = compiled;
    if (!Array.isArray(rows) || rows.length > plan.limit || Buffer.byteLength(JSON.stringify(rows)) > 32768)
        throw askError('source');
    if (!coverage || !Number.isFinite(Date.parse(coverage.indexed_through)))
        throw askError('source');
    const observed = coverage.observed_days === null ? null : Number(coverage.observed_days);
    if (observed !== null && (!Number.isInteger(observed) || observed < 0 || observed > days))
        throw askError('source');
    const facts = { window_start: plan.start, window_end: plan.end, returned_rows: String(rows.length), indexed_through: new Date(coverage.indexed_through).toISOString() };
    if (observed !== null)
        facts.missing_days = String(days - observed);
    const formatted = rows.map((row, i) => {
        if (Object.keys(row).length !== columns.length + plan.measures.length)
            throw askError('source');
        return Object.fromEntries(columns.map(c => {
            const value = row[c.key];
            let text;
            if (value === null)
                text = 'Unavailable';
            else if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f<>]/.test(value))
                throw askError('source');
            else if (c.type === 'number')
                text = decimal(value, c.unit);
            else if (c.type === 'date') {
                if (!/^20\d{2}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)))
                    throw askError('source');
                text = value;
            }
            else if (c.type === 'boolean') {
                if (!['true', 'false'].includes(value))
                    throw askError('source');
                text = value === 'true' ? 'Yes' : 'No';
            }
            else
                text = value;
            // Text from rows is evidence data, never trusted instructions or source URLs.
            facts[`row_${String.fromCharCode(97 + i)}_${c.key.replace(/\d/g, digit => String.fromCharCode(97 + Number(digit)))}`] = text;
            let missing = 0;
            if (/^m[0-3]$/.test(c.key)) {
                const count = row['u' + c.key.slice(1)];
                if (typeof count !== 'string' || !/^\d{1,12}$/.test(count))
                    throw askError('source');
                missing = Number(count);
                facts[`row_${String.fromCharCode(97 + i)}_${c.key.replace(/\d/g, digit => String.fromCharCode(97 + Number(digit)))}_missing`] = String(missing);
            }
            return [c.key, { value, formatted: text, missing }];
        }));
    });
    const canonical = coverage.consistency === 'verified-canonical-core' && ['blocks','transactions'].includes(plan.dataset) && Date.parse(coverage.indexed_through) >= Date.parse(plan.end) + 86400000;
    const result = { plan, label: definition.label, columns, rows: formatted, coverage: { expectedDays: days, observedDays: observed, missingDays: observed === null ? null : days - observed, indexedThrough: new Date(coverage.indexed_through).toISOString(), completeness: canonical ? 'canonical-records' : observed === null ? 'unverified' : 'daily-observations' }, retrievedAt, methodology: definition.notes + ' UTC weeks start Monday. Edge weeks/months cover only the selected dates. Sums/averages skip null values; per-measure missing counts are included. Last uses the last dated row, including a null reading. SQL averages and ratios are rounded to six decimal storage units; ratios are percentages. Zero denominators and missing measures remain unavailable. Indexed-through describes the canonical chain, not certification of historical backfills.' };
    return { result, facts, evidenceKey: createHash('sha256').update(JSON.stringify([plan, rows, coverage])).digest('hex') };
}
module.exports = { queryEvidence, decimal };
