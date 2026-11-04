/**
 * Quote one CSV cell. Text that a spreadsheet would evaluate as a formula is
 * prefixed with an apostrophe; plain numbers, including negatives, are kept.
 */
export function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  const formulaLike = /^[=+\-@\t\r]/.test(text) && !/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text);
  return `"${(formulaLike ? `'${text}` : text).replace(/"/g, '""')}"`;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Exact decimal ZEC from an integer zatoshi string, without floating point. */
export function zatToZecString(zat: string | bigint): string {
  const value = BigInt(zat);
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const whole = abs / BigInt(100_000_000);
  const fraction = (abs % BigInt(100_000_000)).toString().padStart(8, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
