// Compact, brand-coloured marks for the integrations strip on the Orders page.
// These are simplified letter-mark renditions — not the official brand logos —
// so we can ship them without licensing concerns. Each is a 24×24 rounded
// square with the brand's signature colour and initial, which gives users a
// quick visual cue without depending on external assets.

type LogoProps = { className?: string };

function LogoTile({
  bg,
  fg = "#fff",
  letter,
  className,
  title,
}: {
  bg: string;
  fg?: string;
  letter: string;
  className?: string;
  title: string;
}) {
  return (
    <span
      aria-label={title}
      title={title}
      className={
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold leading-none " +
        (className || "")
      }
      style={{ background: bg, color: fg }}
    >
      {letter}
    </span>
  );
}

export const WooCommerceLogo = ({ className }: LogoProps) => (
  <LogoTile bg="#7f54b3" letter="W" title="WooCommerce" className={className} />
);

export const ShopifyLogo = ({ className }: LogoProps) => (
  <LogoTile bg="#95bf47" letter="S" title="Shopify" className={className} />
);

export const EtsyLogo = ({ className }: LogoProps) => (
  <LogoTile bg="#f1641e" letter="E" title="Etsy" className={className} />
);

export const MagentoLogo = ({ className }: LogoProps) => (
  <LogoTile bg="#ee672f" letter="M" title="Magento" className={className} />
);

export const EbayLogo = ({ className }: LogoProps) => (
  // eBay's mark mixes four colours; we use the red 'b' as the recognisable cue.
  <LogoTile bg="#e53238" letter="e" title="eBay" className={className} />
);
