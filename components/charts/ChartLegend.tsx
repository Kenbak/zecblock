'use client';

import type { ComponentProps } from 'react';
import { Legend } from 'recharts';

/**
 * Shared legend for every Recharts view: a small square swatch in the series color
 * and a muted label, left-aligned under the plot. Matches the chart library's legend.
 */
export function ChartLegend({ wrapperStyle, formatter, ...props }: ComponentProps<typeof Legend>) {
  return <Legend
    align="left"
    verticalAlign="bottom"
    iconType="square"
    iconSize={8}
    {...props}
    wrapperStyle={{ ...wrapperStyle, fontSize: 12, paddingTop: 8 }}
    formatter={(value, entry, index) => (
      <span className="text-muted">{formatter ? formatter(value, entry, index) : value}</span>
    )}
  />;
}
