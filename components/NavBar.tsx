'use client';

import Link from 'next/link';
import { BrandLogo } from '@/components/BrandLogo';
import { useState, useEffect, useRef, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { containDialogFocus } from '@/lib/dialog-focus';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { SearchBar } from '@/components/SearchBar';
import { DonateButton } from '@/components/DonateButton';
import { ThemeToggle } from '@/components/ThemeToggle';
import { NETWORK, NETWORK_LABEL, isMainnet, isCrosslink, MAINNET_URL, TESTNET_URL, CROSSLINK_URL } from '@/lib/config';

import { getNavigation, getActiveNavigationHref, getHeaderActiveHref, getNestedNavigation, groupNavigationItems, PRIVATE_EXPLORER_URL } from '@/lib/navigation';

// Icon-only header controls share one box so they line up with the theme and support buttons.
const UTILITY_ICON = 'inline-flex items-center justify-center p-1.5 rounded-lg text-muted hover:text-primary transition-colors duration-150';

/** The Private Explorer is its own site. The hat and glasses read as a hidden person. Mainnet only. */
function PrivateExplorerLink({ onNavigate }: { onNavigate?: () => void }) {
  if (!isMainnet) return null;
  return (
    <a href={PRIVATE_EXPLORER_URL} target="_blank" rel="noopener noreferrer" onClick={onNavigate}
      aria-label="Private Explorer (opens in a new tab)" title="Private Explorer ↗" className={UTILITY_ICON}>
      <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 11h18" />
        <path d="M5 11V7a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v4" />
        <circle cx="7" cy="17" r="3" />
        <circle cx="17" cy="17" r="3" />
        <path d="M10 17h4" />
      </svg>
    </a>
  );
}

/** Shortcut to the tools hub, which the Resources menu also lists. */
function ToolsLink({ current, onNavigate }: { current: boolean; onNavigate?: () => void }) {
  return (
    <Link href="/tools" onClick={onNavigate} aria-label="Tools" title="Tools" aria-current={current ? 'page' : undefined}
      className={`${UTILITY_ICON} ${current ? '!text-primary bg-cipher-hover' : ''}`}>
      <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.75 6.75a4.5 4.5 0 0 1-4.884 4.484c-1.076-.091-2.264.071-2.95.904l-7.152 8.684a2.548 2.548 0 1 1-3.586-3.586l8.684-7.152c.833-.686.995-1.874.904-2.95a4.5 4.5 0 0 1 6.336-4.486l-3.276 3.276a3.004 3.004 0 0 0 2.25 2.25l3.276-3.276c.256.565.398 1.192.398 1.852Z" />
        <path d="M4.867 19.125h.008v.008h-.008v-.008Z" />
      </svg>
    </Link>
  );
}

// Grouped once: a menu with several groups renders one labelled column per group.
const categories = getNavigation(NETWORK).map(category => ({ ...category, groups: groupNavigationItems(category.items) }));
// Specialist pages stay one click away as small links under the destination they belong to.
const nestedLinks = getNestedNavigation(NETWORK);
const sitemap = getNavigation(NETWORK, 'footer');

export function NavBar() {
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileAccordion, setMobileAccordion] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const drawerRef = useRef<HTMLDialogElement>(null);
  const searchDialogRef = useRef<HTMLDialogElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  // A page that left the masthead (footer-only) keeps its parent destination lit.
  const activeHref = getHeaderActiveHref(pathname, NETWORK);
  // The exact page, so a nested link (not its parent) is the one announced as current.
  const exactHref = getActiveNavigationHref(pathname, sitemap);

  const closeAll = useCallback(() => {
    setOpenDropdown(null);
    setMobileMenuOpen(false);
    setSearchOpen(false);
    setMobileAccordion(null);
  }, []);

  useEffect(() => {
    function handleOutside(event: PointerEvent) {
      if (!navRef.current?.contains(event.target as Node)) setOpenDropdown(null);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && openDropdown) {
        document.getElementById(`nav-trigger-${openDropdown}`)?.focus();
        setOpenDropdown(null);
      }
    }
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [openDropdown]);

  useBodyScrollLock(mobileMenuOpen || searchOpen);

  useEffect(() => {
    const dialog = searchDialogRef.current;
    if (!searchOpen || !dialog) return;
    dialog.showModal();
    dialog.querySelector('input')?.focus();
    return () => dialog.close();
  }, [searchOpen]);

  useEffect(() => {
    const openWithKeyboard = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      // The homepage hero and mobile field handle their own shortcut.
      if (!searchTriggerRef.current?.getClientRects().length) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.matches('input, textarea') || active.isContentEditable)) return;
      event.preventDefault();
      setOpenDropdown(null);
      setSearchOpen(true);
    };
    document.addEventListener('keydown', openWithKeyboard);
    return () => document.removeEventListener('keydown', openWithKeyboard);
  }, []);

  useEffect(() => {
    const drawer = drawerRef.current;
    if (!mobileMenuOpen || !drawer) return;
    drawer.showModal();
    return () => {
      drawer.close();
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1280px)');
    const handleResize = () => closeAll();
    desktop.addEventListener('change', handleResize);
    return () => desktop.removeEventListener('change', handleResize);
  }, [closeAll]);

  useEffect(() => {
    closeAll();
  }, [pathname, closeAll]);

  // Expose measured nav height for sticky stats/banner offsets (mobile search changes height).
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    const syncNavHeight = () => {
      document.documentElement.style.setProperty('--app-nav-height', `${nav.offsetHeight}px`);
    };

    syncNavHeight();
    const observer = new ResizeObserver(syncNavHeight);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [pathname]);

  const toggleDropdown = (id: string) => {
    setOpenDropdown(prev => prev === id ? null : id);
  };


  return (
    <>
      {/* No bottom border: the nav is the first element of one continuous
          chrome band (see "ONE CHROME BAND" in globals.css). */}
      <nav aria-label="Main navigation" className="navbar-container backdrop-blur-xl sticky top-0 z-50" ref={navRef}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16 gap-3">
            {/* Logo */}
            <Link href="/" className="shrink-0 py-2" aria-label="ZecBlock home">
              {/* Above the fold — keep it out of the LCP critical path. */}
              <BrandLogo priority />
            </Link>

            {/* Desktop: Horizontal category dropdowns */}
            {/* Anchored beside the logo rather than centered, so the whole
                chrome band shares the page's left edge. */}
            <div className="hidden xl:flex items-center gap-1 flex-1 justify-start xl:ml-6">
              {categories.map(cat => (
                <div key={cat.id} className="relative" onBlur={event => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpenDropdown(null);
                }}>
                  <button
                    type="button"
                    id={`nav-trigger-${cat.id}`}
                    aria-expanded={openDropdown === cat.id}
                    aria-controls={`nav-panel-${cat.id}`}
                    onKeyDown={event => {
                      if (event.key !== 'ArrowDown') return;
                      event.preventDefault();
                      setOpenDropdown(cat.id);
                      requestAnimationFrame(() => document.querySelector<HTMLElement>(`#nav-panel-${cat.id} a`)?.focus());
                    }}
                    onClick={() => toggleDropdown(cat.id)}
                    className={`flex items-center gap-1 text-sm font-medium font-mono px-2.5 py-1.5 rounded-md transition-colors duration-150 ${
                      openDropdown === cat.id || cat.items.some(item => item.href === activeHref) ? 'text-primary bg-cipher-hover' : 'text-muted hover:text-primary'
                    }`}
                  >
                    <span>{cat.label}</span>
                    <svg aria-hidden="true"
                      className={`w-3 h-3 transition-transform duration-200 ${openDropdown === cat.id ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {openDropdown === cat.id && (
                    <div
                      id={`nav-panel-${cat.id}`}
                      className="absolute left-0 mt-2 flex max-h-[calc(100dvh-5rem)] gap-1 overflow-y-auto overscroll-contain dropdown-menu rounded-lg shadow-xl border p-2 z-50 animate-scale-in origin-top-left"
                    >
                      {cat.groups.map(group => (
                        <div key={group.label ?? cat.id} role={group.label ? 'group' : undefined} aria-label={group.label}
                          className={`shrink-0 ${cat.groups.length > 1 ? 'w-56' : 'w-60'}`}>
                          {group.label && <p aria-hidden="true" className="type-label text-muted uppercase px-3 pt-1.5 pb-1">{group.label}</p>}
                          {group.items.map(item => {
                            const children = nestedLinks[item.href] ?? [];
                            const childCurrent = children.some(child => child.href === exactHref);
                            return (
                              <div key={item.href}>
                                <Link href={item.href} onClick={closeAll}
                                  aria-current={activeHref === item.href && !childCurrent ? 'page' : undefined}
                                  className={`flex flex-col min-w-0 px-3 py-2 dropdown-item rounded-md transition-colors duration-150 ${activeHref === item.href ? 'bg-cipher-hover !text-primary' : ''}`}>
                                  <span className="text-sm font-mono">{item.label}</span>
                                  <span className="text-caption text-muted leading-snug mt-0.5">{item.desc}</span>
                                </Link>
                                {children.length > 0 && (
                                  <ul className="ml-3 mt-0.5 mb-1 border-l border-cipher-border pl-1">
                                    {children.map(child => (
                                      <li key={child.href}>
                                        <Link href={child.href} onClick={closeAll} title={child.desc}
                                          aria-current={exactHref === child.href ? 'page' : undefined}
                                          className={`block px-2 py-1 text-caption font-mono dropdown-item rounded-md transition-colors duration-150 ${exactHref === child.href ? '!text-primary' : ''}`}>
                                          {child.label}
                                        </Link>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}

            </div>

            {/* Right: utilities. Zift has no link here: its launcher floats on every mainnet page
                and the Resources menu lists it. */}
            <div className="flex items-center gap-1.5 sm:gap-2">
              {/* Buy ZEC — mainnet only, desktop */}
              {isMainnet && (
                <a
                  href="https://cipherswap.app/"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Buy ZEC on CipherSwap"
                  className="hidden xl:flex h-9 items-center gap-1.5 whitespace-nowrap px-3 text-xs font-mono font-semibold text-brand-gold hover:underline underline-offset-4 transition-colors"
                >
                  Buy ZEC <span aria-hidden="true">↗</span>
                </a>
              )}

              {/* Separates the gold action from the neutral network control so
                  they stop reading as one cluster. Rendered only alongside
                  Buy ZEC, which is desktop mainnet-only. */}
              {isMainnet && <span className="hidden xl:block w-px h-4 bg-cipher-border" aria-hidden="true" />}

              {/* Desktop network control; mobile network choices live in the drawer. */}
              <div className="relative hidden xl:block" onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpenDropdown(null);
              }}>
                <button
                  type="button"
                  id="nav-trigger-network-switch"
                  aria-label={`Switch network. Current network: ${NETWORK_LABEL}`}
                  aria-expanded={openDropdown === 'network-switch'}
                  aria-controls="nav-panel-network-switch"
                  onClick={() => toggleDropdown('network-switch')}
                  className={`flex items-center gap-1.5 pl-2 pr-2.5 py-1.5 rounded-md transition-colors duration-150 ${
                    openDropdown === 'network-switch' ? 'text-primary bg-cipher-hover' : 'text-muted hover:text-primary'
                  }`}
                  title={isMainnet ? 'Mainnet' : isCrosslink ? 'Crosslink' : 'Testnet'}
                >
                  {/* Deliberately neutral, glyph and label both: "Buy ZEC" is
                      the gold action next to it, and the network name is the
                      information here — the word already says which chain. */}
                  <svg aria-hidden="true"
                    className="w-4 h-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 21a9 9 0 100-18 9 9 0 000 18z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.6 9h16.8M3.6 15h16.8" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3a15.3 15.3 0 014 9 15.3 15.3 0 01-4 9 15.3 15.3 0 01-4-9 15.3 15.3 0 014-9z" />
                  </svg>
                  <span className="text-caption font-mono tracking-wide text-secondary">
                    {NETWORK_LABEL}
                  </span>
                </button>

                {openDropdown === 'network-switch' && (
                  <div id="nav-panel-network-switch" className="absolute right-0 mt-1 w-36 dropdown-menu rounded-lg shadow-xl border p-2 z-50 animate-scale-in origin-top-right">
                    <a
                      href={MAINNET_URL}
                      aria-current={isMainnet ? 'true' : undefined}
                      className={`block px-3 py-2 rounded-md text-caption font-mono transition-colors ${
                        isMainnet ? 'text-primary bg-cipher-hover' : 'text-secondary dropdown-item'
                      }`}
                    >
                      Mainnet
                    </a>
                    <a
                      href={TESTNET_URL}
                      aria-current={!isMainnet && !isCrosslink ? 'true' : undefined}
                      className={`block px-3 py-2 rounded-md text-caption font-mono transition-colors ${
                        !isMainnet && !isCrosslink ? 'text-primary bg-cipher-hover' : 'text-secondary dropdown-item'
                      }`}
                    >
                      Testnet
                    </a>
                    <a
                      href={CROSSLINK_URL}
                      aria-current={isCrosslink ? 'true' : undefined}
                      className={`block px-3 py-2 rounded-md text-caption font-mono transition-colors ${
                        isCrosslink ? 'text-primary bg-cipher-hover' : 'text-secondary dropdown-item'
                      }`}
                    >
                      Crosslink
                    </a>
                  </div>
                )}
              </div>

              {/* Shortcuts, theme and support — desktop only. The drawer and footer carry the same links on small screens. */}
              <div className="hidden xl:flex items-center gap-1">
                {/* Search opens a dialog, so the header shows its icon, not a field. The homepage has its own
                    search box and hides this one in CSS; the markup stays identical for SSR and hydration. */}
                <button ref={searchTriggerRef} type="button" aria-label="Search Zcash" aria-haspopup="dialog" aria-expanded={searchOpen} aria-controls="navigation-search"
                  title="Search (⌘K / Ctrl+K)"
                  onClick={() => { setOpenDropdown(null); setSearchOpen(true); }}
                  className={`${UTILITY_ICON} nav-search-compact`}>
                  <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}><circle cx="10.5" cy="10.5" r="6.5" /><path strokeLinecap="round" d="m16 16 4.5 4.5" /></svg>
                </button>
                <PrivateExplorerLink />
                <ToolsLink current={activeHref === '/tools'} />
                <ThemeToggle />
                <DonateButton compact />
              </div>

              {/* Mobile: hamburger */}
              <button
                ref={mobileTriggerRef}
                type="button"
                aria-expanded={mobileMenuOpen}
                aria-controls="mobile-navigation"
                onClick={() => {
                  setOpenDropdown(null);
                  setMobileAccordion(categories.find(cat => cat.items.some(item => item.href === activeHref))?.id ?? categories[0]?.id ?? null);
                  setMobileMenuOpen(true);
                }}
                className="xl:hidden inline-flex h-11 w-11 items-center justify-center rounded-md text-muted hover:text-primary transition duration-150"
                aria-label="Open navigation menu"
              >
                <svg aria-hidden="true" className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {mobileMenuOpen ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  )}
                </svg>
              </button>
            </div>
          </div>

          {/* The same homepage CSS controls the mobile search. */}
          <div className="xl:hidden pb-3 nav-search-compact">
            <SearchBar compact />
          </div>
        </div>
      </nav>

      <dialog ref={searchDialogRef} id="navigation-search" aria-labelledby="navigation-search-title"
        onKeyDown={containDialogFocus} onCancel={() => setSearchOpen(false)}
        onClick={event => { if (event.target === event.currentTarget) setSearchOpen(false); }}
        className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none border-0 bg-transparent p-4 text-primary backdrop:bg-black/50 backdrop:backdrop-blur-sm">
        <div className="mx-auto mt-[15vh] w-full max-w-2xl rounded-xl border border-cipher-border bg-cipher-bg p-5 shadow-xl sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 id="navigation-search-title" className="text-base font-medium">Search Zcash</h2>
            <button type="button" aria-label="Close search" onClick={() => setSearchOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-cipher-hover hover:text-primary">
              <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" d="m6 6 12 12M6 18 18 6" /></svg>
            </button>
          </div>
          <SearchBar compact onNavigate={() => setSearchOpen(false)} />
          <p className="mt-3 text-xs text-muted">Find a page, chart, address, transaction, block or Zcash name.</p>
        </div>
      </dialog>

      {/* Mobile Full-Screen Overlay Drawer with Accordion Categories */}
      <dialog ref={drawerRef} id="mobile-navigation" aria-label="Navigation menu"
          className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none border-0 bg-transparent p-0 backdrop:bg-black/50 backdrop:backdrop-blur-sm"
          onKeyDown={containDialogFocus}
      onCancel={() => setMobileMenuOpen(false)}
          onClick={event => { if (event.target === event.currentTarget) setMobileMenuOpen(false); }}>
          {mobileMenuOpen && (

          <div className="absolute inset-y-0 right-0 w-full max-w-sm flex flex-col mobile-drawer shadow-2xl animate-slide-in-right">
            {/* Header */}
            <div className="flex items-center justify-between h-16 px-4 border-b navbar-border flex-shrink-0">
              <BrandLogo />
              <button
                type="button"
                autoFocus
                onClick={() => setMobileMenuOpen(false)}
                className="p-3 rounded-md text-muted hover:text-primary transition"
                aria-label="Close menu"
              >
                <svg aria-hidden="true" className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Scrollable body with accordion categories */}
            <div className="flex-1 overflow-y-auto overscroll-contain pt-3 pb-8 px-3 space-y-0.5">
              {categories.map(cat => (
                <div key={cat.id}>
                  <button
                    type="button"
                    aria-expanded={mobileAccordion === cat.id}
                    aria-controls={`mobile-panel-${cat.id}`}
                    onClick={() => setMobileAccordion(prev => prev === cat.id ? null : cat.id)}
                    className="flex min-h-11 items-center justify-between w-full px-3 py-2.5 rounded-md transition-colors duration-150 text-left mobile-menu-item"
                  >
                    {/* Menu name outranks the group sub-headings inside it, which keep the small uppercase label. */}
                    <span className="text-sm font-mono font-medium text-primary">{cat.label}</span>
                    <svg aria-hidden="true"
                      className={`w-3.5 h-3.5 text-muted transition-transform duration-200 ${mobileAccordion === cat.id ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {mobileAccordion === cat.id && (
                    <div id={`mobile-panel-${cat.id}`} className="pb-2 animate-fade-in">
                      {cat.groups.map(group => (
                        <div key={group.label ?? cat.id} role={group.label ? 'group' : undefined} aria-label={group.label}>
                          {group.label && <p aria-hidden="true" className="type-label text-muted uppercase ml-2 px-3 pt-3 pb-1">{group.label}</p>}
                          {group.items.map(item => {
                            const children = nestedLinks[item.href] ?? [];
                            const childCurrent = children.some(child => child.href === exactHref);
                            return (
                              <div key={item.href}>
                                <Link
                                  href={item.href}
                                  onClick={closeAll}
                                  aria-current={activeHref === item.href && !childCurrent ? 'page' : undefined}
                                  className={`flex flex-col px-3 py-3 ml-2 mobile-menu-item rounded-md transition-colors duration-150 ${activeHref === item.href ? 'bg-cipher-hover !text-primary' : ''}`}
                                >
                                  <span className="text-sm font-mono">{item.label}</span>
                                  <span className="text-caption text-muted mt-0.5">{item.desc}</span>
                                </Link>
                                {children.length > 0 && (
                                  <ul className="ml-5 mb-1 border-l border-cipher-border pl-1">
                                    {children.map(child => (
                                      <li key={child.href}>
                                        <Link href={child.href} onClick={closeAll}
                                          aria-current={exactHref === child.href ? 'page' : undefined}
                                          className={`flex min-h-11 items-center px-3 text-caption font-mono mobile-menu-item rounded-md transition-colors duration-150 ${exactHref === child.href ? '!text-primary' : ''}`}>
                                          {child.label}
                                        </Link>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}


              {/* Buy ZEC — mainnet only */}
              {isMainnet && (
                <div className="px-3 pt-3">
                  <a
                    href="https://cipherswap.app/"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setMobileMenuOpen(false)}
                    className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-lg font-mono text-sm font-semibold text-cipher-yellow border border-cipher-yellow/30 hover:bg-cipher-yellow/10 transition"
                  >
                    <span className="text-cipher-yellow/50">&gt;</span>
                    Buy ZEC
                  </a>
                </div>
              )}

              {/* Footer — network switcher + utilities */}
              <div className="pt-4 mt-2 border-t navbar-border">
                <div className="flex flex-col gap-3 px-3">
                  {/* Network links */}
                  <div className="flex items-center gap-2">
                    <a
                      href={MAINNET_URL}
                      aria-current={isMainnet ? 'true' : undefined}
                      className={`text-caption font-mono px-2.5 py-1.5 rounded-md transition ${
                        isMainnet ? 'bg-cipher-hover text-primary' : 'text-muted hover:text-primary'
                      }`}
                    >
                      Mainnet
                    </a>
                    <a
                      href={TESTNET_URL}
                      aria-current={!isMainnet && !isCrosslink ? 'true' : undefined}
                      className={`text-caption font-mono px-2.5 py-1.5 rounded-md transition ${
                        !isMainnet && !isCrosslink ? 'bg-cipher-hover text-primary' : 'text-muted hover:text-primary'
                      }`}
                    >
                      Testnet
                    </a>
                    <a
                      href={CROSSLINK_URL}
                      aria-current={isCrosslink ? 'true' : undefined}
                      className={`text-caption font-mono px-2.5 py-1.5 rounded-md transition ${
                        isCrosslink ? 'bg-cipher-hover text-primary' : 'text-muted hover:text-primary'
                      }`}
                    >
                      Crosslink
                    </a>
                  </div>

                  {/* Shortcuts, support and theme. Search stays as the field under the logo on small screens. */}
                  <div className="flex items-center justify-end gap-2">
                    <PrivateExplorerLink onNavigate={closeAll} />
                    <ToolsLink current={activeHref === '/tools'} onNavigate={closeAll} />
                    <DonateButton compact />
                    <ThemeToggle />
                  </div>
                </div>
              </div>
            </div>
          </div>
          )}
        </dialog>
    </>
  );
}
