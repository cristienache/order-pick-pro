import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, type Site } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Package, Truck, Store, Users, Settings, ArrowUpRight, Sparkles,
  type LucideIcon,
} from "lucide-react";

export const Route = createFileRoute("/")({
  component: () => (
    <RequireAuth>
      <AppShell>
        <HomePage />
      </AppShell>
    </RequireAuth>
  ),
  head: () => ({
    meta: [
      { title: "Ultrax — Multi-store order operations" },
      {
        name: "description",
        content:
          "One calm place for picking, packing and shipping orders across every WooCommerce store you run.",
      },
    ],
  }),
});

type Accent = "violet" | "emerald" | "amber" | "sky" | "rose";
type Tool = {
  to: "/orders" | "/royal-mail" | "/integrations" | "/admin/users" | "/admin/invites";
  label: string;
  caption: string;
  description: string;
  icon: LucideIcon;
  accent: Accent;
  adminOnly?: boolean;
};

const ACCENT_TILE: Record<Accent, string> = {
  violet: "bg-brand-violet text-white",
  emerald: "bg-brand-emerald text-white",
  amber: "bg-brand-amber text-white",
  sky: "bg-brand-sky text-white",
  rose: "bg-brand-rose text-white",
};
const ACCENT_GLOW: Record<Accent, string> = {
  violet: "shadow-[0_18px_40px_-22px_color-mix(in_oklab,var(--brand-violet)_70%,transparent)]",
  emerald: "shadow-[0_18px_40px_-22px_color-mix(in_oklab,var(--brand-emerald)_70%,transparent)]",
  amber: "shadow-[0_18px_40px_-22px_color-mix(in_oklab,var(--brand-amber)_70%,transparent)]",
  sky: "shadow-[0_18px_40px_-22px_color-mix(in_oklab,var(--brand-sky)_70%,transparent)]",
  rose: "shadow-[0_18px_40px_-22px_color-mix(in_oklab,var(--brand-rose)_70%,transparent)]",
};

const TOOLS: Tool[] = [
  {
    to: "/orders",
    label: "Orders",
    caption: "Pick, pack & ship",
    description:
      "Pull live orders from every store, filter by status or date, and generate picking, packing or shipping labels in one click.",
    icon: Package,
    accent: "violet",
  },
  {
    to: "/royal-mail",
    label: "Royal Mail",
    caption: "Labels & manifests",
    description:
      "Create, reprint and manifest Royal Mail shipments without leaving the dashboard.",
    icon: Truck,
    accent: "emerald",
  },
  {
    to: "/integrations",
    label: "Integrations",
    caption: "Sales channels",
    description:
      "Connect new WooCommerce stores or rotate the API keys on the ones you already run. Shopify, Etsy, Magento and eBay coming soon.",
    icon: Store,
    accent: "amber",
  },
  {
    to: "/admin/users",
    label: "Users",
    caption: "Team access",
    description: "Manage who can sign in to Ultrax and what they can do.",
    icon: Users,
    accent: "sky",
    adminOnly: true,
  },
  {
    to: "/admin/invites",
    label: "Invites",
    caption: "Onboard teammates",
    description: "Send a one-time invite link so a new teammate can join.",
    icon: Settings,
    accent: "rose",
    adminOnly: true,
  },
];

