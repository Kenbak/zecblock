'use strict';

function utcDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Invalid analytics date');
  return date;
}
function formatter(locale = 'en') {
  return new Intl.DateTimeFormat(locale === 'en' || locale === 'auto' ? 'en-GB' : locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function formatAnalyticsDate(value, locale) { return formatter(locale).format(utcDate(value)); }
function formatAnalyticsRange(start, end, locale) {
  return start === end ? formatAnalyticsDate(start, locale) : formatter(locale).formatRange(utcDate(start), utcDate(end));
}
function analyticsPeriod(plan, row) {
  const end = utcDate(row.date);
  if (plan.bucket === 'week') end.setUTCDate(end.getUTCDate() + 6);
  if (plan.bucket === 'month') end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const calendarEnd = end.toISOString().slice(0, 10);
  const start = row.date < plan.start ? plan.start : row.date;
  const through = calendarEnd > plan.end ? plan.end : calendarEnd;
  return { start, end: through, partial: start !== row.date || through !== calendarEnd };
}
module.exports = { formatAnalyticsDate, formatAnalyticsRange, analyticsPeriod };
