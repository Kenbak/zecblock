'use client';

import { useState, useEffect } from 'react';
import { fetchOfficialLabels, getAddressLabel, setCustomLabel, removeCustomLabel, type AddressLabelInfo } from '@/lib/address-labels';
import { EntityLogo } from '@/components/EntityLogo';
import { PoolLogo } from '@/components/PoolLogo';

interface AddressLabelProps {
  address: string;
  showEditButton?: boolean;
  className?: string;
}

export function AddressLabel({ address, showEditButton = true, className = '' }: AddressLabelProps) {
  const [labelInfo, setLabelInfo] = useState<AddressLabelInfo | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  // Load label on mount and when address changes
  useEffect(() => {
    let cancelled = false;
    const info = getAddressLabel(address);
    setLabelInfo(info);
    setEditValue(info?.label || '');
    fetchOfficialLabels().then(() => {
      if (!cancelled) setLabelInfo(getAddressLabel(address));
    });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const handleSave = () => {
    setCustomLabel(address, editValue);
    setLabelInfo(getAddressLabel(address));
    setIsEditing(false);
  };

  const handleRemove = () => {
    removeCustomLabel(address);
    setLabelInfo(getAddressLabel(address));
    setEditValue('');
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') {
      setEditValue(labelInfo?.label || '');
      setIsEditing(false);
    }
  };

  // Editing mode
  if (isEditing) {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <input
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a label..."
          className="px-2 py-1 text-xs font-mono bg-cipher-surface border border-cipher-border rounded focus:border-cipher-gold focus:outline-none"
          autoFocus
        />
        <button
          onClick={handleSave}
          className="text-cipher-green hover:text-cipher-green transition-colors"
          title="Save"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </button>
        <button
          onClick={() => {
            setEditValue(labelInfo?.label || '');
            setIsEditing(false);
          }}
          className="text-muted hover:text-secondary transition-colors"
          title="Cancel"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  }

  // Display mode with label
  if (labelInfo) {
    const bgColor = labelInfo.isOfficial
      ? labelInfo.category === 'foundation'
        ? 'bg-cipher-purple/20 border-cipher-purple/50 text-cipher-purple-glow'
        : labelInfo.category === 'exchange'
        ? 'bg-brand-gold/20 border-cipher-gold/50 text-cipher-gold'
        : labelInfo.category === 'mining'
        ? 'bg-cipher-orange/20 border-cipher-orange/50 text-cipher-orange'
        : 'bg-brand-gold/20 border-cipher-gold/50 text-cipher-gold'
      : 'bg-glass-6 border-cipher-border text-secondary';

    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono rounded border ${bgColor}`}
          title={labelInfo.description}
        >
          {labelInfo.isOfficial && (
            labelInfo.category === 'mining'
              ? <PoolLogo name={labelInfo.label} />
              : <EntityLogo label={labelInfo.label} category={labelInfo.category} />
          )}
          {labelInfo.isOfficial && (
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
          )}
          {labelInfo.label}
        </span>
        {showEditButton && !labelInfo.isOfficial && (
          <button
            onClick={handleRemove}
            className="text-muted hover:text-danger transition-colors"
            title="Remove label"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  // No label - show add button
  if (showEditButton) {
    return (
      <button
        onClick={() => setIsEditing(true)}
        className={`text-muted hover:text-primary transition-colors text-xs font-mono flex items-center gap-1 ${className}`}
        title="Add a label for this address"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
        </svg>
        <span>Add label</span>
      </button>
    );
  }

  return null;
}
