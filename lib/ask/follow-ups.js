'use strict';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { supportsLine } = require('./research-display');

// These prompts interpret the current recipe; selecting one never changes it.
// Shared by the widget and server so a classifier cannot silently drop filters.
function analysisFollowUps(spec) {
  if (!spec) return [];
  if (spec.metric === 'balances') return ['Where is the selected pool balance most concentrated?', 'How has the recent weekly pace changed?'];
  if (spec.metric === 'migration_share') return ['How quickly has Ironwood’s share changed?', 'How has the recent weekly pace changed?'];
  if (spec.metric.startsWith('chain_')) return ['How concentrated is volume in the leading chain?', 'Which chains contribute the most tracked volume in this direction?'];
  return [spec.metric === 'flows' || spec.metric === 'swap_volume' ? 'How concentrated was volume on the busiest day?' : 'How concentrated was activity on the busiest day?', 'How does the latest week compare with the previous week?'];
}

// These are invitations to interpret returned observations, not new query
// recipes or evidence that another dataset/aggregation is available.
function researchFollowUps(result) {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows) || result.rows.length < 2 || result.rows.some(row => !Array.isArray(row) || row.length !== result.columns.length)) return [];
  const number = /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
  const labels = result.columns.map(column => column.label.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s.-]+/g, '_'));
  const identifier = /(?:^|_)(?:height|txid|hash|identifier|rank|ranking|index|position|ordinal)(?:_|$)|(?:^|_)(?:id|address)$|^(?:row_number|row_num|row)$/;
  const timeField = /(?:^|_)timestamp(?:_|$)|^(?:year|month|day|hour|minute|second|date|time|epoch|first_seen|last_seen)$|_time$/;
  const measure = result.columns.some((column, index) => {
    if (column.type !== 'number' || identifier.test(labels[index]) || timeField.test(labels[index])) return false;
    const values = result.rows.map(row => row[index]);
    // Inspect exact strings, without rounding decimals or large integers through
    // Number. Missing observations cannot supply the two values to compare.
    return values.every(value => value === null || typeof value === 'string' && number.test(value)) && values.filter(value => value !== null).length >= 2;
  });
  if (!measure) return [];
  const prompts = ['Compare the returned results'];
  const temporal = result.columns.some((column, index) => column.type === 'text' && !identifier.test(labels[index]) && result.rows.every(row => {
    const value = row[index];
    // Validate the calendar independently: Date.parse alone normalizes impossible
    // dates. Numeric heights/epochs and date-shaped labels do not prove time.
    const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})(?:[T ]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?)?)?$/.exec(value);
    if (!match) return false;
    const day = Date.parse(match[1] + 'T00:00:00Z');
    return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === match[1];
  }) && supportsLine(result, index));
  if (temporal) prompts.push('How do these results change over time?');
  return prompts;
}

module.exports = { analysisFollowUps, researchFollowUps };
