import type { ReactNode } from "react";

/** Card title matching ChartCard, for list and table panels without a chart watermark. */
export function PanelTitle({
  title,
  controls,
  className = "",
}: {
  title: string;
  controls?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start sm:items-center justify-between gap-2 sm:gap-3 flex-wrap ${className}`}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-muted font-mono uppercase tracking-widest opacity-50" aria-hidden="true">{">"}</span>
        <h2 className="text-sm font-medium font-mono text-secondary lowercase tracking-tight truncate">{title}</h2>
      </div>
      {controls}
    </div>
  );
}

/** `<summary>` for a collapsible card; the parent `<details>` needs the `group` class. */
export function DisclosureSummary({ title }: { title: string }) {
  return (
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
      <span className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-muted font-mono uppercase tracking-widest opacity-50" aria-hidden="true">{">"}</span>
        <span className="text-sm font-medium font-mono text-secondary lowercase tracking-tight">{title}</span>
      </span>
      <span className="text-muted transition-transform group-open:rotate-90" aria-hidden="true">›</span>
    </summary>
  );
}
