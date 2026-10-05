'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { detectAddressType } from '@/lib/zcash';
import { findAddressByLabel, searchAddressesByLabel, fetchOfficialLabels } from '@/lib/address-labels';
import { isValidName } from '@/lib/zns';
import { isMainnet, isCrosslink } from '@/lib/config';

interface SearchBarProps {
  compact?: boolean;
  subtitle?: string;
  onNavigate?: () => void;
}

interface LabelSuggestion {
  address: string;
  label: string;
  isOfficial: boolean;
  category?: string;
}

// Category styling config (lowercase keys for case-insensitive matching)
const categoryConfig: Record<string, { color: string; bg: string }> = {
  'exchange': { color: 'text-cipher-gold', bg: 'bg-brand-gold/10' },
  'mining pool': { color: 'text-cipher-yellow', bg: 'bg-cipher-yellow/10' },
  'mining': { color: 'text-cipher-yellow', bg: 'bg-cipher-yellow/10' },
  'foundation': { color: 'text-cipher-purple', bg: 'bg-cipher-purple/10' },
  'donation': { color: 'text-pink-400', bg: 'bg-pink-400/10' },
  'service': { color: 'text-cipher-green', bg: 'bg-cipher-green/10' },
  'faucet': { color: 'text-cipher-blue', bg: 'bg-cipher-blue/10' },
  'custom': { color: 'text-muted', bg: 'bg-glass-4' },
};

