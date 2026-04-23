import { Package } from "lucide-react";
import { useBranding } from "@/lib/branding-context";

/**
 * App logo tile used in the top nav. Renders the uploaded logo (data URL) if
 * one has been configured in /admin/branding, otherwise falls back to the
 * default Package icon on a brand-violet → brand-sky gradient.
 *
 * Sized to slot into the existing 36×36 nav tile.
 */
export function BrandedLogo({ className = "" }: { className?: string }) {
  const { branding } = useBranding();

  if (branding.logo_data_url) {
    return (
      <div
        className={
          "relative h-9 w-9 rounded-xl overflow-hidden bg-card border border-border/60 flex items-center justify-center group-hover:scale-105 transition-transform " +
          className
        }
      >
        <img
          src={branding.logo_data_url}
          alt={`${branding.app_name} logo`}
          className="h-full w-full object-contain"
        />
      </div>
    );
  }

  return (
    <div
      className={
        "relative h-9 w-9 rounded-xl bg-primary text-primary-foreground flex items-center justify-center group-hover:scale-105 transition-transform " +
        className
      }
    >
      <Package className="h-4.5 w-4.5" strokeWidth={2.5} />
    </div>
  );
}
