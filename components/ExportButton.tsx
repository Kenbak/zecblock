'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { toCsv } from '@/lib/csv';

interface ExportButtonProps {
  data: any;
  csvData?: any[]; // Optional: separate data source for CSV (e.g., transactions array)
  filename: string;
  type: 'json' | 'csv' | 'both';
  csvHeaders?: string[];
  csvMapper?: (item: any) => string[];
  label?: string;
}

export function ExportButton({
  data,
  csvData,
  filename,
  type,
  csvHeaders,
  csvMapper,
  label = 'Export'
}: ExportButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  // Portal-rendered to document.body (like Tooltip/IconTooltip) — a plain
  // absolutely-positioned dropdown here sits inside a header block that's an
  // earlier DOM sibling of the facts card below it. The facts card's own
  // backdrop-filter (glass effect) creates a new stacking context, and as a
  // later sibling it paints over an in-flow dropdown regardless of the
  // dropdown's own z-index — portaling to body sidesteps that entirely.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number } | null>(null);

  const computeDropdownPos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setDropdownPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    computeDropdownPos();
    const reposition = () => computeDropdownPos();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [isOpen, computeDropdownPos]);

  const downloadFile = (content: string, ext: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setExported(ext.toUpperCase());
    setTimeout(() => setExported(null), 2000);
  };

  const exportAsJson = () => {
    const json = JSON.stringify(data, null, 2);
    downloadFile(json, 'json', 'application/json');
    setIsOpen(false);
  };

  const exportAsCsv = () => {
    if (!csvHeaders || !csvMapper) {
      console.error('CSV export requires headers and mapper');
      return;
    }

    // Use csvData if provided, otherwise fall back to data
    const sourceData = csvData !== undefined ? csvData : data;
    const items = Array.isArray(sourceData) ? sourceData : [sourceData];
    const csvContent = toCsv(csvHeaders, items.map(csvMapper));

    downloadFile(csvContent, 'csv', 'text/csv');
    setIsOpen(false);
  };

  // For single format, just show a button
  if (type === 'json') {
    return (
      <button
        onClick={exportAsJson}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-secondary hover:text-primary border border-cipher-border hover:bg-cipher-hover rounded-md transition"
        title="Export as JSON"
      >
        {exported === 'JSON' ? (
          <>
            <svg className="w-4 h-4 text-cipher-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="hidden sm:inline">Exported!</span>
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span className="hidden sm:inline">{label} JSON</span>
          </>
        )}
      </button>
    );
  }

  if (type === 'csv') {
    return (
      <button
        onClick={exportAsCsv}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-secondary hover:text-primary border border-cipher-border hover:bg-cipher-hover rounded-md transition"
        title="Export as CSV"
      >
        {exported === 'CSV' ? (
          <>
            <svg className="w-4 h-4 text-cipher-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="hidden sm:inline">Exported!</span>
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span className="hidden sm:inline">{label} CSV</span>
          </>
        )}
      </button>
    );
  }

  // For 'both', show a dropdown
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-secondary hover:text-primary border border-cipher-border hover:bg-cipher-hover rounded-md transition"
      >
        {exported ? (
          <>
            <svg className="w-4 h-4 text-cipher-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="hidden sm:inline">{exported} Exported!</span>
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span className="hidden sm:inline">{label}</span>
            <svg className="w-3 h-3 hidden sm:block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </>
        )}
      </button>

      {isOpen && dropdownPos && typeof document !== 'undefined' && createPortal(
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown */}
          <div
            className="dropdown-menu fixed w-40 border rounded-lg shadow-xl z-[9999] overflow-hidden"
            style={{ top: dropdownPos.top, right: dropdownPos.right }}
          >
            <button
              onClick={exportAsJson}
              className="dropdown-item w-full px-4 py-2 text-left text-sm transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
              JSON
            </button>
            {csvHeaders && csvMapper && (
              <button
                onClick={exportAsCsv}
                className="dropdown-item w-full px-4 py-2 text-left text-sm transition-colors flex items-center gap-2 border-t navbar-border"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                CSV
              </button>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
