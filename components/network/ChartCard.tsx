'use client';

import { ReactNode } from 'react';
import { Card, CardBody } from '@/components/ui/Card';
import { ChartWatermark, type WatermarkSize } from '@/components/ChartWatermark';

interface ChartCardProps {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  controls?: ReactNode;
  className?: string;
  height?: number;
  /** When true, the card stretches to fill its parent (e.g. a grid row) and the chart area grows to use all remaining space. */
  fill?: boolean;
  watermarkSize?: WatermarkSize;
}

export function ChartCard({
  title,
  icon,
  children,
  controls,
  className = '',
  height = 320,
  fill = false,
}: ChartCardProps) {
  return (
    <Card className={`${fill ? 'h-full' : ''} ${className}`}>
      <CardBody className={fill ? 'h-full flex flex-col' : undefined}>
        <div className="flex items-start sm:items-center justify-between gap-2 sm:gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            {icon ? (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center text-cipher-gold" aria-hidden="true">{icon}</span>
            ) : (
              <span className="text-xs text-muted font-mono uppercase tracking-widest opacity-50" aria-hidden="true">{'>'}</span>
            )}
            <h2 className="text-sm font-medium font-mono text-secondary lowercase tracking-tight truncate">{title}</h2>
          </div>
          {controls}
        </div>
        <div className={`relative rounded-lg ${fill ? 'flex-1 min-h-0' : ''}`} style={fill ? undefined : { minHeight: height }}>
          <div className={`relative z-[1] px-0.5 pb-1 ${fill ? 'h-full' : ''}`}>{children}</div>
        </div>
        <ChartWatermark />
      </CardBody>
    </Card>
  );
}