export function SearchBar({ compact = false, subtitle, onNavigate }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<LabelSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [labelsLoaded, setLabelsLoaded] = useState(false);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const navigate = (href: string) => { onNavigate?.(); router.push(href); };

  // Only the visible field handles the shortcut; navbar fields remain mounted
  // across routes and breakpoints to keep hydration stable.
  useEffect(() => {
    function handleGlobalKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (!inputRef.current?.getClientRects().length) return;
        const active = document.activeElement;
        const isTyping =
          active instanceof HTMLElement &&
          (active.tagName === 'TEXTAREA' ||
            active.isContentEditable ||
            (active.tagName === 'INPUT' && active !== inputRef.current));
        if (isTyping) return;
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  // Fetch official labels on mount
  useEffect(() => {
    fetchOfficialLabels().then(() => {
      setLabelsLoaded(true);
    });
  }, []);

  // Search for label suggestions as user types
  useEffect(() => {
    if (query.length >= 2) {
      const addressType = detectAddressType(query);
      const isNumber = !isNaN(Number(query));
      const isHex = /^[a-fA-F0-9]+$/.test(query);

      if (addressType === 'invalid' && !isNumber && !isHex) {
        const results = searchAddressesByLabel(query);
        setSuggestions(results.slice(0, 5));
        setShowSuggestions(results.length > 0);
        setSelectedIndex(-1);
      } else {
        setSuggestions([]);
        setShowSuggestions(false);
      }
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  }, [query, labelsLoaded]);

  // Handle keyboard navigation in suggestions
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev < suggestions.length - 1 ? prev + 1 : prev));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : -1));
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      selectSuggestion(suggestions[selectedIndex]);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  const selectSuggestion = (suggestion: LabelSuggestion) => {
    setShowSuggestions(false);
    setQuery('');
    navigate(`/address/${encodeURIComponent(suggestion.address)}`);
  };

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // PoW block hashes must have leading zeros (difficulty target).
  // 4+ leading zeros safely covers every Zcash block ever mined.
  // Tested BEFORE the generic 64-char hex check (same pattern as mempool.space).
  const BLOCK_HASH_REGEX = /^0{4}[a-fA-F0-9]{60}$/;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();

    if (!query.trim()) return;

    const trimmedQuery = query.trim()
      .replace(/[<>\"']/g, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+=/gi, '');

    if (trimmedQuery.length > 500) {
      console.warn('Query too long, truncating');
      return;
    }

    const addressType = detectAddressType(trimmedQuery);

    if (addressType !== 'invalid') {
      navigate(`/address/${encodeURIComponent(trimmedQuery)}`);
    } else if (!isNaN(Number(trimmedQuery))) {
      navigate(`/block/${encodeURIComponent(trimmedQuery)}`);
    } else if (BLOCK_HASH_REGEX.test(trimmedQuery)) {
      navigate(`/block/${encodeURIComponent(trimmedQuery)}`);
    } else if (/^[a-fA-F0-9]{64}$/.test(trimmedQuery)) {
      navigate(`/tx/${encodeURIComponent(trimmedQuery)}`);
    } else if (/^[a-fA-F0-9]+$/.test(trimmedQuery)) {
      navigate(`/tx/${encodeURIComponent(trimmedQuery)}`);
    } else {
      const addressByLabel = findAddressByLabel(trimmedQuery);
      if (addressByLabel) {
        navigate(`/address/${encodeURIComponent(addressByLabel)}`);
      } else if (isValidName(trimmedQuery.toLowerCase())) {
        navigate(`/name/${encodeURIComponent(trimmedQuery.toLowerCase())}`);
      } else {
        console.warn('No matching address, transaction, or label found');
      }
    }
  };

  // Suggestions dropdown component
  const SuggestionsDropdown = () => {
    if (!showSuggestions || suggestions.length === 0) return null;

    const getCategoryIcon = (category: string) => {
      const normalizedCategory = category.toLowerCase();
      switch (normalizedCategory) {
        case 'exchange':
          return (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
          );
        case 'mining pool':
        case 'mining':
          return (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
            </svg>
          );
        case 'foundation':
          return (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          );
        case 'donation':
          return (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          );
        case 'service':
          return (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
          );
        case 'faucet':
          return (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          );
        default: // Custom or unknown
          return (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          );
      }
    };

    const getCategoryStyle = (category: string) => {
      return categoryConfig[category.toLowerCase()] || categoryConfig['custom'];
    };

    return (
      <div
        ref={suggestionsRef}
        className="absolute top-full left-0 right-0 mt-2 suggestions-dropdown rounded-xl z-[200] overflow-hidden"
      >
        {suggestions.map((suggestion, index) => {
          const category = suggestion.category || 'Custom';
          const style = getCategoryStyle(category);

          return (
            <button
              key={suggestion.address}
              type="button"
              onClick={() => selectSuggestion(suggestion)}
              className={`w-full px-4 py-3 text-left flex items-center gap-3 transition duration-150 ${
                index === selectedIndex ? 'suggestion-item-active' : 'suggestion-item'
              }`}
            >
              {/* Icon */}
              <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${style.bg}`}>
                <span className={style.color}>
                  {getCategoryIcon(category)}
                </span>
              </span>

              {/* Label & Address */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate suggestion-label">{suggestion.label}</span>
                  <span className={`text-caption px-1.5 py-0.5 rounded font-mono uppercase ${style.bg} ${style.color}`}>
                    {category}
                  </span>
                </div>
                <div className="text-xs text-muted font-mono truncate mt-0.5">
                  {suggestion.address.slice(0, 16)}...{suggestion.address.slice(-8)}
                </div>
              </div>

              {/* Arrow */}
              <svg className="w-4 h-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          );
        })}
      </div>
    );
  };

  // Compact version for navbar
  if (compact) {
    return (
      <form onSubmit={handleSearch} className="w-full">
        <div className="relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-cipher-gold font-mono text-xs">
            {'>'}
          </div>
          <input
            aria-label="Search by address, transaction, block, or name"
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => query.length >= 2 && suggestions.length > 0 && setShowSuggestions(true)}
            placeholder="Address, transaction, block or name"
            className="w-full pl-7 pr-3 py-2 text-xs font-mono search-input"
          />
          <SuggestionsDropdown />
        </div>
      </form>
    );
  }

  // Full version for homepage - Enhanced
  return (
    <form onSubmit={handleSearch} className="max-w-3xl mr-auto relative z-50">
      {/* Search Container with Glow Effect */}
      <div className="relative group">
        {/* Search Input Container */}
        <div className="relative">
          {/* Terminal prompt */}
          <div className="absolute left-4 sm:left-5 top-1/2 -translate-y-1/2 text-cipher-gold font-mono text-lg sm:text-xl font-semibold">
            {'>'}
          </div>

          <input
            aria-label="Search by address, transaction, block, or name"
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              setIsFocused(true);
              if (query.length >= 2 && suggestions.length > 0) setShowSuggestions(true);
            }}
            onBlur={() => setIsFocused(false)}
            placeholder="Search address, tx hash, block, or name..."
            className={`w-full pl-10 sm:pl-12 pr-14 lg:pr-24 py-3 sm:py-3.5 text-data sm:text-sm font-mono
              search-input-hero border rounded-md text-primary
              placeholder:text-muted transition duration-300
              ${isFocused
                ? 'border-cipher-gold'
                : 'border-cipher-border hover:border-cipher-gold/50'
              }
              focus:outline-none`}
          />

          {/* Keyboard shortcut hint — real now: a global listener above
              focuses this input on ⌘K/Ctrl+K from anywhere on the page. */}
          <div className={`hidden lg:flex absolute right-14 top-1/2 -translate-y-1/2 items-center gap-1 text-muted transition-opacity ${query ? 'opacity-0 pointer-events-none' : ''}`}>
            <kbd className="kbd-hint">⌘</kbd>
            <kbd className="kbd-hint">K</kbd>
          </div>

          {/* Icon-only submit — Enter already submits for keyboard users;
              this is just a touch/click target, not a second "you must
              click this" affordance competing with the input itself. */}
          <button
            type="submit"
            aria-label="Search"
            className="absolute right-2 top-1/2 -translate-y-1/2
              inline-flex items-center justify-center
              w-9 h-9 sm:w-10 sm:h-10 rounded-lg
              text-primary border border-cipher-border
              hover:border-cipher-gold/50 hover:bg-cipher-hover
              transition duration-150"
          >
            <svg className="w-4 h-4 sm:w-[18px] sm:h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
            </svg>
          </button>

          <SuggestionsDropdown />
        </div>
      </div>

      {/* Example Buttons */}
      <div className="search-examples mt-2 sm:mt-2.5 flex flex-wrap gap-1.5 sm:gap-2 items-center">
        <span className="text-caption text-muted font-mono uppercase tracking-wider">Try:</span>
        <button
          type="button"
          onClick={() => setQuery(isCrosslink ? '6' : '354939')}
          className="example-tag example-tag-default"
        >
          Block #{isCrosslink ? 6 : 354939}
        </button>
        <button
          type="button"
          onClick={() => setQuery(isMainnet ? 't1a7l33nnr9qnhekptmjacyj95a565tcns09' : 'tmYWZuRKmdZwgKAxtV9RZRAuPsnWrLkyUtT')}
          className="example-tag example-tag-default"
        >
          t-address
        </button>
        <button
          type="button"
          onClick={() => setQuery(isMainnet
            ? 'u1a7l33nnr9qnhekptmjacyj95a565tcns09xvyxmt777xnk2q6c6s0jrthgme6dkeevc24zue9yqlmspdla5fw5mjws9'
            : 'utest1qz2c9w98v9xavajc8ml5zd459902alt62tndt3sktsx0hd3gd20evhwfrqq834335a7lmw4a4mx79pnhczxvs50w5'
          )}
          className="example-tag example-tag-default"
        >
          u-address
        </button>
      </div>

    </form>
  );
}
