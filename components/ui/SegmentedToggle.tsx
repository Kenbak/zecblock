'use client';

/**
 * SegmentedToggle — quiet, neutral pill switch for a small, fixed set of
 * mutually-exclusive *display modes* of the same content (e.g. Decoded JSON
 * vs Hex, or the block/tx page's section-jump nav). The active option is a
 * raised neutral chip (bg-cipher-bg + a faint ring), not a colored fill —
 * visually aligned with FilterGroup's `.filter-btn-active` (both use neutral
 * raised chips), but this component is for display-mode toggles rather than
 * data filters (narrowing a list). The distinction is semantic, not visual.
 * is selected. Switching how the same data is displayed isn't a filter and
 * shouldn't borrow that same visual loudness.
 */
export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  className = '',
}: {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={`filter-group flex-nowrap overflow-x-auto no-scrollbar ${className}`.trim()} role="tablist">
      {options.map((opt) => {
        const isActive = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(opt.id)}
            className={`filter-btn shrink-0 ${isActive ? 'filter-btn-active' : ''}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
