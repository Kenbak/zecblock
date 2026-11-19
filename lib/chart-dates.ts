export function formatChartDate(dateStr: string) {
  const iso = dateStr.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return dateStr;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  const currentYear = new Date().getFullYear();

  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: year !== currentYear ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
}

export function tooltipDate(
  payload: Array<{ payload?: Record<string, unknown> }> | undefined,
  label?: string,
): string {
  const raw = payload?.[0]?.payload?.date;
  return formatChartDate(String(raw ?? label ?? ''));
}

/**
 * The axis label every chart uses for a day ("Oct 21") or an hour ("Oct 21, 14:00"),
 * from a "YYYY-MM-DD" or "MM-DD HH:MM" bucket label. Anything else is shown as given.
 */
export function formatBucketLabel(value: unknown): string {
  const text = String(value ?? '');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) return `${MONTHS[Number(day[2]) - 1] ?? day[2]} ${Number(day[3])}`;
  const hour = /^(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(text);
  if (hour) return `${MONTHS[Number(hour[1]) - 1] ?? hour[1]} ${Number(hour[2])}, ${hour[3]}`;
  return text;
}
