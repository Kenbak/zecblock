import { getGovernanceAnnouncementCatalog } from '@/lib/governance-data';
import { announcementCacheHeaders, buildAnnouncementSnapshot } from '@/lib/governance-announcement';
import { getNetwork } from '@/lib/seo';

export async function GET() {
  if (getNetwork() !== 'mainnet') return Response.json(
    { announcement: null, generatedAt: Date.now(), nextChangeAt: null },
    { headers: announcementCacheHeaders(60) },
  );
  const catalog = await getGovernanceAnnouncementCatalog();
  const { snapshot, ttl } = buildAnnouncementSnapshot(catalog, Date.now());
  return Response.json(snapshot, { headers: announcementCacheHeaders(ttl) });
}
