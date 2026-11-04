'use strict';

const { formatValue } = require('../../../../lib/ask/data');
const DAY = 86400000;
const abs = value => value < 0n ? -value : value;
const direction = value => value > 0n ? 'increased' : value < 0n ? 'decreased' : 'unchanged';
// Percentage in basis points, rounded once using exact source integers.
const percentage = (numerator, denominator) => denominator > 0n
  ? ((abs(numerator) * 10000n + denominator / 2n) / denominator) * (numerator < 0n ? -1n : 1n) : null;
const dateBefore = (date, days) => new Date(Date.parse(date) - days * DAY).toISOString().slice(0, 10);

const analysisGuidance = `For transaction busiest-day or daily-ranking questions use dailyRanking when present, naming its metric and completed UTC-day scope. Never add separate category peaks, which may occur on different dates. If missingDays is nonzero, describe the largest observed day and mention the incomplete requested window instead of claiming a definitive full-period maximum. For transaction rankings state that mining reward transactions are excluded. Answer top-five requests from the ranked rows, not a single peak. For data questions, lead with the strongest relevant finding and explain its significance, not a list of ending values. Use the supplied analysis: comparisons, changes in share, peak concentration, observed timing and recent pace. Choose at most two supporting observations that add different information. For an Orchard/Ironwood comparison, open with the shift in dominance and the combined percentage growth, using the two-pool denominator. Put at most one timing or pace finding next. Do not open by listing each pool's absolute movement when these stronger comparisons are available. Explain significance in plain language. Avoid analyst boilerplate such as "returned daily snapshot", "supplied window", or "not an exact crossing time"; say "first led in the daily records". Keep the whole answer around one hundred words. Name the denominator naturally, for example 'across Orchard and Ironwood' or 'across the selected pools'; do not follow an already explicit denominator with an exclusion disclaimer. Balance growth beyond an offsetting decline means redistribution alone cannot explain the combined change; it does not prove new capital, buying or an exact transfer route. A first-observed lead is a daily snapshot in this window, not a protocol activation date or an exact transfer time. Recent pace compares the two explicitly dated windows; it is not a forecast. When asked whether balances will rise or fall, answer that forward-looking question: distinguish the observed historical direction from a conditional outlook. If the latest complete combined-pool interval increased, continued net additions would support further growth; if it decreased, continued net withdrawals would support contraction. State that the continuation is uncertain, not a prediction. Do not replace a future question with only a historical summary or invent missing data. For overall shielded trends use selectedPools and its recentComparison; offsetting shifts between individual pools do not establish overall growth or contraction. Coverage.observedDays and series.hasObservedValues describe actual data availability; a forecast being unavailable does not mean historical observations are unavailable. When numeric change starts with a sign, prefer the unsigned movement fact with the supplied direction ("rose by", not "rose by +"). Use calendar coverage and null counts to qualify incomplete results. Do not call source observations current without a known observation date. Put any necessary methodological qualification in the limitation field only, never repeat cautions across summary and observations. Name denominators naturally in the finding rather than adding a separate exclusion disclaimer. Leave limitation empty by default. Add a single short, relevant caveat only when an actual coverage issue or a causal question changes the interpretation; do not repeat generic statements about private wallets, identities, or missing causes. Do not say "the supplied data/documents" or narrate internal tools. If asked why, distinguish what the data demonstrates from causes that would need other evidence. Never invent a cause, trace private transfers, or calculate new numerical claims in prose. If an insight is unavailable, omit it rather than inventing one.`;

