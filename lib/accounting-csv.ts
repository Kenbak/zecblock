import { zatToZecString } from './csv';

export type AccountingCsvPoint = {
  timestamp: number; firstHeight: number; lastHeight: number; blocks: number; feeBlocks: number; missingBlocks: number; nsmSamples: number;
  feesPaidZat: string | null; feesToNsmZat: string | null; minerFeeAllocationZat: string | null; minerReceiptsZat: string | null;
  nsmBalanceZat: string | null; cumulativeRemovalZat: string | null; nsmSampleHeight?: number | null; nsmSampleHash?: string | null;
};

const ZAT_FIELDS = ['feesPaidZat', 'feesToNsmZat', 'minerFeeAllocationZat', 'minerReceiptsZat', 'nsmBalanceZat', 'cumulativeRemovalZat'] as const;

/**
 * One CSV row per reported NSM/fee accounting bucket: exact integer zatoshis
 * plus exact decimal ZEC. Unavailable amounts stay blank, never 0.
 */
export function accountingCsv(points: ReadonlyArray<AccountingCsvPoint>, currency: string): { headers: string[]; rows: unknown[][] } | null {
  if (!points.length) return null;
  const unit = currency.toLowerCase();
  const exact = (value: string | null) => value != null && /^-?\d+$/.test(value) ? value : '';
  return {
    headers: ['bucket_start_utc', 'first_height', 'last_height', 'blocks', 'fee_blocks', 'missing_blocks', 'nsm_samples',
      ...ZAT_FIELDS.flatMap(field => [field.replace(/Zat$/, '_zat'), field.replace(/Zat$/, `_${unit}`)]),
      'nsm_sample_height', 'nsm_sample_hash'],
    rows: points.map(point => [new Date(point.timestamp * 1000).toISOString(), point.firstHeight, point.lastHeight, point.blocks,
      point.feeBlocks, point.missingBlocks, point.nsmSamples,
      ...ZAT_FIELDS.flatMap(field => { const zat = exact(point[field]); return [zat, zat ? zatToZecString(zat) : '']; }),
      point.nsmSampleHeight ?? '', point.nsmSampleHash ?? '']),
  };
}
