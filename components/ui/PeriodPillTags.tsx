'use client';

interface PeriodPillOption<T extends string> {
  key: T;
  label: string;
  /** Optional tooltip, e.g. why an option is unavailable. */
  title?: string;
  disabled?: boolean;
}

interface PeriodPillTagsProps<T extends string> {
  options: readonly PeriodPillOption<T>[];
  value: T;
  onChange: (key: T) => void;
  className?: string;
  'aria-label'?: string;
}

/**
 * The standard single-choice segmented control (periods, metrics, units).
 * Styling lives in `.filter-group` / `.filter-btn` (globals.css) so every
 * toggle in the app — this, SegmentedToggle and FilterGroup — looks the same.
 */
export function PeriodPillTags<T extends string>({
  options,
  value,
  onChange,
  className = '',
  'aria-label': ariaLabel = 'Time period',
}: PeriodPillTagsProps<T>) {
  return (
    <div role="group" aria-label={ariaLabel} className={`filter-group ${className}`.trim()}>
      {options.map(({ key, label, title, disabled }) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            aria-pressed={active}
            title={title}
            disabled={disabled}
            className={`filter-btn ${active ? 'filter-btn-active' : ''}`.trim()}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
