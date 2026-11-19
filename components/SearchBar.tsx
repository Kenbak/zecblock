'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { detectAddressType } from '@/lib/zcash';
import { findAddressByLabel, searchAddressesByLabel, fetchOfficialLabels } from '@/lib/address-labels';
import { isValidName } from '@/lib/zns';
import { NETWORK, isMainnet, isCrosslink } from '@/lib/config';
import type { SiteMatch } from '@/lib/site-search';
import { HISTORICAL_UPGRADES } from '@/lib/upgrade-history-data';
import { getApiUrl } from '@/lib/api-config';

// The first block of the Ironwood upgrade, from the deployment ZIP heights.
const IRONWOOD_ACTIVATION = HISTORICAL_UPGRADES.find((upgrade) => upgrade.id === 'nu63')!.heights;
const EXAMPLE_BLOCK = isCrosslink
  ? { height: 6, title: undefined }
  : { height: isMainnet ? IRONWOOD_ACTIVATION.mainnet : IRONWOOD_ACTIVATION.testnet, title: 'Ironwood activation block' };

// A page every visitor of this network can open by typing its name.
const EXAMPLE_PAGE = isCrosslink ? 'validators' : 'shielded pools';

// Shortened ids as the explorer displays them: a bare prefix, or
// "5b34c8b44d...ec9e77". The API applies the authoritative limits.
const SHORT_ID_PATTERN = /^(?:[a-fA-F0-9]{8,63}|[a-fA-F0-9]{6,}\s*(?:\.{2,3}|…)\s*[a-fA-F0-9]{4,})$/;

interface IdMatch {
  kind: 'Transaction' | 'Block';
  id: string;
  href: string;
  detail: string;
}

type IdSearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'results'; matches: IdMatch[]; truncated: boolean }
  | { status: 'message'; message: string };

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
  // Pages, page sections and charts that match the words typed.
  const [siteResults, setSiteResults] = useState<SiteMatch[]>([]);
  const siteSearch = useRef<typeof import('@/lib/site-search') | null>(null);
  const [siteSearchReady, setSiteSearchReady] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [labelsLoaded, setLabelsLoaded] = useState(false);
  const [idSearch, setIdSearch] = useState<IdSearchState>({ status: 'idle' });
  const idSearchRequest = useRef(0);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
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

  // A new query invalidates any shortened-id lookup in flight.
  useEffect(() => {
    idSearchRequest.current += 1;
    setIdSearch({ status: 'idle' });
  }, [query]);

  const resolveShortId = async (value: string) => {
    const request = ++idSearchRequest.current;
    setIdSearch({ status: 'loading' });
    try {
      const response = await fetch(`${getApiUrl()}/v1/search/prefix?q=${encodeURIComponent(value)}`);
      if (request !== idSearchRequest.current) return;
      if (response.status === 400) {
        setIdSearch({ status: 'message', message: 'Enter at least 8 characters of a transaction id or block hash.' });
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { data } = await response.json() as {
        data: {
          transactions: Array<{ txid: string; blockHeight: number }>;
          blocks: Array<{ hash: string; height: number }>;
          truncated: boolean;
        };
      };
      if (request !== idSearchRequest.current) return;
      const matches: IdMatch[] = [
        ...data.transactions.map((tx) => ({
          kind: 'Transaction' as const,
          id: tx.txid,
          href: `/tx/${tx.txid}`,
          detail: `Block #${tx.blockHeight.toLocaleString('en-US')}`,
        })),
        ...data.blocks.map((block) => ({
          kind: 'Block' as const,
          id: block.hash,
          href: `/block/${block.height}`,
          detail: `Height ${block.height.toLocaleString('en-US')}`,
        })),
      ];
      if (matches.length === 1 && !data.truncated) {
        setQuery('');
        navigate(matches[0].href);
      } else if (matches.length === 0) {
        setIdSearch({ status: 'message', message: 'No indexed transaction or block starts with these characters. Pending mempool transactions need the full id.' });
      } else {
        setIdSearch({ status: 'results', matches, truncated: data.truncated });
      }
    } catch {
      if (request !== idSearchRequest.current) return;
      setIdSearch({ status: 'message', message: 'Search is temporarily unavailable. Try the full 64-character id.' });
    }
  };

  // The page index (menus, sections, charts) loads on first use, so it stays out of the first page load.
  const loadSiteSearch = () => siteSearch.current
    ? Promise.resolve(siteSearch.current)
    : import('@/lib/site-search').then((module) => {
      siteSearch.current = module;
      setSiteSearchReady(true);
      return module;
    }).catch(() => null);

  // Suggest pages and labelled addresses as the visitor types words.
  useEffect(() => {
    const value = query.trim();
    if (value.length > 0 && !siteSearch.current) void loadSiteSearch();
    const isId = detectAddressType(value) !== 'invalid'
      || !isNaN(Number(value))
      // Eight hex characters can start a hash; a shorter run can be a word ("fee").
      || /^[a-fA-F0-9]{8,}$/.test(value);
    if (value.length < 2 || isId) {
      setSiteResults([]);
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    const pages = siteSearch.current?.searchSite(value, NETWORK, 5) ?? [];
    const labels = /^[a-fA-F0-9]+$/.test(value) ? [] : searchAddressesByLabel(value).slice(0, pages.length > 0 ? 3 : 5);
    setSiteResults(pages);
    setSuggestions(labels);
    setShowSuggestions(pages.length + labels.length > 0);
    setSelectedIndex(-1);
    // The ready flag re-runs this once the index has loaded.
  }, [query, labelsLoaded, siteSearchReady]);

  // A page takes Enter ahead of the name lookup, so the name stays reachable as its own row.
  const nameOption = siteResults[0]?.strong && isValidName(query.trim().toLowerCase()) ? query.trim().toLowerCase() : null;
  const optionCount = siteResults.length + suggestions.length + (nameOption ? 1 : 0);

  const openSite = (result: SiteMatch) => {
    setShowSuggestions(false);
    setQuery('');
    if (result.external) {
      onNavigate?.();
      window.open(result.href, '_blank', 'noopener,noreferrer');
    } else {
      navigate(result.href);
    }
  };

  const selectSuggestion = (suggestion: LabelSuggestion) => {
    setShowSuggestions(false);
    setQuery('');
    navigate(`/address/${encodeURIComponent(suggestion.address)}`);
  };

  const openName = (name: string) => {
    setShowSuggestions(false);
    setQuery('');
    navigate(`/name/${encodeURIComponent(name)}`);
  };

  // One list for the keyboard: pages first, then labelled addresses, then the name row.
  const selectOption = (index: number) => {
    if (index < siteResults.length) openSite(siteResults[index]);
    else if (index < siteResults.length + suggestions.length) selectSuggestion(suggestions[index - siteResults.length]);
    else if (nameOption) openName(nameOption);
  };

  // Handle keyboard navigation in suggestions
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && idSearch.status !== 'idle') {
      setIdSearch({ status: 'idle' });
      return;
    }
    if (!showSuggestions || optionCount === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev < optionCount - 1 ? prev + 1 : prev));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : -1));
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      selectOption(selectedIndex);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  // Words, not an id: a label typed in full, then a page, then the looser lookups.
  const resolveWords = async (value: string) => {
    const lower = value.toLowerCase();
    const exactLabel = searchAddressesByLabel(value).find(candidate => candidate.label.toLowerCase() === lower);
    if (exactLabel) return navigate(`/address/${encodeURIComponent(exactLabel.address)}`);
    const site = await loadSiteSearch();
    // A page named by the query comes before the loose label match and the Zcash Name fallback.
    const page = site?.bestSiteMatch(value, NETWORK);
    if (page) return openSite(page);
    const addressByLabel = findAddressByLabel(value);
    if (addressByLabel) return navigate(`/address/${encodeURIComponent(addressByLabel)}`);
    if (isValidName(lower)) return navigate(`/name/${encodeURIComponent(lower)}`);
    const loose = site?.searchSite(value, NETWORK, 1)[0];
    if (loose) return openSite(loose);
    setIdSearch({ status: 'message', message: 'No matching page, address, transaction, block, label or name.' });
  };

  // A short run of hex letters is too short for an id, but it can be a word a page is named for.
  const resolveShortHex = async (value: string) => {
    const page = (await loadSiteSearch())?.bestSiteMatch(value, NETWORK);
    if (page) return openSite(page);
    setIdSearch({ status: 'message', message: 'Enter at least 8 characters of a transaction id or block hash.' });
  };

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
      if (formRef.current && !formRef.current.contains(e.target as Node)) {
        setIdSearch({ status: 'idle' });
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
    } else if (SHORT_ID_PATTERN.test(trimmedQuery)) {
      void resolveShortId(trimmedQuery);
    } else if (/^[a-fA-F0-9]+$/.test(trimmedQuery)) {
      void resolveShortHex(trimmedQuery);
    } else {
      void resolveWords(trimmedQuery);
    }
  };

  // Suggestions dropdown component
  const SuggestionsDropdown = () => {
    if (!showSuggestions || optionCount === 0) return null;
    const groupLabel = 'px-4 pt-3 pb-1 text-caption text-muted font-mono uppercase tracking-wider';
    const rowClass = (index: number) => `w-full px-4 py-3 text-left flex items-center gap-3 transition duration-150 ${
      index === selectedIndex ? 'suggestion-item-active' : 'suggestion-item'
    }`;

    const getSiteIcon = (kind: SiteMatch['kind']) => (
      <svg className="w-4 h-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        {kind === 'Chart'
          ? <path d="M4 19V5m0 14h16M8 15l3-4 3 2 4-6" />
          : kind === 'Section'
            ? <path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16" />
            : <path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" />}
      </svg>
    );

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
        className="absolute top-full left-0 right-0 mt-2 suggestions-dropdown rounded-xl z-[200] max-h-[60vh] overflow-y-auto"
      >
        {siteResults.length > 0 && <p className={groupLabel}>Pages</p>}
        {siteResults.map((result, index) => (
          <button
            key={`${result.kind}-${result.href}`}
            type="button"
            onClick={() => openSite(result)}
            className={rowClass(index)}
          >
            <span className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center bg-glass-4 text-muted">
              {getSiteIcon(result.kind)}
            </span>
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2">
                <span className="font-medium text-sm truncate suggestion-label">{result.label}</span>
                {/* A page shows the menu it sits in; a section or chart says what it is. */}
                <span className="shrink-0 text-caption px-1.5 py-0.5 rounded font-mono uppercase bg-glass-4 text-muted">
                  {result.kind === 'Page' ? result.context : result.kind}
                </span>
              </span>
              <span className="block text-xs text-muted truncate mt-0.5">
                {result.kind === 'Section' ? `${result.desc} · on ${result.context}` : result.desc}
              </span>
            </span>
            <span aria-hidden="true" className="text-muted">{result.external ? '↗' : '→'}</span>
          </button>
        ))}
        {siteResults.length > 0 && suggestions.length > 0 && <p className={groupLabel}>Labelled addresses</p>}
        {suggestions.map((suggestion, labelIndex) => {
          const index = siteResults.length + labelIndex;
          const category = suggestion.category || 'Custom';
          const style = getCategoryStyle(category);

          return (
            <button
              key={suggestion.address}
              type="button"
              onClick={() => selectSuggestion(suggestion)}
              className={rowClass(index)}
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
        {nameOption && (
          <>
            <p className={groupLabel}>Zcash Name</p>
            <button type="button" onClick={() => openName(nameOption)} className={rowClass(siteResults.length + suggestions.length)}>
              <span className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center bg-glass-4 text-muted font-mono text-sm" aria-hidden="true">@</span>
              <span className="flex-1 min-w-0">
                <span className="block font-medium text-sm truncate suggestion-label">{nameOption}</span>
                <span className="block text-xs text-muted mt-0.5">Look up this Zcash Name</span>
              </span>
              <span aria-hidden="true" className="text-muted">→</span>
            </button>
          </>
        )}
      </div>
    );
  };

  const IdSearchDropdown = () => {
    if (idSearch.status === 'idle' || showSuggestions) return null;
    return (
      <div
        role="status"
        aria-live="polite"
        className="absolute top-full left-0 right-0 mt-2 suggestions-dropdown rounded-xl z-[200] overflow-hidden"
      >
        {idSearch.status === 'loading' && (
          <p className="px-4 py-3 text-xs text-muted font-mono">Searching…</p>
        )}
        {idSearch.status === 'message' && (
          <p className="px-4 py-3 text-xs text-secondary">{idSearch.message}</p>
        )}
        {idSearch.status === 'results' && (
          <>
            <p className="px-4 pt-3 pb-1 text-caption text-muted font-mono uppercase tracking-wider">
              {idSearch.truncated ? 'First matches. Add characters to narrow' : 'Matches'}
            </p>
            {idSearch.matches.map((match) => (
              <button
                key={`${match.kind}-${match.id}`}
                type="button"
                onClick={() => { setQuery(''); navigate(match.href); }}
                className="w-full px-4 py-3 text-left flex items-center gap-3 transition duration-150 suggestion-item"
              >
                <span className="text-caption px-1.5 py-0.5 rounded font-mono uppercase bg-glass-4 text-muted">
                  {match.kind}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-mono truncate suggestion-label">{match.id}</span>
                  <span className="block text-xs text-muted mt-0.5">{match.detail}</span>
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    );
  };

  // Compact version for navbar
  if (compact) {
    return (
      <form ref={formRef} onSubmit={handleSearch} className="w-full">
        <div className="relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-cipher-gold font-mono text-xs">
            {'>'}
          </div>
          <input
            aria-label="Search by page, address, transaction, block, or name"
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => { void loadSiteSearch(); if (query.length >= 2 && optionCount > 0) setShowSuggestions(true); }}
            placeholder="Page, address, transaction or block"
            className="w-full pl-7 pr-3 py-2 text-xs font-mono search-input"
          />
          <SuggestionsDropdown />
          <IdSearchDropdown />
        </div>
      </form>
    );
  }

  // Full version for homepage - Enhanced
  return (
    <form ref={formRef} onSubmit={handleSearch} className="max-w-3xl mr-auto relative z-50">
      {/* Search Container with Glow Effect */}
      <div className="relative group">
        {/* Search Input Container */}
        <div className="relative">
          {/* Terminal prompt */}
          <div className="absolute left-4 sm:left-5 top-1/2 -translate-y-1/2 text-cipher-gold font-mono text-lg sm:text-xl font-semibold">
            {'>'}
          </div>

          <input
            aria-label="Search by page, address, transaction, block, or name"
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              setIsFocused(true);
              void loadSiteSearch();
              if (query.length >= 2 && optionCount > 0) setShowSuggestions(true);
            }}
            onBlur={() => setIsFocused(false)}
            placeholder="Search a page, address, tx hash or block..."
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
          <IdSearchDropdown />
        </div>
      </div>

      {/* Example Buttons */}
      <div className="search-examples mt-2 sm:mt-2.5 flex flex-wrap gap-1.5 sm:gap-2 items-center">
        <span className="text-caption text-muted font-mono uppercase tracking-wider">Try:</span>
        <button
          type="button"
          onClick={() => setQuery(String(EXAMPLE_BLOCK.height))}
          title={EXAMPLE_BLOCK.title}
          className="example-tag example-tag-default"
        >
          Block #{EXAMPLE_BLOCK.height}
        </button>
        {/* Shows that words find pages, not only ids. */}
        <button
          type="button"
          onClick={() => { setQuery(EXAMPLE_PAGE); inputRef.current?.focus(); }}
          className="example-tag example-tag-default"
        >
          {EXAMPLE_PAGE}
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
