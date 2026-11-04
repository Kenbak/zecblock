'use strict';
const { z } = require('zod');
const { createHash } = require('node:crypto');
const { analysisSchema } = require('../../../../lib/ask/contract');
const { summarizeEvidence, formatValue, snapshotInput } = require('../../../../lib/ask/data');
const { loadEvidence } = require('../../../../lib/ask/sources');
const { buildMeta } = require('./envelope');
const { buildInsights, analysisGuidance } = require('./ask-insights');

const explainRequestSchema = z.object({ spec: analysisSchema, evidenceKey: z.string().regex(/^[a-f0-9]{64}$/), challenge: z.string().max(2048).optional() }).strict();
const explanationSchema = z.object({
  summary: z.string().min(1).max(700),
  observations: z.array(z.string().min(1).max(500)).max(2),
  limitation: z.string().max(500),
}).strict();
const schema = z.toJSONSchema(explanationSchema); delete schema.$schema;
const explanationTask = {
  name: 'explain_analysis', schema, validator: explanationSchema,
  instruction: `Write a concise, useful explanation of this Zcash mainnet analysis using only verified facts and methodology. Return a summary, up to two observations, and a limitation only when useful (otherwise empty). Every numerical value and date MUST be an exact supplied {{fact_id}} placeholder; facts already include units. No literal digits, URLs, markup or invented placeholders. Keep under two hundred words. After a direction word (rose, fell, increased, decreased, grew, declined) use the unsigned {{*_size}} fact, never the signed {{*_change}}; use {{*_change}} only without a direction word. ${analysisGuidance}`,
};

// Literal ranges keep provider decoding and the final Unicode-aware renderer
// consistent. The provider does not accept Unicode property escapes. Include
// every numeric category (decimal digits, superscripts, Roman numerals, etc.)
// and decorative Other-Symbol characters,
// rather than allowing a model to evade the rule by changing numeral scripts.
const numericRanges = (() => {
  const ranges = []; let start = null;
  for (let point = 0; point <= 0x110000; point++) {
    const numeric = point < 0x110000 && /[\p{N}\p{So}]/u.test(String.fromCodePoint(point));
    if (numeric && start === null) start = point;
    if (!numeric && start !== null) {
      const end = point - 1;
      ranges.push(String.fromCodePoint(start) + (end === start ? '' : '-' + String.fromCodePoint(end)));
      start = null;
    }
  }
  return ranges.join('');
})();
// Server facts whose value is exactly "ZIP <n>" may also be written literally:
// a question naming ZIP 317 is answered naturally, while any other number
// (including an invented ZIP) is still rejected.
const literalFacts = facts => [...new Set(Object.values(facts).filter(value => typeof value === 'string' && /^ZIP \d{1,4}$/.test(value)))];
function evidenceProse(facts) {
  const ids = Object.keys(facts);
  if (ids.some(id => !/^[a-z_]+$/.test(id))) throw new Error('Invalid server fact ID');
  const literals = literalFacts(facts).map(value => value.replace(' ', '\\x20'));
  const allowed = [...(ids.length ? [`\\{\\{(?:${ids.join('|')})\\}\\}`] : []), ...literals];
  const pattern = allowed.length ? `^(?:${allowed.join('|')}|[^${numericRanges}{}<>])*$` : `^[^${numericRanges}{}<>]*$`;
  return z.string().regex(new RegExp(pattern, 'u'));
}

function explanationTaskFor(facts) {
  const prose = evidenceProse(facts);
  const validator = z.object({ summary: prose.min(1).max(700), observations: z.array(prose.min(1).max(500)).max(2), limitation: prose.max(500) }).strict();
  const schema = z.toJSONSchema(validator); delete schema.$schema;
  return { ...explanationTask, schema, validator };
}

async function loadExplanationEvidence(spec, internalClient, signal) {
  const evidence = await loadEvidence(spec, async source => {
    const result = await internalClient.dispatch('GET', source.legacy, { query: source.query, parentSignal: signal });
    if (!result.ok || result.body?.success === false) throw new Error('Source unavailable');
    // Retrieval is not authoritative source observation/refresh time.
    return { data: result.body, meta: buildMeta({ network: 'mainnet', requestId: 'ask-evidence' }) };
  });
  const summary = summarizeEvidence(evidence, spec, spec.start || '', spec.end || '');
  if (!summary.points.length) throw new Error('No observations');
  const evidenceKey = createHash('sha256').update(snapshotInput(spec, evidence)).digest('hex');
  const facts = { start_date: summary.start, end_date: summary.end, observation_count: String(summary.points.length) };
  const series = summary.totals.map(item => {
    facts[`${item.key}_value`] = `${formatValue(item.value, evidence.unit)}${item.value === null ? '' : ` ${evidence.unit}`}`;
    const changeUnit = item.change === null ? '' : ` ${evidence.unit === '%' ? 'percentage points' : evidence.unit}`;
    facts[`${item.key}_change`] = `${formatValue(item.change, evidence.unit, true)}${changeUnit}`;
    facts[`${item.key}_size`] = `${formatValue(item.change === null ? null : String(item.change).replace(/^-/, ''), evidence.unit)}${changeUnit}`;
    return { label: item.label, value: `{{${item.key}_value}}`, valueExact: item.value, change: `{{${item.key}_change}}`, size: `{{${item.key}_size}}`, changeExact: item.change,
      direction: item.change === null ? 'unavailable' : BigInt(item.change) > 0 ? 'increased' : BigInt(item.change) < 0 ? 'decreased' : 'unchanged' };
  });
  const rankings = evidence.dimension === 'chain' ? summary.points.slice(0, 5).map((point, index) => {
    const id = `rank_${String.fromCharCode(97 + index)}`;
    facts[`${id}_chain`] = point.date;
    facts[`${id}_volume`] = `${formatValue(point.values.volume, evidence.unit)} USD`;
    return { chain: `{{${id}_chain}}`, volume: `{{${id}_volume}}` };
  }) : undefined;
  const insights = buildInsights(evidence, spec, summary);
  Object.assign(facts, insights.facts);
  return { evidenceKey, facts, dataContext: { start: summary.start, end: summary.end, retrievedAt: evidence.receivedAt, source: evidence.source, label: evidence.sourceLabel }, input: { metric: spec.metric, pool: spec.pool, rankings, period: spec.period, units: evidence.unit, integerEncoding: evidence.csvUnit, window: { start: summary.start, end: summary.end }, series, analysis: insights.analysis, facts, methodology: evidence.note, coverage: { observedThrough: '{{end_date}}', meaning: 'Latest returned observation date, not a verified indexer refresh time. Describe this date when recency matters; do not invent a freshness status.' } } };
}