function HomePage() {
  const { user } = useAuth();
  const [sites, setSites] = useState<Site[] | null>(null);

  useEffect(() => {
    api<{ sites: Site[] }>("/api/sites")
      .then((r) => setSites(r.sites))
      .catch(() => setSites([]));
  }, []);

  const visibleTools = TOOLS.filter((t) => !t.adminOnly || user?.role === "admin");
  const featured = visibleTools[0];
  const firstName = (user?.email || "").split("@")[0];

  return (
    <div className="space-y-10">
      {/* Hero */}
      <section className="surface-hero relative overflow-hidden rounded-3xl border border-border/60 px-6 py-12 md:px-12 md:py-16">
        <div className="grid md:grid-cols-[1.4fr_1fr] gap-10 items-center">
          <div className="space-y-6">
            <Badge
              variant="secondary"
              className="rounded-full px-3 py-1 uppercase tracking-[0.18em] text-[10px] font-semibold bg-card border border-border/60"
            >
              <Sparkles className="h-3 w-3 text-brand-violet" />
              {firstName ? `Welcome back, ${firstName}` : "Multi-store order ops"}
            </Badge>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.04]">
              One calm place for{" "}
              <span className="bg-gradient-to-r from-brand-violet via-primary to-brand-sky bg-clip-text text-transparent">
                multi-store
              </span>{" "}
              order operations.
            </h1>
            <p className="text-base md:text-lg text-muted-foreground max-w-xl leading-relaxed">
              Move between picking, packing, Royal Mail labels and store
              management without leaving the page.
              {sites && sites.length > 0 && (
                <>
                  {" "}
                  Currently connected to{" "}
                  <span className="font-semibold text-foreground">
                    {sites.length} {sites.length === 1 ? "store" : "stores"}
                  </span>
                  .
                </>
              )}
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                to="/orders"
                className="inline-flex items-center gap-2 rounded-full bg-foreground text-background px-5 py-2.5 text-sm font-semibold hover:opacity-90 transition shadow-lg shadow-foreground/10"
              >
                Open the picklist
                <ArrowUpRight className="h-4 w-4" />
              </Link>
              <Link
                to="/integrations"
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium hover:bg-accent transition"
              >
                Manage integrations
              </Link>
            </div>
          </div>

          {/* Featured tool card */}
          {featured && (
            <Link
              to={featured.to}
              className={`group relative block rounded-3xl bg-foreground text-background p-6 hover:scale-[1.015] transition-transform ${ACCENT_GLOW[featured.accent]}`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`h-11 w-11 rounded-2xl flex items-center justify-center ${ACCENT_TILE[featured.accent]}`}
                >
                  <featured.icon className="h-5 w-5" strokeWidth={2.25} />
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] opacity-60">
                    Featured tool
                  </div>
                  <div className="text-sm font-medium opacity-90">
                    {featured.caption}
                  </div>
                </div>
              </div>
              <div className="mt-10 flex items-end justify-between">
                <div className="text-3xl md:text-4xl font-bold tracking-tight">
                  {featured.label}
                </div>
                <ArrowUpRight className="h-7 w-7 opacity-50 group-hover:opacity-100 group-hover:-translate-y-1 group-hover:translate-x-1 transition-all" />
              </div>
            </Link>
          )}
        </div>
      </section>

      {/* Tool tiles */}
      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold">
              Workspace
            </div>
            <h2 className="text-2xl font-bold tracking-tight mt-1">
              Jump straight in
            </h2>
          </div>
          <Link
            to="/orders"
            className="hidden md:inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition"
          >
            See orders
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleTools.map((t) => (
            <Link key={t.to} to={t.to} className="group block">
              <Card className="h-full border border-border/60 transition-all hover:border-foreground/20 hover:shadow-xl hover:-translate-y-0.5">
                <CardContent className="p-6 space-y-5">
                  <div className="flex items-start justify-between">
                    <div
                      className={`h-11 w-11 rounded-2xl flex items-center justify-center ${ACCENT_TILE[t.accent]}`}
                    >
                      <t.icon className="h-5 w-5" strokeWidth={2.25} />
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition" />
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-semibold">
                      {t.caption}
                    </div>
                    <div className="text-xl font-bold tracking-tight mt-1">
                      {t.label}
                    </div>
                    <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                      {t.description}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      {/* Connected stores strip */}
      {sites && sites.length > 0 && (
        <section className="space-y-3">
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold">
            Connected stores
          </div>
          <div className="flex flex-wrap gap-2">
            {sites.map((s) => (
              <Link
                key={s.id}
                to="/integrations"
                className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card px-3 py-1.5 text-sm hover:bg-accent transition"
              >
                <Store className="h-3.5 w-3.5 text-muted-foreground" />
                {s.name}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
