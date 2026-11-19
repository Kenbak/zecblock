// Editorial snapshot. Review primary sources before changing availability or method.
export const READINESS_REVIEWED_AT = '2026-09-17';

export interface ReadinessEntry {
  name: string;
  platform: string;
  status: 'available' | 'limited';
  method: string;
  detail: string;
  sources: { label: string; href: string }[];
}

const zodlRelease = 'https://zodl.com/zodl-3-9-0-ironwood-migration-zodl-slipstream/';
const zkoolChangelog = 'https://github.com/hhanh00/zkool2/blob/zkool-v6.30.0/CHANGELOG.md';

export const WALLET_READINESS: ReadinessEntry[] = [
  {
    name: 'Vizor', platform: 'Desktop · v0.0.56 reviewed', status: 'available', method: 'Staged or immediate',
    detail: 'Software and Keystone migration supported. The v0.0.56 release excludes migration of recovered Orchard funds for Ledger accounts.',
    sources: [
      { label: 'Migration release', href: 'https://github.com/chainapsis/vizor-wallet/releases/tag/release/v0.0.39' },
      { label: 'Current limitations', href: 'https://github.com/chainapsis/vizor-wallet/releases/tag/release/v0.0.56' },
    ],
  },
  {
    name: 'ZODL', platform: 'iOS · migration since v3.9.0', status: 'available', method: 'Gradual or immediate',
    detail: 'Gradual transfers require reopening the app when notified. Includes Tor protection and Keystone support.',
    sources: [{ label: 'Release guide', href: zodlRelease }],
  },
  {
    name: 'ZODL', platform: 'Android · migration since v3.9.0', status: 'available', method: 'Gradual or immediate',
    detail: 'Gradual migration can continue in the background after it is started.',
    sources: [{ label: 'Release guide', href: zodlRelease }],
  },
  {
    name: 'Cake Wallet', platform: 'Migration since v6.4.0', status: 'available', method: 'Automatic, split transfers',
    detail: 'Migration progresses while the wallet is synced and the app stays open; closing it pauses the process.',
    sources: [
      { label: 'Migration guide', href: 'https://docs.cakewallet.com/cryptos/zcash/ironwood-migration' },
      { label: 'v6.4.0 release', href: 'https://github.com/cake-tech/cake_wallet/releases/tag/v6.4.0' },
    ],
  },
  {
    name: 'Zkool', platform: 'Desktop / Android APK · v6.30.0', status: 'available', method: 'Split or one-shot',
    detail: 'Separate splitting and migration steps, adjustable timing, and a one-shot option. Store versions may differ from GitHub builds.',
    sources: [
      { label: 'Release', href: 'https://github.com/hhanh00/zkool2/releases/tag/zkool-v6.30.0' },
      { label: 'Migration changes', href: zkoolChangelog },
    ],
  },
  {
    name: 'Zkool', platform: 'iOS · App Store v6.25.1', status: 'available', method: 'Split migration',
    detail: 'Ironwood support is available in the iOS store build released August 5.',
    sources: [
      { label: 'App Store', href: 'https://apps.apple.com/us/app/zkool/id6736854027' },
      { label: 'Migration changes', href: zkoolChangelog },
    ],
  },
  {
    name: 'Edge', platform: 'iOS / Android · migration in v4.50.2', status: 'available', method: 'Send-to-self sweep',
    detail: 'A migration card prepares a maximum-amount send to your own wallet through the normal send screen.',
    sources: [{ label: 'Release changelog', href: 'https://github.com/EdgeApp/edge-react-gui/blob/v4.50.2/CHANGELOG.md' }],
  },
  {
    name: 'Brave Wallet', platform: 'v1.95.101 reviewed', status: 'limited', method: 'Full migration unconfirmed',
    detail: 'The release adds a notice limiting Zcash to deshielding and transparent sends during the transition.',
    sources: [
      { label: 'Release', href: 'https://github.com/brave/brave-browser/releases/tag/v1.95.101' },
      { label: 'Support notice', href: 'https://github.com/brave/brave-core/pull/39448/files' },
    ],
  },
];

export const MIGRATION_LIBRARIES: ReadinessEntry[] = [
  {
    name: 'Zcash iOS SDK', platform: 'v3.0.0', status: 'available', method: 'Migration engine',
    detail: 'Released Orchard-to-Ironwood scheduling, signing and broadcast APIs. App integration determines the user experience.',
    sources: [{ label: 'Release notes', href: 'https://github.com/zcash/zcash-swift-wallet-sdk/releases/tag/3.0.0' }],
  },
  {
    name: 'Zcash Android SDK', platform: 'v3.0.0', status: 'available', method: 'ZIP-318 engine',
    detail: 'OrchardMigrationSdk provides scheduled transfers. The separate immediate-migration API crosses the full balance in one transaction.',
    sources: [{ label: 'Release notes', href: 'https://github.com/zcash/zcash-android-wallet-sdk/releases/tag/v3.0.0' }],
  },
  {
    name: 'zcash_pool_migration', platform: 'Rust crate · v0.1.0 published', status: 'available', method: 'Migration engine',
    detail: 'Plans denominations, signs transfers and schedules them by block height; the integrating wallet handles broadcast.',
    sources: [
      { label: 'Published crate', href: 'https://crates.io/crates/zcash_pool_migration/0.1.0' },
      { label: 'Documentation', href: 'https://docs.rs/zcash_pool_migration/latest/zcash_pool_migration/' },
    ],
  },
];
