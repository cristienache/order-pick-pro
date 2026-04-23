import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";

/**
 * Phase 1 of the page builder — global branding.
 *
 * One row in SQLite drives:
 *   - the app name + tagline shown in the top nav and the document <title>
 *   - the optional logo (data URL) shown next to the name
 *   - the optional favicon (data URL) injected into <head>
 *   - per-nav-item label overrides (e.g. "Orders" → "Picklist")
 *   - colour palette overrides — each entry is a CSS variable name (without
 *     the leading `--`) mapped to a CSS-friendly value (oklch / hex / etc).
 *     We inject them as `:root { --<name>: <value> }` so they cascade over
 *     the defaults in src/styles.css without a rebuild.
 *
 * Settings load once at boot. The provider exposes `refresh()` so the
 * /admin/branding page can update the live UI without a full reload.
 */

export type Branding = {
  app_name: string;
  tagline: string;
  logo_data_url: string | null;
  favicon_data_url: string | null;
  nav_labels: Record<string, string>;
  colors: Record<string, string>;
  updated_at: string | null;
};

export const BRANDING_FALLBACK: Branding = {
  app_name: "Ultrax",
  tagline: "Order ops",
  logo_data_url: null,
  favicon_data_url: null,
  nav_labels: {},
  colors: {},
  updated_at: null,
};

/** Keys we recognise inside `nav_labels`. Anything else is ignored. */
export const NAV_KEYS = [
  "home", "orders", "integrations", "royal_mail", "users", "invites",
] as const;
export type NavKey = (typeof NAV_KEYS)[number];

/** Defaults shown in the nav when no override is set. */
export const NAV_DEFAULT_LABELS: Record<NavKey, string> = {
  home: "Home",
  orders: "Orders",
  integrations: "Integrations",
  royal_mail: "Royal Mail",
  users: "Users",
  invites: "Invites",
};

/**
 * Editable colour tokens. Anything not listed here is ignored when applying
 * overrides. Matches the brand palette already declared in src/styles.css.
 */
export const COLOR_KEYS = [
  "primary",
  "brand-violet",
  "brand-emerald",
  "brand-amber",
  "brand-sky",
  "brand-rose",
] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

type BrandingState = {
  /** Effective branding — saved values merged with any active preview draft. */
  branding: Branding;
  /** The persisted branding as last loaded from the server (no draft merged). */
  saved: Branding;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Optimistically apply a draft (used by the live preview on /admin/branding). */
  preview: (draft: Partial<Branding> | null) => void;
};

const BrandingContext = createContext<BrandingState | null>(null);

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>(BRANDING_FALLBACK);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Partial<Branding> | null>(null);

  const load = useCallback(async () => {
    try {
      const { branding: row } = await api<{ branding: Branding }>("/api/branding");
      setBranding({ ...BRANDING_FALLBACK, ...row });
    } catch {
      // Silent fall-back to defaults — branding is optional.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const effective = useMemo<Branding>(
    () => ({ ...branding, ...(draft || {}) }),
    [branding, draft],
  );

  // Apply <title>, favicon and CSS variable overrides whenever the
  // effective branding changes.
  useEffect(() => {
    if (typeof document === "undefined") return;

    // Document title.
    document.title = `${effective.app_name} — ${effective.tagline}`;

    // Favicon link tag (create or update).
    if (effective.favicon_data_url) {
      let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
      if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
      }
      link.href = effective.favicon_data_url;
    }

    // Colour overrides — emitted as a single inline style tag. We only honor
    // keys we recognise to avoid letting an arbitrary `<style>` payload land
    // in the DOM.
    const allowed = new Set<string>(COLOR_KEYS);
    const overrides = Object.entries(effective.colors || {})
      .filter(([k, v]) => allowed.has(k) && typeof v === "string" && v.trim().length > 0);

    let tag = document.getElementById("brand-overrides") as HTMLStyleElement | null;
    if (overrides.length === 0) {
      if (tag) tag.remove();
      return;
    }
    if (!tag) {
      tag = document.createElement("style");
      tag.id = "brand-overrides";
      document.head.appendChild(tag);
    }
    tag.textContent = `:root{${overrides.map(([k, v]) => `--${k}:${v};`).join("")}}`;
  }, [effective]);

  const value: BrandingState = {
    branding: effective,
    loading,
    refresh: load,
    preview: setDraft,
  };
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding() {
  const ctx = useContext(BrandingContext);
  if (!ctx) throw new Error("useBranding must be used inside BrandingProvider");
  return ctx;
}

/** Resolve a nav label (override → default). */
export function navLabel(branding: Branding, key: NavKey): string {
  const override = branding.nav_labels?.[key];
  if (typeof override === "string" && override.trim().length > 0) return override;
  return NAV_DEFAULT_LABELS[key];
}
