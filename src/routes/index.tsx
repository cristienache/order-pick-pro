import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { api, type Site } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { DateRange } from "react-day-picker";
import {
  Package, Truck, Store, Users, Settings, ArrowUpRight, Sparkles,
  Search, Calendar, Download, SlidersHorizontal, TrendingUp, TrendingDown,
  ChevronRight, Boxes, ClipboardList, X, BarChart3,
  type LucideIcon,
} from "lucide-react";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, rectSortingStrategy,
} from "@dnd-kit/sortable";
import { SortablePanel } from "@/components/dashboard/sortable-panel";
import { EditToolbar } from "@/components/dashboard/edit-toolbar";
import { TodaySchedule } from "@/components/dashboard/today-schedule";
import {
  loadLayout, saveLayout, resetLayout, DEFAULT_LAYOUT, PANEL_LABELS,
  type DashboardLayout, type PanelId,
} from "@/lib/dashboard-layout";

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
  to: "/orders" | "/inventory" | "/purchase-orders" | "/integrations/shipping/royal-mail" | "/integrations" | "/analytics" | "/admin/users" | "/admin/invites";
  label: string;
  caption: string;
  category: "Operations" | "Catalog" | "Shipping" | "Channels" | "Analytics" | "Admin";
  icon: LucideIcon;
  adminOnly?: boolean;
};

const TOOLS: Tool[] = [
  { to: "/orders", label: "Orders", caption: "Pick, pack & ship", category: "Operations", icon: Package },
  { to: "/inventory", label: "Inventory", caption: "Stock & SKUs", category: "Catalog", icon: Boxes },
  { to: "/purchase-orders", label: "Purchase Orders", caption: "Suppliers & POs", category: "Catalog", icon: ClipboardList },
  { to: "/analytics", label: "Analytics", caption: "Reports & insights", category: "Analytics", icon: BarChart3 },
  { to: "/integrations/shipping/royal-mail", label: "Royal Mail", caption: "Labels & manifests", category: "Shipping", icon: Truck },
  { to: "/integrations", label: "Integrations", caption: "Sales channels", category: "Channels", icon: Store },
  { to: "/admin/users", label: "Users", caption: "Team access", category: "Admin", icon: Users, adminOnly: true },
  { to: "/admin/invites", label: "Invites", caption: "Onboard teammates", category: "Admin", icon: Settings, adminOnly: true },
];

const ALL_CATEGORIES = ["Operations", "Catalog", "Shipping", "Channels", "Analytics", "Admin"] as const;
type Category = (typeof ALL_CATEGORIES)[number];

