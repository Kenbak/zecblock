// Format captured integer zatoshis without a floating-point conversion.
export function exactZec(value: unknown, signed = false): string | null {
  if (typeof value !== 'string' || !(signed ? /^-?(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/).test(value)) return null;
  const negative = value.startsWith('-');
  const digits = (negative ? value.slice(1) : value).padStart(9, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -8)}.${digits.slice(-8)}`;
}

export function privateFeeLabel(detail: Record<string, unknown>): string {
  const exact = exactZec(detail.feeZat);
  return exact !== null ? `${exact} ZEC` : detail.isCoinbase === true ? 'Not applicable (coinbase)' : 'Unavailable';
}