function buildInsights(evidence, spec, summary) {
  const facts = {};
  const fact = (id, value) => { facts[id] = value; return `{{${id}}}`; };
  const quantity = (id, value, unit = evidence.unit) => fact(id, `${formatValue(String(value), unit)} ${unit}`);
  const percent = (id, value) => value === null ? null : quantity(id, value, '%');
  const points = summary.points;
  const series = evidence.series;
  const snapshot = ['balances', 'migration_share'].includes(spec.metric);
  const unit = evidence.unit === '%' ? 'percentage points' : evidence.unit;
  const movement = (id, value) => fact(id, `${formatValue(String(abs(value)), evidence.unit)} ${unit}`);
  if (evidence.dimension === 'chain') {
    const values = points.map(point => point.values.volume);
    const total = values.every(value => value !== null) ? values.reduce((sum, value) => sum + BigInt(value), 0n) : null;
    return { facts, analysis: { ranking: total > 0n && points.length ? {
      leadingChain: fact('leading_chain', points[0].date),
      leadingShare: percent('leading_chain_share', percentage(BigInt(values[0]), total)),
      denominator: 'Sum of returned tracked chain USD valuations in the requested direction; not all market volume.',
    } : null } };
  }
  const byDate = new Map(points.map(point => [point.date, point]));
  const calendarDays = (Date.parse(summary.end) - Date.parse(summary.start)) / DAY + 1;
  const coverage = {
    calendarDays: fact('calendar_days', String(calendarDays)),
    missingDates: fact('missing_dates', String(calendarDays - points.length)),
    completeDates: calendarDays === points.length,
    observedDays: points.length,
    scope: 'Returned observation window. Missing dates and null values are unknown, never zero. The latest day may be partial; the observation date is not an indexer refresh timestamp.',
  };
  function interval(key, end, days) {
    // Stock changes need both endpoints (eight snapshots for seven days).
    const start = dateBefore(end, snapshot ? days : days - 1);
    const values = [];
    for (let date = start; date <= end; date = dateBefore(date, -1)) {
      const point = byDate.get(date);
      const value = key === '__selected_pools'
        ? point && series.every(item => point.values[item.key] != null)
          ? series.reduce((sum, item) => sum + BigInt(point.values[item.key]), 0n).toString() : null
        : point?.values[key];
      if (value === null || value === undefined) return null;
      values.push(BigInt(value));
    }
    return { start, end, value: snapshot ? values.at(-1) - values[0] : values.reduce((sum, value) => sum + value, 0n) };
  }
  const details = series.map(({ key, label }) => {
    const valid = points.filter(point => point.values[key] !== null);
    const first = points[0].values[key];
    const last = points.at(-1).values[key];
    const change = first !== null && last !== null && points.length > 1 ? BigInt(last) - BigInt(first) : null;
    const detail = {
      label,
      observedValues: valid.length,
      hasObservedValues: valid.length > 0,
      missingValues: fact(`${key}_missing`, String(points.length - valid.length)),
      startValue: first === null ? null : quantity(`${key}_start`, BigInt(first)),
      ...(snapshot && change !== null ? {
        movement: movement(`${key}_movement`, change), direction: direction(change),
        relativeChange: evidence.unit === '%' ? null : percent(`${key}_relative_change`, percentage(abs(change), BigInt(first))),
      } : {}),
    };
    if (!valid.length) return detail;
    const peak = valid.reduce((best, point) => BigInt(point.values[key]) > BigInt(best.values[key]) ? point : best);
    detail.peak = { date: fact(`${key}_peak_date`, peak.date), value: quantity(`${key}_peak_value`, BigInt(peak.values[key])), scope: 'Highest observed daily value, earliest date in a tie; not an intraday maximum.' };
    if (!snapshot && valid.length === points.length) {
      const total = valid.reduce((sum, point) => sum + BigInt(point.values[key]), 0n);
      detail.peak.shareOfReturnedTotal = percent(`${key}_peak_share`, percentage(BigInt(peak.values[key]), total));
    }
    const today = (evidence.meta?.generatedAt || new Date().toISOString()).slice(0, 10);
    const recentEnd = !snapshot && summary.end >= today ? dateBefore(today, 1) : summary.end;
    const recent = interval(key, recentEnd, 7);
    const previous = interval(key, dateBefore(recentEnd, 7), 7);
    if (recent && previous) {
      const expose = (window, suffix) => ({
        start: fact(`${key}_${suffix}_start`, window.start), end: fact(`${key}_${suffix}_end`, window.end),
        value: snapshot ? movement(`${key}_${suffix}_value`, window.value) : quantity(`${key}_${suffix}_value`, window.value),
        ...(snapshot ? { direction: direction(window.value) } : {}),
      });
      detail.recentComparison = { recent: expose(recent, 'recent'), previous: expose(previous, 'previous'), measure: snapshot ? 'Net balance change over adjacent seven-day intervals.' : 'Totals for adjacent complete seven-calendar-day buckets; not per-day averages.',
        pattern: !snapshot ? recent.value > previous.value ? 'higher recent total' : recent.value < previous.value ? 'lower recent total' : 'equal bucket totals' : recent.value > 0n && previous.value > 0n ? recent.value > previous.value ? 'growth accelerated' : recent.value < previous.value ? 'growth slowed' : 'same positive pace' : 'compare signed directions; do not infer acceleration from magnitude alone',
      };
    }
    if (snapshot) {
      const windows = points.map(point => interval(key, point.date, 7)).filter(Boolean);
      const strongest = windows.reduce((best, window) => !best || abs(window.value) > abs(best.value) ? window : best, null);
      if (strongest && strongest.value !== 0n) detail.strongestWeek = {
        start: fact(`${key}_strongest_start`, strongest.start), end: fact(`${key}_strongest_end`, strongest.end),
        movement: movement(`${key}_strongest_movement`, strongest.value), direction: direction(strongest.value),
        scope: 'Largest absolute net change among complete rolling seven-day intervals in the returned window. Not gross flow or a cause.',
      };
    }
    return detail;
  });
  let dailyRanking = null;
  if (spec.metric === 'transactions') {
    const today = (evidence.meta?.generatedAt || new Date().toISOString()).slice(0, 10);
    const days = spec.period === '1y' ? 365 : Number(spec.period.slice(0, -1));
    const start = spec.start && spec.start > dateBefore(today, days) ? spec.start : dateBefore(today, days);
    const end = spec.end && spec.end < today ? spec.end : dateBefore(today, 1);
    const candidates = points.filter(point => point.date >= start && point.date <= end
      && point.values.shielded != null && point.values.transparent != null)
      .map(point => ({ date: point.date, value: BigInt(point.values.shielded) + BigInt(point.values.transparent) }));
    const expected = Math.max(0, (Date.parse(end) - Date.parse(start)) / DAY + 1);
    const missing = expected - candidates.length;
    const ranked = candidates.sort((a, b) => a.value === b.value ? a.date.localeCompare(b.date) : a.value > b.value ? -1 : 1).slice(0, 5);
    dailyRanking = {
      metric: 'Shielded plus transparent transactions; mutually exclusive source categories, excluding coinbase mining rewards.',
      start: fact('ranking_start', start), end: fact('ranking_end', end),
      missingDays: fact('ranking_missing_days', String(missing)), completeWindow: missing === 0 && expected > 0,
      scope: 'Completed UTC calendar days only; excludes today, future dates and days with an unknown category. Date completeness does not prove indexer synchronization. Ties use the earliest date.',
      rows: ranked.map((point, index) => ({ date: fact(`daily_rank_${String.fromCharCode(97 + index)}_date`, point.date), value: quantity(`daily_rank_${String.fromCharCode(97 + index)}_value`, point.value) })),
    };
  }
  let comparison = null;
  if (spec.metric === 'balances' && series.some(item => item.key === 'ironwood') && series.some(item => item.key === 'orchard')) {
    const pair = points.filter(point => point.values.ironwood !== null && point.values.orchard !== null);
    const start = pair.find(point => point.date === summary.start);
    const end = pair.find(point => point.date === summary.end);
    if (start && end && start.date !== end.date) {
      const initial = BigInt(start.values.ironwood) + BigInt(start.values.orchard);
      const final = BigInt(end.values.ironwood) + BigInt(end.values.orchard);
      comparison = { pools: ['Orchard', 'Ironwood'], denominator: 'Orchard plus Ironwood only, not all shielded pools or issued supply.',
        combinedEnd: quantity('combined_balance', final), combinedMovement: movement('combined_movement', final - initial), combinedDirection: direction(final - initial),
        combinedRelativeChange: percent('combined_relative_change', percentage(abs(final - initial), initial)),
        ironwoodStartShare: percent('ironwood_start_share', percentage(BigInt(start.values.ironwood), initial)),
        ironwoodEndShare: percent('ironwood_end_share', percentage(BigInt(end.values.ironwood), final)),
      };
      const lead = pair.find(point => BigInt(point.values.ironwood) > BigInt(point.values.orchard));
      if (lead && BigInt(start.values.ironwood) <= BigInt(start.values.orchard)) comparison.firstObservedIronwoodLead = {
        date: fact('ironwood_first_lead_date', lead.date),
        scope: 'First returned daily snapshot with Ironwood above Orchard in this window; missing observations can hide an earlier crossover. Not an exact intraday crossing.',
      };
    }
  } else if (!snapshot && series.length === 2 && summary.totals.every(item => item.value !== null)) {
    const a = BigInt(summary.totals[0].value); const b = BigInt(summary.totals[1].value);
    comparison = { first: series[0].label, second: series[1].label,
      difference: quantity('series_difference', abs(a - b)), larger: a > b ? series[0].label : b > a ? series[1].label : 'equal',
      firstShare: percent('first_series_share', percentage(a, a + b)),
      scope: 'Totals of returned days in these two categories only. Shielding difference is public net flow; swap difference is tracked swap imbalance; transaction difference is a count comparison. None measures net capital or unique users.',
    };
  }
  let selectedPools = null;
  if (spec.metric === 'balances' && series.length > 1 && points.length > 1) {
    const first = points[0]; const last = points.at(-1);
    if (series.every(({ key }) => first.values[key] !== null && last.values[key] !== null)) {
      const initial = series.reduce((sum, { key }) => sum + BigInt(first.values[key]), 0n);
      const final = series.reduce((sum, { key }) => sum + BigInt(last.values[key]), 0n);
      const leader = series.reduce((best, item) => BigInt(last.values[item.key]) > BigInt(last.values[best.key]) ? item : best);
      selectedPools = {
        denominator: series.map(item => item.label).join(' + '),
        endBalance: quantity('selected_pools_balance', final),
        movement: movement('selected_pools_movement', final - initial), direction: direction(final - initial),
        relativeChange: percent('selected_pools_relative_change', percentage(abs(final - initial), initial)),
        leadingPool: fact('selected_pools_leader', leader.label),
        leadingShare: percent('selected_pools_leader_share', percentage(BigInt(last.values[leader.key]), final)),
        scope: 'Selected pools only. Balance changes are not trading volume, unique users or proof of a transfer route.',
      };
      const recent = interval('__selected_pools', summary.end, 7);
      const previous = interval('__selected_pools', dateBefore(summary.end, 7), 7);
      if (recent && previous) {
        const expose = (window, suffix) => ({
          start: fact(`selected_pools_${suffix}_start`, window.start), end: fact(`selected_pools_${suffix}_end`, window.end),
          movement: movement(`selected_pools_${suffix}_movement`, window.value), direction: direction(window.value),
        });
        selectedPools.recentComparison = { recent: expose(recent, 'recent'), previous: expose(previous, 'previous'), measure: 'Combined selected-pool net balance changes over adjacent seven-day intervals; internal pool redistribution cancels out. Not a forecast.' };
      }
    }
  }
  return { facts, analysis: { coverage, series: details, comparison, selectedPools, dailyRanking } };
}

module.exports = { buildInsights, analysisGuidance };
