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

type Tool = {
  to: "/orders" | "/royal-mail" | "/sites" | "/admin/users" | "/admin/invites";
  label: string;
  caption: string;
  description: string;
  icon: typeof Package;
  accent: string; // tailwind bg/text class for the icon tile
  adminOnly?: boolean;
};

const TOOLS: Tool[] = [
  {
    to: "/orders",
    label: "Orders",
    caption: "Pick, pack & ship",
    description:
      "Pull live orders from every store, filter by status or date, and generate picking, packing or shipping labels in one click.",
    icon: Package,
    accent: "bg-violet-600 text-white",
  },
  {
    to: "/royal-mail",
    label: "Royal Mail",
    caption: "Labels & manifests",
    description:
      "Create, reprint and manifest Royal Mail shipments without leaving the dashboard.",
    icon: Truck,
    accent: "bg-emerald-600 text-white",
  },
  {
    to: "/sites",
    label: "My Sites",
    caption: "WooCommerce stores",
    description:
      "Connect new WooCommerce stores or rotate the API keys on the ones you already run.",
    icon: Store,
    accent: "bg-amber-500 text-white",
  },
  {
    to: "/admin/users",
    label: "Users",
    caption: "Team access",
    description: "Manage who can sign in to Ultrax and what they can do.",
    icon: Users,
    accent: "bg-sky-600 text-white",
    adminOnly: true,
  },
  {
    to: "/admin/invites",
    label: "Invites",
    caption: "Onboard teammates",
    description: "Send a one-time invite link so a new teammate can join.",
    icon: Settings,
    accent: "bg-rose-600 text-white",
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
      <section className="relative overflow-hidden rounded-3xl border bg-gradient-to-br from-violet-50 via-background to-sky-50 dark:from-violet-950/40 dark:via-background dark:to-sky-950/40 px-6 py-12 md:px-12 md:py-16">
        <div className="grid md:grid-cols-[1.4fr_1fr] gap-8 items-center">
          <div className="space-y-6">
            <Badge
              variant="secondary"
              className="rounded-full px-3 py-1 uppercase tracking-wider text-[10px] font-semibold"
            >
              <Sparkles className="h-3 w-3" />
              {firstName ? `Welcome back, ${firstName}` : "Multi-store order ops"}
            </Badge>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.05]">
              One calm place for{" "}
              <span className="text-violet-600 dark:text-violet-400">
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
                  <span className="font-medium text-foreground">
                    {sites.length} {sites.length === 1 ? "store" : "stores"}
                  </span>
                  .
                </>
              )}
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                to="/orders"
                className="inline-flex items-center gap-2 rounded-full bg-foreground text-background px-5 py-2.5 text-sm font-medium hover:opacity-90 transition"
              >
                Open the picklist
                <ArrowUpRight className="h-4 w-4" />
              </Link>
              <Link
                to="/sites"
                className="inline-flex items-center gap-2 rounded-full border bg-background px-5 py-2.5 text-sm font-medium hover:bg-accent transition"
              >
                Manage stores
              </Link>
            </div>
          </div>

          {/* Featured tool card */}
          {featured && (
            <Link
              to={featured.to}
              className="group relative block rounded-2xl bg-foreground text-background p-6 shadow-2xl shadow-violet-900/10 hover:scale-[1.01] transition-transform"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`h-10 w-10 rounded-xl flex items-center justify-center ${featured.accent}`}
                >
                  <featured.icon className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider opacity-70">
                    Current tool
                  </div>
                  <div className="text-sm font-medium opacity-90">
                    {featured.caption}
                  </div>
                </div>
              </div>
              <div className="mt-8 flex items-end justify-between">
                <div className="text-3xl md:text-4xl font-bold tracking-tight">
                  {featured.label}
                </div>
                <Package className="h-8 w-8 opacity-60 group-hover:opacity-100 transition-opacity" />
              </div>
            </Link>
          )}
        </div>
      </section>

      {/* Tool tiles */}
      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-semibold">
              Tools
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
              <Card className="h-full border transition-all hover:border-foreground/20 hover:shadow-lg hover:-translate-y-0.5">
                <CardContent className="p-6 space-y-4">
                  <div className="flex items-start justify-between">
                    <div
                      className={`h-11 w-11 rounded-xl flex items-center justify-center ${t.accent}`}
                    >
                      <t.icon className="h-5 w-5" />
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition" />
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
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
          <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-semibold">
            Connected stores
          </div>
          <div className="flex flex-wrap gap-2">
            {sites.map((s) => (
              <Link
                key={s.id}
                to="/sites"
                className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm hover:bg-accent transition"
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