// Only a numeric server fact can supply a unit. Bare SQL cells, dates and
// labels stay untouched: their surrounding prose may still need a unit.
const unitNames = 'percentage points?|percent(?:age)?|transactions?|address(?:es)?|records?|blocks?|swaps?|days?|hours?|minutes?|seconds?|bytes?|zatoshis?|zats?|ZEC|USD|%';
const factUnit = new RegExp(`^[+\\-−]?[\\p{N}][\\p{N}\\p{Zs}.,'’\\u066b\\u066c]*\\s*(${unitNames})$`, 'iu');
const followingUnit = new RegExp(`^[^\\S\\r\\n]*(${unitNames})(?![\\p{L}\\p{N}_\\p{Pd}])`, 'iu');
function unitKey(unit) {
  const value = unit.toLowerCase().replace(/\s+/g, ' ');
  if (/^(?:%|percent(?:age)?)$/.test(value)) return '%';
  if (/^percentage points?$/.test(value)) return 'percentage point';
  if (/^(?:zatoshis?|zats?)$/.test(value)) return 'zatoshi';
  if (/^(?:address|addresses)$/.test(value)) return 'address';
  return /^(?:transactions?|records?|blocks?|swaps?|days?|hours?|minutes?|seconds?|bytes?)$/.test(value) ? value.replace(/s$/, '') : value;
}
function substituteFacts(text, facts) {
  let rendered = '', cursor = 0;
  for (const match of text.matchAll(/\{\{([a-z_]+)\}\}/g)) {
    const value = facts[match[1]], unit = typeof value === 'string' ? factUnit.exec(value)?.[1] : null;
    rendered += text.slice(cursor, match.index) + value;
    cursor = match.index + match[0].length;
    if (!unit) continue;
    let suffix;
    while ((suffix = followingUnit.exec(text.slice(cursor)))) {
      if (unitKey(suffix[1]) !== unitKey(unit)) throw new Error('Conflicting evidence unit');
      cursor += suffix[0].length;
    }
  }
  return rendered + text.slice(cursor);
}

// "fell by −35 ZEC" repeats its direction; drop a sign that agrees with the
// preceding word. A contradicting pair ("rose by −35") is left as written.
const FALLING = 'fell|decreased|declined|dropped|lost|shrank|down', RISING = 'rose|increased|grew|gained|climbed|up';
function tidySigns(text) {
  return text.replace(new RegExp(`\\b(${FALLING}) by [−-](?=\\d)`, 'gi'), '$1 by ').replace(new RegExp(`\\b(${RISING}) by \\+(?=\\d)`, 'gi'), '$1 by ');
}
function renderExplanation(raw, facts) {
  const parsed = explanationSchema.parse(raw);
  function render(raw) {
    // Invisible format characters (e.g. U+180E seen on staging) never reach readers.
    // A fact ID written without braces ("over the start_date to …") is repaired
    // into its placeholder, and a stray combining mark at a word start (seen
    // in front of one on production) is dropped.
    const ids = Object.keys(facts).filter(id => id.includes('_'));
    const unbraced = ids.length ? new RegExp(`(?<!\\{\\{)\\b(${ids.join('|')})\\b(?!\\}\\})`, 'g') : null;
    let text = raw.replace(/\p{Cf}/gu, '').replace(/(^|\s)\p{M}+/gu, '$1');
    if (unbraced) text = text.replace(unbraced, '{{$1}}');
    let remainder = text.replace(/\{\{([a-z_]+)\}\}/g, (_, id) => {
      if (!Object.hasOwn(facts, id)) throw new Error('Unknown evidence reference');
      return '';
    });
    for (const literal of literalFacts(facts)) remainder = remainder.replace(new RegExp(`\\b${literal.replace(' ', '\\s')}\\b`, 'g'), '');
    // Unassigned and private-use code points can masquerade as digits (U+0C73
    // stood in for "317" on staging) and are never valid prose.
    if (/[\p{N}\p{So}\p{Cn}\p{Co}{}<>]|https?:|www\./iu.test(remainder)) throw new Error('Unvalidated numerical claim or markup');
    return tidySigns(substituteFacts(text, facts));
  }
  return { summary: render(parsed.summary), observations: parsed.observations.map(render), limitation: render(parsed.limitation) };
}

module.exports = { explainRequestSchema, explanationTask, explanationTaskFor, evidenceProse, loadExplanationEvidence, renderExplanation };
