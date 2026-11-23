import { unstable_cache } from 'next/cache';
import { getGovernanceCatalog } from './governance-data';
import { buildAnnouncementSnapshot, type AnnouncementSnapshot } from './governance-announcement';

// Seed for the site-wide banner in server HTML. Its own five-minute cache keeps
// the layout from lowering every page's ISR interval to the directory's minute;
// the browser still refreshes from /api/governance/announcement each minute and
// drops a seed whose window has closed. Unavailable catalogs throw, so they are
// never cached as "no announcement".
const SEED_REVALIDATE_SECONDS = 300;
const SEED_WAIT_MS = 1_000;

const cachedSeed = unstable_cache(async (): Promise<AnnouncementSnapshot> => {
  const catalog = await getGovernanceCatalog();
  if (catalog.unavailable) throw new Error('governance catalog unavailable');
  return buildAnnouncementSnapshot(catalog, Date.now()).snapshot;
}, ['governance-banner-seed-v1'], { revalidate: SEED_REVALIDATE_SECONDS });

export async function getGovernanceBannerSeed(): Promise<AnnouncementSnapshot | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), SEED_WAIT_MS); });
  try {
    return await Promise.race([cachedSeed().catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
