import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { api } from "@/lib/api";
import {
  useBranding,
  type Branding,
  COLOR_KEYS,
  NAV_KEYS,
  NAV_DEFAULT_LABELS,
  type ColorKey,
  type NavKey,
} from "@/lib/branding-context";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Loader2, Palette, RotateCcw, Save, Upload, X } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/branding")({
  component: () => (
    <RequireAuth masterAdminOnly>
      <AppShell>
        <BrandingPage />
      </AppShell>
    </RequireAuth>
  ),
  head: () => ({
    meta: [
      { title: "Style & Branding | Ultrax" },
      { name: "description", content: "Master-admin styling: colours, logos, navigation labels and identity." },
    ],
  }),
});

// Default colour values mirror the tokens declared in src/styles.css. They
// pre-populate the colour pickers so admins always see the live value, even
// before they make their first change.
const DEFAULT_COLOR_VALUES: Record<ColorKey, string> = {
  "primary": "oklch(0.5 0.22 285)",
  "brand-violet": "oklch(0.55 0.22 285)",
  "brand-emerald": "oklch(0.62 0.17 162)",
  "brand-amber": "oklch(0.72 0.16 75)",
  "brand-sky": "oklch(0.62 0.16 230)",
  "brand-rose": "oklch(0.62 0.22 18)",
};

const COLOR_LABEL: Record<ColorKey, string> = {
  "primary": "Primary",
  "brand-violet": "Violet (Orders)",
  "brand-emerald": "Emerald (Royal Mail)",
  "brand-amber": "Amber (Sites)",
  "brand-sky": "Sky (Admin)",
  "brand-rose": "Rose (Alerts)",
};

const MAX_UPLOAD_BYTES = 256 * 1024;

/**
 * Convert any string colour (CSS-friendly oklch / hex / rgb / etc) to a
 * `#rrggbb` so an `<input type="color">` can render it. Falls back to a
 * neutral grey if the browser refuses to resolve the value (which is fine —
 * the text input still shows the real value the admin typed).
 */
function toHexForPicker(value: string): string {
  if (typeof window === "undefined") return "#7c3aed";
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  try {
    const probe = document.createElement("div");
    probe.style.color = value;
    probe.style.display = "none";
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color; // "rgb(r, g, b)"
    document.body.removeChild(probe);
    const m = resolved.match(/rgba?\(([^)]+)\)/);
    if (!m) return "#7c3aed";
    const [r, g, b] = m[1].split(",").map((n) => parseInt(n.trim(), 10));
    const toHex = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  } catch {
    return "#7c3aed";
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Read failed"));
    reader.readAsDataURL(file);
  });
}

