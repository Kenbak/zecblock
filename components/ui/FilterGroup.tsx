'use client';

import { ReactNode } from 'react';

interface FilterGroupProps {
  children: ReactNode;
  className?: string;
  inline?: boolean;
}

export function FilterGroup({ children, className = '', inline = false }: FilterGroupProps) {
  return (
    <div className={`filter-group ${inline ? 'inline-flex' : 'flex'} ${className}`.trim()}>
      {children}
    </div>
  );
}

interface FilterButtonProps {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  variant?: 'default' | 'warning' | 'danger';
  type?: 'button' | 'submit';
  disabled?: boolean;
  title?: string;
}

export function FilterButton({
  active = false,
  onClick,
  children,
  className = '',
  variant = 'default',
  type = 'button',
  disabled,
  title,
}: FilterButtonProps) {
  const variantClass =
    variant === 'warning' ? 'filter-btn-warning' : variant === 'danger' ? 'filter-btn-danger' : active ? 'filter-btn-active' : '';

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`filter-btn ${variantClass} ${className}`.trim()}
      aria-pressed={variant === 'default' ? active : undefined}
    >
      {children}
    </button>
  );
}
