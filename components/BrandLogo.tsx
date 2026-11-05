import Image from 'next/image';

/**
 * The ZecBlock logotype: gold block + "Zec" in gold, "Block" in the theme's ink.
 *
 * Two supplied PNGs, pixel-aligned (both 422x98 with identical content
 * bounds), stacked and cross-faded by CSS. That replaces the previous
 * single-artwork-plus-gradient-mask approach, which had to encode the
 * logotype's color boundaries as hardcoded gradient stops and re-measuring
 * them by hand every time the artwork changed. Swapping by CSS variable
 * rather than by reading the theme in JS keeps it correct during SSR and
 * avoids a hydration mismatch or a flash of the wrong variant.
 *
 * `tone` forces a variant regardless of theme, for the press-kit previews
 * that show both on one page.
 *
 * The wrapper's role="img" makes the images presentational for assistive
 * tech, so their alt text is not announced twice; it is there for crawlers
 * (Bing flags empty alt on the logo).
 */
export function BrandLogo({
  className = '',
  compact = false,
  priority = false,
  tone,
}: {
  className?: string;
  compact?: boolean;
  priority?: boolean;
  tone?: 'dark' | 'light';
}) {
  return (
    <span
      className={`brand-logo ${compact ? 'brand-logo-compact' : ''} ${className}`}
      data-tone={tone}
      role="img"
      aria-label="ZecBlock"
    >
      <Image
        className="brand-logo-on-dark"
        src="/brand/zecblock-logotype.png"
        alt="ZecBlock"
        width={422}
        height={98}
        priority={priority}
      />
      <Image
        className="brand-logo-on-light"
        src="/brand/zecblock-logotype-light.png"
        alt="ZecBlock"
        width={422}
        height={98}
        priority={priority}
      />
    </span>
  );
}