function BrandingPage() {
  const { saved, refresh, preview } = useBranding();
  const [draft, setDraft] = useState<Branding>(saved);
  const [saving, setSaving] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  const faviconInput = useRef<HTMLInputElement>(null);

  // Sync local draft whenever the upstream saved branding changes (initial load
  // or after a save).
  useEffect(() => { setDraft(saved); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [saved.updated_at]);

  // Push the draft into the BrandingProvider's preview slot so the rest of
  // the app (top nav, page headers, colours) reflects unsaved changes live.
  useEffect(() => {
    preview(draft);
    return () => preview(null);
  }, [draft, preview]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);

  const setColor = (key: ColorKey, value: string) => {
    setDraft((d) => ({ ...d, colors: { ...d.colors, [key]: value } }));
  };
  const resetColor = (key: ColorKey) => {
    setDraft((d) => {
      const next = { ...d.colors };
      delete next[key];
      return { ...d, colors: next };
    });
  };

  const setNav = (key: NavKey, value: string) => {
    setDraft((d) => ({ ...d, nav_labels: { ...d.nav_labels, [key]: value } }));
  };

  const onPickFile = (
    field: "logo_data_url" | "favicon_data_url",
    accept: RegExp,
  ) => async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!accept.test(file.type)) {
      toast.error("Unsupported file type");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(`File too large — keep under ${Math.round(MAX_UPLOAD_BYTES / 1024)}KB`);
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setDraft((d) => ({ ...d, [field]: dataUrl }));
    } catch {
      toast.error("Could not read file");
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      // Only send keys that actually changed to keep the payload tight.
      const payload: Record<string, unknown> = {};
      if (draft.app_name !== saved.app_name) payload.app_name = draft.app_name;
      if (draft.tagline !== saved.tagline) payload.tagline = draft.tagline;
      if (draft.logo_data_url !== saved.logo_data_url) payload.logo_data_url = draft.logo_data_url;
      if (draft.favicon_data_url !== saved.favicon_data_url) payload.favicon_data_url = draft.favicon_data_url;
      if (JSON.stringify(draft.nav_labels) !== JSON.stringify(saved.nav_labels)) payload.nav_labels = draft.nav_labels;
      if (JSON.stringify(draft.colors) !== JSON.stringify(saved.colors)) payload.colors = draft.colors;

      await api("/api/branding", { method: "PUT", body: payload });
      toast.success("Branding saved");
      preview(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const discard = () => { setDraft(saved); preview(null); };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Palette}
        accent="violet"
        eyebrow="Page builder"
        title="Branding"
        description="Customise the app name, tagline, logo, favicon, navigation labels and colour palette. Changes apply globally to every signed-in user."
        actions={
          <>
            <Button variant="outline" onClick={discard} disabled={!dirty || saving}>
              Discard
            </Button>
            <Button onClick={save} disabled={!dirty || saving} className="gap-1.5">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save changes
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Identity */}
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
            <CardDescription>Shown in the top nav, browser tab title and social previews.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="app_name">App name</Label>
              <Input
                id="app_name"
                value={draft.app_name}
                onChange={(e) => setDraft({ ...draft, app_name: e.target.value })}
                maxLength={60}
                placeholder="Ultrax"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tagline">Tagline</Label>
              <Input
                id="tagline"
                value={draft.tagline}
                onChange={(e) => setDraft({ ...draft, tagline: e.target.value })}
                maxLength={80}
                placeholder="Order ops"
              />
              <p className="text-xs text-muted-foreground">
                Sits underneath the app name in tiny uppercase.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Logo & favicon */}
        <Card>
          <CardHeader>
            <CardTitle>Logo & favicon</CardTitle>
            <CardDescription>PNG, SVG or WebP recommended. Max 256KB each.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <AssetField
              label="Logo"
              value={draft.logo_data_url}
              fallbackHint="Default Package icon"
              onPick={() => logoInput.current?.click()}
              onClear={() => setDraft({ ...draft, logo_data_url: null })}
            />
            <input
              ref={logoInput}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              hidden
              onChange={onPickFile("logo_data_url", /^image\/(png|jpeg|svg\+xml|webp)$/)}
            />
            <AssetField
              label="Favicon"
              value={draft.favicon_data_url}
              fallbackHint="No custom favicon"
              onPick={() => faviconInput.current?.click()}
              onClear={() => setDraft({ ...draft, favicon_data_url: null })}
            />
            <input
              ref={faviconInput}
              type="file"
              accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
              hidden
              onChange={onPickFile("favicon_data_url", /^image\/(png|svg\+xml|x-icon|vnd\.microsoft\.icon)$/)}
            />
          </CardContent>
        </Card>

        {/* Navigation labels */}
        <Card>
          <CardHeader>
            <CardTitle>Navigation labels</CardTitle>
            <CardDescription>Rename the items in the top nav. Leave blank to use the default.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {NAV_KEYS.map((key) => (
              <div key={key} className="grid grid-cols-[120px_1fr] items-center gap-3">
                <Label htmlFor={`nav-${key}`} className="text-sm text-muted-foreground">
                  {NAV_DEFAULT_LABELS[key]}
                </Label>
                <Input
                  id={`nav-${key}`}
                  value={draft.nav_labels[key] ?? ""}
                  onChange={(e) => setNav(key, e.target.value)}
                  placeholder={NAV_DEFAULT_LABELS[key]}
                  maxLength={40}
                />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Colour palette */}
        <Card>
          <CardHeader>
            <CardTitle>Colour palette</CardTitle>
            <CardDescription>
              Click a swatch to pick visually, or type any CSS colour
              (<code className="text-xs">oklch(...)</code>, hex, rgb).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {COLOR_KEYS.map((key) => {
              const value = draft.colors[key] ?? "";
              const effective = value || DEFAULT_COLOR_VALUES[key];
              const overridden = value.length > 0;
              return (
                <div key={key} className="grid grid-cols-[140px_44px_1fr_auto] items-center gap-3">
                  <Label className="text-sm">{COLOR_LABEL[key]}</Label>
                  <input
                    type="color"
                    aria-label={`${COLOR_LABEL[key]} colour picker`}
                    value={toHexForPicker(effective)}
                    onChange={(e) => setColor(key, e.target.value)}
                    className="h-9 w-11 rounded-md border border-border bg-transparent cursor-pointer"
                  />
                  <Input
                    value={value}
                    onChange={(e) => setColor(key, e.target.value)}
                    placeholder={DEFAULT_COLOR_VALUES[key]}
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => resetColor(key)}
                    disabled={!overridden}
                    title="Reset to default"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Tip — the top nav, page headers and buttons across the app update live as you edit. Click <strong>Save changes</strong> to persist.
      </p>
    </div>
  );
}

function AssetField({
  label, value, fallbackHint, onPick, onClear,
}: {
  label: string;
  value: string | null;
  fallbackHint: string;
  onPick: () => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex items-center gap-3">
        <div className="h-14 w-14 rounded-lg border border-border bg-muted/40 flex items-center justify-center overflow-hidden shrink-0">
          {value ? (
            <img src={value} alt={`${label} preview`} className="h-full w-full object-contain" />
          ) : (
            <span className="text-[10px] text-muted-foreground text-center px-1">{fallbackHint}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onPick} className="gap-1.5">
            <Upload className="h-4 w-4" /> {value ? "Replace" : "Upload"}
          </Button>
          {value && (
            <Button variant="ghost" size="sm" onClick={onClear} className="gap-1.5">
              <X className="h-4 w-4" /> Remove
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
