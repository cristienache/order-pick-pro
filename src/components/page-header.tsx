import type { ReactNode } from "react";
import { type LucideIcon } from "lucide-react";

type Accent = "violet" | "emerald" | "amber" | "sky" | "rose";

const ACCENT_BG: Record<Accent, string> = {
  violet: "bg-brand-violet text-white shadow-[0_8px_24px_-6px_color-mix(in_oklab,var(--brand-violet)_55%,transparent)]",
  emerald: "bg-brand-emerald text-white shadow-[0_8px_24px_-6px_color-mix(in_oklab,var(--brand-emerald)_55%,transparent)]",
  amber: "bg-brand-amber text-white shadow-[0_8px_24px_-6px_color-mix(in_oklab,var(--brand-amber)_55%,transparent)]",
  sky: "bg-brand-sky text-white shadow-[0_8px_24px_-6px_color-mix(in_oklab,var(--brand-sky)_55%,transparent)]",
  rose: "bg-brand-rose text-white shadow-[0_8px_24px_-6px_color-mix(in_oklab,var(--brand-rose)_55%,transparent)]",
};

/**
 * PageHeader — consistent gradient hero banner shown at the top of every
 * route. Houses an icon tile, eyebrow caption, big title, optional
 * description and a slot for actions (toolbar buttons / filters).
 *
 * The same surface treatment (`surface-hero`) is used everywhere so the
 * app feels coherent — Salesforce / Shipstation style.
 */
export function PageHeader({
  icon: Icon,
  eyebrow,
  title,
  description,
  accent = "violet",
  actions,
  children,
}: {
  icon: LucideIcon;
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  accent?: Accent;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="surface-hero rounded-3xl border border-border/60 px-6 py-7 md:px-8 md:py-8">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="flex items-start gap-4 min-w-0">
          <div className={`h-12 w-12 rounded-2xl flex items-center justify-center shrink-0 ${ACCENT_BG[accent]}`}>
            <Icon className="h-6 w-6" strokeWidth={2.25} />
          </div>
          <div className="min-w-0">
            {eyebrow && (
              <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold mb-1">
                {eyebrow}
              </div>
            )}
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight leading-tight">
              {title}
            </h1>
            {description && (
              <p className="text-sm md:text-[15px] text-muted-foreground mt-1.5 max-w-2xl leading-relaxed">
                {description}
              </p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex items-center gap-2 flex-wrap shrink-0">{actions}</div>
        )}
      </div>
      {children && <div className="mt-6">{children}</div>}
    </header>
  );
}
