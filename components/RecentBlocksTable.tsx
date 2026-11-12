'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { formatBytesCompact } from '@/lib/format-numbers';
import { RelativeTime } from '@/components/RelativeTime';

export interface RecentBlockRow {
  height: number;
  timestamp: number;
  transactions: number;
  size: number;
}

/**
 * The homepage "recent blocks" table, data-only so the public homepage and
 * the private explorer (fed from its signed feed) render the same design.
 */
export function RecentBlocksTable({ blocks, footer }: { blocks: RecentBlockRow[]; footer?: ReactNode }) {
  return (
    <div className="card p-0 overflow-hidden">
      {/* overflow-x-auto, not overflow-hidden: never silently clip a column, scroll instead */}
      <div className="overflow-x-auto no-scrollbar">
        {/* Live-row animations — DataTable lacks per-row classes; classes mirror its conventions */}
        <table className="w-full min-w-[420px]">
          <thead>
            <tr>
              <th className="px-4 sm:px-5 py-3.5 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Block</th>
              <th className="px-4 sm:px-5 py-3.5 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Size</th>
              <th className="px-4 sm:px-5 py-3.5 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">TXs</th>
              <th className="px-4 sm:px-5 py-3.5 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Age</th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((block, i) => (
              <tr
                key={block.height}
                className="group transition-colors duration-100 hover:bg-cipher-hover animate-fade-in-up"
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <td className="px-4 sm:px-5 h-12 border-b border-cipher-border">
                  <Link href={`/block/${block.height}`} prefetch={false} className="font-mono text-sm font-medium text-primary group-hover:text-primary transition-colors tabular-nums">
                    #{block.height.toLocaleString()}
                  </Link>
                </td>
                <td className="px-4 sm:px-5 h-12 border-b border-cipher-border text-right">
                  <span className="font-mono text-xs text-muted whitespace-nowrap tabular-nums">{block.size > 0 ? formatBytesCompact(block.size) : '—'}</span>
                </td>
                <td className="px-4 sm:px-5 h-12 border-b border-cipher-border text-right">
                  <span className="font-mono text-sm text-primary tabular-nums">{block.transactions}</span>
                </td>
                <td className="px-4 sm:px-5 h-12 border-b border-cipher-border text-right">
                  <RelativeTime timestamp={block.timestamp} className="text-sm text-muted whitespace-nowrap" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer && <div className="px-4 py-3 border-t border-cipher-border flex items-center justify-center text-center">{footer}</div>}
    </div>
  );
}