function HomePage() {
  const { user } = useAuth();
  const [sites, setSites] = useState<Site[] | null>(null);

  // Controls state
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [activeCategories, setActiveCategories] = useState<Set<Category>>(
    new Set(ALL_CATEGORIES),
  );
  const [filterOpen, setFilterOpen] = useState(false);

  // Editable layout state
  const [layout, setLayout] = useState<DashboardLayout>(DEFAULT_LAYOUT);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setLayout(loadLayout()); }, []);
  useEffect(() => { saveLayout(layout); }, [layout]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setLayout((prev) => {
      const oldIdx = prev.order.indexOf(active.id as PanelId);
      const newIdx = prev.order.indexOf(over.id as PanelId);
      if (oldIdx === -1 || newIdx === -1) return prev;
      return { ...prev, order: arrayMove(prev.order, oldIdx, newIdx) };
    });
  }

  function hidePanel(id: PanelId) {
    setLayout((prev) => ({
      order: prev.order.filter((p) => p !== id),
      hidden: [...prev.hidden, id],
    }));
  }

  function showPanel(id: PanelId) {
    setLayout((prev) => ({
      order: [...prev.order, id],
      hidden: prev.hidden.filter((p) => p !== id),
    }));
  }

  function doResetLayout() { setLayout(resetLayout()); }

  useEffect(() => {
    api<{ sites: Site[] }>("/api/sites")
      .then((r) => setSites(r.sites))
      .catch(() => setSites([]));
  }, []);

  const visibleTools = useMemo(() => {
    const q = search.trim().toLowerCase();
    return TOOLS.filter((t) => !t.adminOnly || user?.role === "admin")
      .filter((t) => activeCategories.has(t.category))
      .filter((t) =>
        q
          ? t.label.toLowerCase().includes(q) ||
            t.caption.toLowerCase().includes(q) ||
            t.category.toLowerCase().includes(q)
          : true,
      );
  }, [search, user?.role, activeCategories]);

  const visibleSites = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!sites) return [];
    return q ? sites.filter((s) => s.name.toLowerCase().includes(q)) : sites;
  }, [sites, search]);

  const firstName = (user?.email || "").split("@")[0];
  const displayName = firstName ? firstName.charAt(0).toUpperCase() + firstName.slice(1) : "there";
  const storeCount = sites?.length ?? 0;

  const dateLabel = useMemo(() => {
    if (!dateRange?.from) return "Date";
    if (dateRange.to) return `${format(dateRange.from, "MMM d")} – ${format(dateRange.to, "MMM d")}`;
    return format(dateRange.from, "MMM d, yyyy");
  }, [dateRange]);

  function toggleCategory(cat: Category) {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  function handleExport() {
    const rows: string[] = [];
    rows.push("Section,Name,Detail,Category");
    visibleTools.forEach((t) => rows.push(`Tool,"${t.label}","${t.caption}",${t.category}`));
    visibleSites.forEach((s) => rows.push(`Store,"${s.name}",,Channels`));
    rows.push("");
    rows.push(`Exported,${new Date().toISOString()},,`);
    if (dateRange?.from) {
      rows.push(`DateFrom,${dateRange.from.toISOString()},,`);
    }
    if (dateRange?.to) {
      rows.push(`DateTo,${dateRange.to.toISOString()},,`);
    }
    if (search) rows.push(`SearchQuery,"${search}",,`);

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ultrax-dashboard-${format(new Date(), "yyyy-MM-dd")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Filtered activity bars: simulate filtering by date span
  const activityBars = useMemo(() => {
    const days = dateRange?.from && dateRange?.to
      ? Math.max(7, Math.min(28, Math.ceil((dateRange.to.getTime() - dateRange.from.getTime()) / 86_400_000) + 1))
      : 14;
    return Array.from({ length: days }).map((_, i) => 30 + ((i * 17) % 60));
  }, [dateRange]);

  const hasActiveFilters =
    search.length > 0 ||
    !!dateRange?.from ||
    activeCategories.size !== ALL_CATEGORIES.length;

  function clearFilters() {
    setSearch("");
    setDateRange(undefined);
    setActiveCategories(new Set(ALL_CATEGORIES));
  }

  return (
    <div className="space-y-6">
      {/* Welcome row */}
      <section className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
            Welcome Back {displayName}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            You have{" "}
            <Link to="/orders" className="text-primary font-medium hover:underline">
              orders waiting
            </Link>{" "}
            across {storeCount} {storeCount === 1 ? "store" : "stores"}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tools & stores…"
              className="h-10 w-56 rounded-xl border border-border bg-card pl-10 pr-4 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>

          <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-10 rounded-xl gap-2",
                  dateRange?.from && "border-primary/40 text-primary",
                )}
              >
                <Calendar className="h-4 w-4" /> {dateLabel}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-0">
              <CalendarPicker
                mode="range"
                selected={dateRange}
                onSelect={setDateRange}
                numberOfMonths={2}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
              <div className="flex items-center justify-between border-t px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDateRange(undefined)}
                  disabled={!dateRange?.from}
                >
                  Clear
                </Button>
                <Button size="sm" onClick={() => setDatePickerOpen(false)}>
                  Apply
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          <Button size="sm" className="h-10 rounded-xl gap-2" onClick={handleExport}>
            <Download className="h-4 w-4" /> Export
          </Button>

          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className={cn(
                  "h-10 w-10 rounded-xl relative",
                  activeCategories.size !== ALL_CATEGORIES.length && "border-primary/40 text-primary",
                )}
              >
                <SlidersHorizontal className="h-4 w-4" />
                {activeCategories.size !== ALL_CATEGORIES.length && (
                  <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-primary" />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 p-3">
              <div className="text-sm font-semibold mb-2">Filter by category</div>
              <div className="space-y-2">
                {ALL_CATEGORIES.map((cat) => (
                  <Label
                    key={cat}
                    className="flex items-center gap-2 text-sm font-normal cursor-pointer"
                  >
                    <Checkbox
                      checked={activeCategories.has(cat)}
                      onCheckedChange={() => toggleCategory(cat)}
                    />
                    {cat}
                  </Label>
                ))}
              </div>
              <div className="flex items-center justify-between mt-3 pt-3 border-t">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setActiveCategories(new Set(ALL_CATEGORIES))}
                >
                  Reset
                </Button>
                <Button size="sm" onClick={() => setFilterOpen(false)}>
                  Done
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </section>

      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Filters:</span>
          {search && (
            <Badge variant="secondary" className="rounded-full gap-1">
              Search: {search}
              <button onClick={() => setSearch("")} aria-label="Clear search">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {dateRange?.from && (
            <Badge variant="secondary" className="rounded-full gap-1">
              {dateLabel}
              <button onClick={() => setDateRange(undefined)} aria-label="Clear date">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {activeCategories.size !== ALL_CATEGORIES.length &&
            [...activeCategories].map((c) => (
              <Badge key={c} variant="secondary" className="rounded-full gap-1">
                {c}
                <button onClick={() => toggleCategory(c)} aria-label={`Remove ${c}`}>
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={clearFilters}>
            Clear all
          </Button>
        </div>
      )}

      {/* KPI row: promo + 3 stats */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <PromoCard />
        <StatCard
          label="Connected Stores"
          value={String(storeCount)}
          delta="+0.00%"
          deltaPositive
          subtitle="WooCommerce active"
        />
        <StatCard
          label="Orders Today"
          value="—"
          delta="0.00%"
          deltaPositive
          subtitle="Live from your stores"
        />
        <StatCard
          label="Total Items"
          value="—"
          delta="0.00%"
          deltaPositive={false}
          subtitle="Across warehouses"
        />
      </section>

      {/* Two large cards + schedule-style sidebar */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <PanelCard title="Workspace" right={<span className="text-xs text-muted-foreground">Quick access</span>}>
          {visibleTools.length === 0 ? (
            <EmptyState message="No tools match your filters." onReset={clearFilters} />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {visibleTools.slice(0, 6).map((t) => (
                <Link
                  key={t.to}
                  to={t.to}
                  className="group flex flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4 hover:border-primary/40 hover:shadow-md transition"
                >
                  <div className="h-10 w-10 rounded-xl bg-accent text-accent-foreground flex items-center justify-center">
                    <t.icon className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground font-semibold">
                      {t.caption}
                    </div>
                    <div className="text-sm font-semibold mt-0.5">{t.label}</div>
                  </div>
                  <ArrowUpRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition self-end" />
                </Link>
              ))}
            </div>
          )}
        </PanelCard>

        <PanelCard
          title="Activity"
          right={
            <Badge variant="secondary" className="rounded-full text-[10px]">
              {dateRange?.from ? dateLabel : "Last Year"}
            </Badge>
          }
        >
          <div className="h-48 rounded-xl bg-gradient-to-b from-accent/40 to-transparent border border-dashed border-border flex items-end p-4 gap-1.5">
            {activityBars.map((h, i) => (
              <div
                key={i}
                className="flex-1 rounded-md bg-primary/70 hover:bg-primary transition"
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {dateRange?.from
                ? `Showing ${activityBars.length} day${activityBars.length === 1 ? "" : "s"}`
                : "Connect a store to see live activity"}
            </span>
            <Link to="/integrations" className="text-primary font-medium hover:underline">
              Connect →
            </Link>
          </div>
        </PanelCard>

        <PanelCard
          title="Schedule"
          right={
            <Link to="/orders" className="text-xs text-primary font-medium hover:underline">
              See All
            </Link>
          }
        >
          <div className="space-y-3">
            <ScheduleItem tag="Orders" tagColor="bg-brand-violet-soft text-primary" title="Process new orders" time="Updated continuously" />
            <ScheduleItem tag="Shipping" tagColor="bg-brand-emerald-soft text-brand-emerald" title="Generate Royal Mail labels" time="On demand" />
            <ScheduleItem tag="Inventory" tagColor="bg-brand-amber-soft text-brand-amber" title="Review low-stock SKUs" time="Daily" />
          </div>
        </PanelCard>
      </section>

      {/* Stores strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {visibleSites && visibleSites.length > 0 ? (
          visibleSites.slice(0, 4).map((s) => (
            <StoreCard key={s.id} name={s.name} />
          ))
        ) : (
          <Card className="lg:col-span-4 border-dashed">
            <CardContent className="p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-accent text-accent-foreground flex items-center justify-center">
                  <Store className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-sm font-semibold">
                    {sites && sites.length > 0 && search
                      ? "No stores match your search"
                      : "No stores connected yet"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {sites && sites.length > 0 && search
                      ? "Try a different keyword."
                      : "Hook up your first WooCommerce store to start syncing orders."}
                  </div>
                </div>
              </div>
              <Button asChild size="sm" className="rounded-xl">
                <Link to="/integrations">Connect a store</Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </section>

      {/* Tools list (Product List style) */}
      <PanelCard
        title="All Tools"
        right={
          <Badge variant="secondary" className="rounded-full text-[10px] gap-1">
            <Sparkles className="h-3 w-3" /> {visibleTools.length} available
          </Badge>
        }
      >
        {visibleTools.length === 0 ? (
          <EmptyState message="No tools match your filters." onReset={clearFilters} />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/70">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-muted-foreground">
                <tr className="text-left text-xs uppercase tracking-[0.12em]">
                  <th className="px-4 py-3 font-semibold">Tool</th>
                  <th className="px-4 py-3 font-semibold hidden sm:table-cell">Category</th>
                  <th className="px-4 py-3 font-semibold hidden md:table-cell">Status</th>
                  <th className="px-4 py-3 font-semibold text-right">Open</th>
                </tr>
              </thead>
              <tbody>
                {visibleTools.map((t, i) => (
                  <tr
                    key={t.to}
                    className={`border-t border-border/60 hover:bg-muted/40 transition ${i % 2 === 1 ? "bg-muted/20" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-lg bg-accent text-accent-foreground flex items-center justify-center">
                          <t.icon className="h-4 w-4" />
                        </div>
                        <div className="font-medium">{t.label}</div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{t.category}</td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <span className="h-1.5 w-1.5 rounded-full bg-brand-emerald" />
                        Active
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to={t.to}
                        className="inline-flex items-center gap-1 text-primary text-xs font-semibold hover:underline"
                      >
                        Open <ChevronRight className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PanelCard>
    </div>
  );
}

/* ---------------- Sub-components ---------------- */

function EmptyState({ message, onReset }: { message: string; onReset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-8 gap-2">
      <div className="text-sm text-muted-foreground">{message}</div>
      <Button variant="outline" size="sm" onClick={onReset}>
        Clear filters
      </Button>
    </div>
  );
}

function PromoCard() {
  return (
    <Link
      to="/integrations"
      className="group relative overflow-hidden rounded-2xl bg-primary text-primary-foreground p-5 flex flex-col justify-between min-h-[140px] hover:shadow-lg transition"
    >
      <div className="absolute -right-6 -bottom-6 h-32 w-32 rounded-full bg-primary-foreground/10" />
      <div className="absolute -right-2 -top-2 h-16 w-16 rounded-full bg-primary-foreground/10" />
      <div className="relative">
        <div className="text-sm font-semibold leading-tight">Sharpen your ops with Ultrax Pro</div>
        <div className="text-xs opacity-80 mt-1">Connect more channels & unlock bulk tools</div>
      </div>
      <div className="relative">
        <span className="inline-flex items-center gap-1 rounded-full bg-primary-foreground text-primary px-3 py-1.5 text-xs font-semibold">
          Connect now <ArrowUpRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </Link>
  );
}

function StatCard({
  label, value, delta, deltaPositive, subtitle,
}: { label: string; value: string; delta: string; deltaPositive: boolean; subtitle: string }) {
  return (
    <Card className="border border-border/70">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="text-xs text-muted-foreground">{label}</div>
          <Badge
            variant="secondary"
            className={`rounded-full text-[10px] gap-1 ${
              deltaPositive
                ? "bg-brand-emerald-soft text-brand-emerald"
                : "bg-brand-rose-soft text-brand-rose"
            }`}
          >
            {deltaPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {delta}
          </Badge>
        </div>
        <div className="mt-3 text-2xl md:text-3xl font-bold tracking-tight tabular-nums">
          {value}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{subtitle}</div>
      </CardContent>
    </Card>
  );
}

function PanelCard({
  title, right, children,
}: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="border border-border/70">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">{title}</div>
          {right}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function ScheduleItem({
  tag, tagColor, title, time,
}: { tag: string; tagColor: string; title: string; time: string }) {
  return (
    <div className="rounded-xl border border-border/70 p-3 hover:bg-muted/40 transition">
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${tagColor}`}>
        {tag}
      </span>
      <div className="mt-2 text-sm font-semibold">{title}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{time}</div>
    </div>
  );
}

function StoreCard({ name }: { name: string }) {
  return (
    <Link
      to="/integrations"
      className="group block rounded-2xl border border-border/70 bg-card p-4 hover:border-primary/40 hover:shadow-md transition"
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold truncate">{name}</div>
        <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition" />
      </div>
      <div className="text-xs text-muted-foreground mt-1">Performance Active</div>
      <div className="mt-3 flex items-center gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-7 w-7 rounded-full border-2 border-card bg-accent text-accent-foreground text-[10px] font-semibold flex items-center justify-center"
            style={{ marginLeft: i === 0 ? 0 : -8 }}
          >
            {String.fromCharCode(65 + i)}
          </div>
        ))}
        <span className="ml-2 text-xs text-muted-foreground">team</span>
      </div>
    </Link>
  );
}
