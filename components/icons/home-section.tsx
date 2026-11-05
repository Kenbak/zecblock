import type { ReactNode } from 'react';

type HomeSectionIconProps = { className?: string };

/** Quiet category markers matching the existing 24px / 1.5px shield family. */
function Icon({ className = 'w-5 h-5', children }: HomeSectionIconProps & { children: ReactNode }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export function BlockSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></Icon>;
}

export function MempoolSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><path d="M4 13 7 5h10l3 8v6H4Z" /><path d="M4 13h4l2 3h4l2-3h4" /></Icon>;
}

export function TransactionSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><path d="M4 7h16l-4-4m4 4-4 4M20 17H4l4-4m-4 4 4 4" /></Icon>;
}

export function ReorgSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 7v10M18 7v2a5 5 0 0 1-5 5H6" /></Icon>;
}

export function MiningSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><path d="M4 6c6-3 12-1 16 5l-2 2C14 8 9 6 4 8Z" /><path d="m12 10-8 10 2 2 9-10" /></Icon>;
}

export function SoftwareSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16" /></Icon>;
}

export function ActivitySectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><path d="M3 12h4l3-8 4 16 3-8h4" /></Icon>;
}

export function NetworkSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><circle cx="6" cy="5" r="2" /><circle cx="18" cy="8" r="2" /><circle cx="8" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="m8 5 8 2M6 7l2 10m2 2h7m1-9 1 7M8 7l9 10" /></Icon>;
}

export function CoinsSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><ellipse cx="9" cy="5" rx="6" ry="2" /><path d="M3 5v5c0 2.7 12 2.7 12 0V5M3 10v5c0 2 5 2.5 8 1.7" /><ellipse cx="16" cy="13" rx="5" ry="2" /><path d="M11 13v6c0 2.7 10 2.7 10 0v-6" /></Icon>;
}

export function HalvingSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 3v18M8 5v14M5 9v6" /></Icon>;
}

export function TimerSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><path d="M10 2h4m-2 6v5l3 2m3-9 2-2" /><circle cx="12" cy="13" r="8" /></Icon>;
}

export function ServerSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5" /></Icon>;
}

export function RankingSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><path d="M3 10h5v11H3Zm5-6h8v17H8Zm8 10h5v7h-5Z" /></Icon>;
}

export function MarketSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><path d="M3 4v17h18M6 15l5-5 4 3 6-7m-5 0h5v5" /></Icon>;
}

export function WalletSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><path d="M4 7V5a2 2 0 0 1 2-2h12v4M4 7h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Zm17 5h-6v5h6M17 14.5h.01" /></Icon>;
}

export function SearchSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><circle cx="10.5" cy="10.5" r="7" /><path d="m16 16 5 5" /></Icon>;
}

export function DistributionSectionIcon(props: HomeSectionIconProps) {
  return <Icon {...props}><path d="M4 20V10h4v10m2 0V4h4v16m2 0v-7h4v7M2 20h20" /></Icon>;
}
