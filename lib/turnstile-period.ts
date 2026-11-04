export type TurnstilePeriod = 'nu6.2' | '30d' | '90d' | '1y' | 'all';

/** Only one recognized period may select the initial Turnstile window. */
export function parseTurnstilePeriod(value: unknown): TurnstilePeriod {
  switch (value) {
    case 'nu6.2':
    case '30d':
    case '90d':
    case '1y':
    case 'all':
      return value;
    default:
      return '30d';
  }
}
