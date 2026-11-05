/**
 * Single source of truth for node/client color coding across the site.
 * Previously NodeMap, NodesClient, and TopologyGraph each hard-coded their
 * own (inconsistent) client -> color maps, so the same client (e.g. Zebra)
 * rendered a different color depending on which page you were on.
 */

export const CLIENT_COLORS: Record<string, string> = {
  Zebra: '#FBBF24',
  Zakura: '#F472B6',
  Zebend: '#E4573D',
  zcashd: '#A1A9AD',
  Seeder: '#9B8AFB',
  Other: '#7D8A9A',
  Unknown: '#4B5563',
  Unidentified: '#4B5563',
};

/** The crawler stores nodes with no advertised user-agent as "Unknown"; present
 * them honestly as "Unidentified" (reachable, but did not advertise a client). */
export function clientLabel(client: string | null | undefined): string {
  if (!client || client === 'Unknown') return 'Unidentified';
  return client;
}

export function clientColor(client: string | null | undefined): string {
  const key = client || 'Unknown';
  return CLIENT_COLORS[key] || CLIENT_COLORS.Other;
}

export const CLIENT_BADGE_CLASSES: Record<string, string> = {
  Zebra: 'bg-[#FBBF24]/15 text-[#FBBF24] border-[#FBBF24]/30',
  Zakura: 'bg-[#F472B6]/15 text-[#F472B6] border-[#F472B6]/30',
  Zebend: 'bg-[#E4573D]/15 text-[#E4573D] border-[#E4573D]/30',
  zcashd: 'bg-[#A1A9AD]/15 text-[#A1A9AD] border-[#A1A9AD]/30',
  Seeder: 'bg-[#9B8AFB]/15 text-[#9B8AFB] border-[#9B8AFB]/30',
  Other: 'bg-[#7D8A9A]/15 text-[#7D8A9A] border-[#7D8A9A]/30',
  Unknown: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  Unidentified: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
};

export function clientBadgeClass(client: string | null | undefined): string {
  const key = client || 'Unknown';
  return CLIENT_BADGE_CLASSES[key] || CLIENT_BADGE_CLASSES.Other;
}

/**
 * Stable-ish palette for "top ISP per location" style views (Concentration
 * Risk, Infra map lens). ISPs are assigned colors by frequency rank within a
 * given dataset, so the mapping is only stable within one render/session —
 * that's fine, we're not persisting it anywhere.
 */
const ISP_PALETTE = [
  '#91AC90', '#E8C48D', '#A1A9AD', '#B6A0E0', '#f59e0b',
  '#22c55e', '#ef4444', '#ec4899', '#91AC90', '#64748b',
];
export const ISP_OTHER_COLOR = '#4B5563';
export const ISP_UNRESOLVED_COLOR = '#374151';

export function buildIspColorMap(ispsRankedByFrequency: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  ispsRankedByFrequency.forEach((isp, i) => {
    if (isp === 'Unresolved') {
      map[isp] = ISP_UNRESOLVED_COLOR;
      return;
    }
    map[isp] = i < ISP_PALETTE.length ? ISP_PALETTE[i] : ISP_OTHER_COLOR;
  });
  return map;
}
