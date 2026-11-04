'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';
import { ChartShareControl } from '@/components/charts/ChartShareControl';
import { captureElementPng } from '@/lib/chart-export';
import { toCsv } from '@/lib/csv';

export interface PanelCsv {
  headers: string[];
  rows: unknown[][];
}

/**
 * Share menu for an interactive panel outside the chart catalog: a PNG of the
 * panel, a link to the current view (including URL-backed periods) and,
 * when rows are provided, a CSV of the plotted data.
 */
export function PanelShareControl({ title, panelRef, fileName, csv, disabled = false }: {
  title: string;
  panelRef: RefObject<HTMLElement | null>;
  fileName: string;
  csv?: () => PanelCsv | null;
  disabled?: boolean;
}) {
  const [shareUrl, setShareUrl] = useState('');
  const refreshUrl = useCallback(() => setShareUrl(window.location.href), []);
  useEffect(refreshUrl, [refreshUrl]);
  const capture = useCallback(() => {
    if (!panelRef.current) return Promise.reject(new Error('Chart unavailable'));
    return captureElementPng(panelRef.current);
  }, [panelRef]);
  const csvText = csv ? () => {
    const data = csv();
    return data ? toCsv(data.headers, data.rows) : toCsv(['No data'], []);
  } : undefined;
  return (
    <span onPointerDownCapture={refreshUrl} onFocusCapture={refreshUrl} className="contents">
      <ChartShareControl
        title={title}
        shareUrl={shareUrl}
        shareText={`${title} · ZecBlock`}
        fileName={`${fileName}.png`}
        capture={capture}
        csvText={csvText}
        disabled={disabled}
      />
    </span>
  );
}

/**
 * CSV rows from a chart's flat data points. Columns are the union of scalar
 * fields; epoch timestamp fields are also written as UTC ISO strings.
 */
export function objectRowsCsv(points: ReadonlyArray<object> | null | undefined): PanelCsv | null {
  if (!points?.length) return null;
  const records = points as ReadonlyArray<Record<string, unknown>>;
  const keys: string[] = [];
  for (const point of records) {
    for (const [key, value] of Object.entries(point)) {
      if (!keys.includes(key) && (value == null || ['string', 'number', 'boolean'].includes(typeof value))) keys.push(key);
    }
  }
  const timeKeys = keys.filter(key => /^(timestamp|time|ts|blockTime)$/i.test(key));
  const iso = (value: unknown) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Date(n > 1e11 ? n : n * 1000).toISOString();
  };
  return {
    headers: [...timeKeys.map(key => `${key} (UTC)`), ...keys],
    rows: records.map(point => [...timeKeys.map(key => iso(point[key])), ...keys.map(key => point[key] ?? '')]),
  };
}
