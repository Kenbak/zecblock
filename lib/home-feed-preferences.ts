export const HOME_FEED_TYPES = ['blocks', 'shielded', 'transactions', 'reorgs', 'miners', 'software', 'ironwood', 'poolsChart'] as const;
export type HomeFeedType = typeof HOME_FEED_TYPES[number];

const slots = [
  { key: 'cipherscan-home-card-left', defaultType: 'blocks', attribute: 'data-home-left-pending' },
  { key: 'cipherscan-home-card-right', defaultType: 'shielded', attribute: 'data-home-right-pending' },
] as const;

export function homeFeedPendingAttribute(storageKey: string): string | undefined {
  return slots.find(slot => slot.key === storageKey)?.attribute;
}

// Only returning visitors with a different saved feed need to conceal the
// default table. This parser-time guard runs independently of Next's chunks.
// A failed chunk reveals the useful server snapshot immediately; a stalled
// hydration may conceal it for at most five seconds. Default/invalid/denied
// preferences never hide content or start a timer. No per-user server cache.
export const HOME_FEED_PREFERENCE_BOOTSTRAP = `(() => {
  if (location.pathname !== '/') return;
  const root = document.documentElement;
  const pending = [];
  for (const slot of ${JSON.stringify(slots)}) {
    try {
      const saved = localStorage.getItem(slot.key);
      if (${JSON.stringify(HOME_FEED_TYPES)}.includes(saved) && saved !== slot.defaultType) {
        root.setAttribute(slot.attribute, '');
        pending.push(slot.attribute);
      }
    } catch {}
  }
  if (!pending.length) return;
  let deadline;
  const cleanup = () => {
    clearTimeout(deadline);
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onRejection);
    document.removeEventListener('home-feed-ready', onReady);
  };
  const showDefaults = () => {
    for (const attribute of pending) root.removeAttribute(attribute);
    cleanup();
  };
  const onReady = () => {
    if (pending.every(attribute => !root.hasAttribute(attribute))) cleanup();
  };
  const onError = event => {
    const script = event.target;
    const source = script?.tagName === 'SCRIPT' ? script.src : event.filename;
    if (typeof source === 'string' && source.includes('/_next/')) showDefaults();
  };
  const onRejection = event => {
    if (/ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module/i.test(String(event.reason?.message || event.reason || ''))) showDefaults();
  };
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);
  document.addEventListener('home-feed-ready', onReady);
  deadline = setTimeout(showDefaults, 5000);
})();`;
