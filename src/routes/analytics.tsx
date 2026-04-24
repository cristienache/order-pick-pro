import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useCallback } from "react";
import { format, subDays, startOfMonth, startOfQuarter, startOfYear, differenceInDays } from "date-fns";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  PieChart, Pie, Cell, BarChart, Bar, ResponsiveContainer, Legend,
} from "recharts";
import {
  TrendingUp, TrendingDown, Calendar as CalIcon, Download,
  Store as StoreIcon, AlertTriangle, RefreshCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DateRange } from "react-day-picker";
import { api, type Site } from "@/lib/api";
import {
  getOverview, getRevenue, getTopProducts, getOrdersStats,
  getCustomers, getCoupons,
  type Overview, type RevenueResponse, type TopProduct,
  type OrdersStats, type CustomersStats, type CouponItem, type AnalyticsWarning,
} from "@/lib/analytics-api";

export const Route = createFileRoute("/analytics")({
  component: () => (
    <RequireAuth>
      <AppShell>
        <AnalyticsPage />
      </AppShell>
    </RequireAuth>
  ),
  head: () => ({
    meta: [
      { title: "Analytics — Ultrax" },
      { name: "description", content: "Reports & analytics for the WooCommerce store you operate." },
    ],
  }),
});

type Interval = "day" | "week" | "month";
type Compare = "none" | "previous_period" | "previous_year";
type Preset = "today" | "7d" | "30d" | "mtd" | "qtd" | "ytd" | "custom";

const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "mtd", label: "Month to date" },
  { id: "qtd", label: "Quarter to date" },
  { id: "ytd", label: "Year to date" },
];

function presetRange(p: Preset): DateRange {
  const now = new Date();
  switch (p) {
    case "today": return { from: now, to: now };
    case "7d": return { from: subDays(now, 6), to: now };
    case "30d": return { from: subDays(now, 29), to: now };
    case "mtd": return { from: startOfMonth(now), to: now };
    case "qtd": return { from: startOfQuarter(now), to: now };
    case "ytd": return { from: startOfYear(now), to: now };
    default: return { from: subDays(now, 29), to: now };
  }
}

function fmtDay(d: Date) { return format(d, "yyyy-MM-dd"); }

function gbp(v: number) {
  if (!Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(v);
}

function num(v: number) {
  if (!Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-GB").format(v);
}

function pctDelta(curr: number, prev?: number): { v: number; positive: boolean } | null {
  if (prev === undefined || prev === null) return null;
  if (prev === 0) return curr > 0 ? { v: 100, positive: true } : null;
  const delta = ((curr - prev) / prev) * 100;
  return { v: Math.abs(delta), positive: delta >= 0 };
}

const CHART_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--brand-emerald, 158 64% 52%))",
  "hsl(var(--brand-amber, 38 92% 50%))",
  "hsl(var(--brand-rose, 350 89% 60%))",
  "hsl(var(--brand-violet, 262 83% 58%))",
  "hsl(var(--muted-foreground))",
];

const STATUS_COLORS: Record<string, string> = {
  processing: CHART_COLORS[0],
  completed: CHART_COLORS[1],
  "on-hold": CHART_COLORS[2],
  refunded: CHART_COLORS[3],
  cancelled: CHART_COLORS[5],
  failed: CHART_COLORS[4],
};

function AnalyticsPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = useState(true);
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const [preset, setPreset] = useState<Preset>("30d");
  // Initialize range on the client only to avoid SSR hydration drift from new Date().
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [compare, setCompare] = useState<Compare>("previous_period");
  const [intervalChoice, setIntervalChoice] = useState<Interval>("day");

  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [revenue, setRevenue] = useState<RevenueResponse | null>(null);
  const [revenueLoading, setRevenueLoading] = useState(false);

  const [products, setProducts] = useState<TopProduct[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);

  const [orderStats, setOrderStats] = useState<OrdersStats | null>(null);
  const [orderStatsLoading, setOrderStatsLoading] = useState(false);

  const [customers, setCustomers] = useState<CustomersStats | null>(null);
  const [customersLoading, setCustomersLoading] = useState(false);

  const [coupons, setCoupons] = useState<CouponItem[]>([]);
  const [couponsLoading, setCouponsLoading] = useState(false);

  // Initialize range on the client only (avoids SSR/CSR `new Date()` drift).
  useEffect(() => { setRange(presetRange("30d")); }, []);

  // Load sites on mount; auto-select the first one.
  useEffect(() => {
    setSitesLoading(true);
    api<{ sites: Site[] }>("/api/sites")
      .then((r) => {
        setSites(r.sites || []);
        if (r.sites && r.sites.length > 0) {
          setSelectedSiteId(r.sites[0].id);
        }
      })
      .catch(() => setSites([]))
      .finally(() => setSitesLoading(false));
  }, []);

  const params = useMemo(() => {
    if (!range?.from || !selectedSiteId) return null;
    return {
      from: fmtDay(range.from),
      to: fmtDay(range.to || range.from),
      site_ids: [selectedSiteId],
    };
  }, [range, selectedSiteId]);

  const fetchAll = useCallback(() => {
    if (!params) return;
    setOverviewLoading(true); setOverviewError(null);
    setRevenueLoading(true); setProductsLoading(true);
    setOrderStatsLoading(true); setCustomersLoading(true); setCouponsLoading(true);

    getOverview({ ...params, compare: compare === "none" ? undefined : compare })
      .then(setOverview)
      .catch((e) => { setOverview(null); setOverviewError(e.message || "Failed to load overview"); })
      .finally(() => setOverviewLoading(false));

    getRevenue({ ...params, interval: intervalChoice })
      .then(setRevenue)
      .catch(() => setRevenue(null))
      .finally(() => setRevenueLoading(false));

    getTopProducts({ ...params, limit: 10 })
      .then((r) => setProducts(r.products || []))
      .catch(() => setProducts([]))
      .finally(() => setProductsLoading(false));

    getOrdersStats(params)
      .then(setOrderStats)
      .catch(() => setOrderStats(null))
      .finally(() => setOrderStatsLoading(false));

    getCustomers(params)
      .then(setCustomers)
      .catch(() => setCustomers(null))
      .finally(() => setCustomersLoading(false));

    getCoupons({ ...params, limit: 10 })
      .then((r) => setCoupons(r.coupons || []))
      .catch(() => setCoupons([]))
      .finally(() => setCouponsLoading(false));
  }, [params, compare, intervalChoice]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  function applyPreset(p: Preset) {
    setPreset(p);
    if (p !== "custom") setRange(presetRange(p));
  }

  function exportCsv() {
    const rows: string[] = [];
    rows.push("Section,Key,Value");
    if (overview) {
      const t = overview.totals;
      rows.push(`Overview,Revenue (GBP),${(t.revenue_gbp || 0).toFixed(2)}`);
      rows.push(`Overview,Orders,${t.orders || 0}`);
      rows.push(`Overview,Items sold,${t.items_sold || 0}`);
      rows.push(`Overview,Avg order value (GBP),${(t.avg_order_value_gbp || 0).toFixed(2)}`);
      rows.push(`Overview,New customers,${t.new_customers || 0}`);
      rows.push(`Overview,Refunds (GBP),${(t.refunds_gbp || 0).toFixed(2)}`);
    }
    rows.push("");
    rows.push("Top Products,Name,Items sold,Net revenue (GBP),Store");
    products.forEach((p) => rows.push(`,${JSON.stringify(p.name)},${p.items_sold},${(p.net_revenue_gbp || 0).toFixed(2)},${JSON.stringify(p.site_name)}`));
    rows.push("");
    rows.push("Revenue,Date,Revenue,Orders,Items");
    revenue?.combined?.forEach((p) => rows.push(`,${p.date},${(p.revenue || 0).toFixed(2)},${p.orders},${p.items}`));

    if (typeof window === "undefined") return;
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ultrax-analytics-${format(new Date(), "yyyy-MM-dd")}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const dateLabel = useMemo(() => {
    if (!range?.from) return "Pick a range";
    if (range.to && range.to.getTime() !== range.from.getTime()) {
      return `${format(range.from, "MMM d")} – ${format(range.to, "MMM d, yyyy")}`;
    }
    return format(range.from, "MMM d, yyyy");
  }, [range]);

  const days = range?.from && range?.to ? differenceInDays(range.to, range.from) + 1 : 1;

  const allWarnings: AnalyticsWarning[] = useMemo(() => {
    const out: AnalyticsWarning[] = [];
    overview?.warnings?.forEach((w) => out.push(w));
    revenue?.warnings?.forEach((w) => out.push(w));
    orderStats?.warnings?.forEach((w) => out.push(w));
    customers?.warnings?.forEach((w) => out.push(w));
    return out;
  }, [overview, revenue, orderStats, customers]);

  const selectedSite = sites.find((s) => s.id === selectedSiteId) || null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <section className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Reports & insights from WooCommerce.{" "}
            {selectedSite ? <>Viewing <strong>{selectedSite.name}</strong>.</> : "Select a store to begin."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Single-store selector */}
          <Select
            value={selectedSiteId ? String(selectedSiteId) : ""}
            onValueChange={(v) => setSelectedSiteId(Number(v) || null)}
            disabled={sitesLoading || sites.length === 0}
          >
            <SelectTrigger className="h-10 min-w-[180px] rounded-xl">
              <div className="flex items-center gap-2 truncate">
                <StoreIcon className="h-4 w-4 shrink-0" />
                <SelectValue placeholder={sitesLoading ? "Loading…" : "Select store"} />
              </div>
            </SelectTrigger>
            <SelectContent>
              {sites.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
              ))}
              {sites.length === 0 && !sitesLoading && (
                <div className="px-3 py-2 text-xs text-muted-foreground">No stores connected</div>
              )}
            </SelectContent>
          </Select>

          <Select value={preset} onValueChange={(v) => applyPreset(v as Preset)}>
            <SelectTrigger className="h-10 w-40 rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
              ))}
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>

          <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-10 rounded-xl gap-2">
                <CalIcon className="h-4 w-4" /> {dateLabel}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-0">
              <CalendarPicker
                mode="range"
                selected={range}
                onSelect={(r) => { if (r) { setRange(r); setPreset("custom"); } }}
                numberOfMonths={2}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
              <div className="flex items-center justify-end border-t px-3 py-2">
                <Button size="sm" onClick={() => setDatePickerOpen(false)}>Apply</Button>
              </div>
            </PopoverContent>
          </Popover>

          <Select value={compare} onValueChange={(v) => setCompare(v as Compare)}>
            <SelectTrigger className="h-10 w-44 rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No comparison</SelectItem>
              <SelectItem value="previous_period">vs previous period</SelectItem>
              <SelectItem value="previous_year">vs previous year</SelectItem>
            </SelectContent>
          </Select>

          <Button variant="outline" size="icon" className="h-10 w-10 rounded-xl" onClick={fetchAll} aria-label="Refresh">
            <RefreshCcw className="h-4 w-4" />
          </Button>
          <Button size="sm" className="h-10 rounded-xl gap-2" onClick={exportCsv}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
        </div>
      </section>

      {/* Warnings */}
      {allWarnings.length > 0 && (
        <Card className="border-brand-amber/40 bg-brand-amber-soft/40">
          <CardContent className="p-3 flex flex-wrap items-center gap-2 text-xs">
            <AlertTriangle className="h-4 w-4 text-brand-amber" />
            <span className="font-medium">Limited analytics:</span>
            {Array.from(new Set(allWarnings.map((w) => w.error))).slice(0, 3).map((e, i) => (
              <Badge key={i} variant="secondary" className="rounded-full font-normal">{e}</Badge>
            ))}
            <span className="text-muted-foreground ml-auto">
              Falling back to direct order scan — first load can take a moment.
            </span>
          </CardContent>
        </Card>
      )}

      {/* No stores */}
      {!sitesLoading && sites.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-8 text-center space-y-3">
            <StoreIcon className="h-10 w-10 mx-auto text-muted-foreground" />
            <div className="font-semibold">No stores connected</div>
            <div className="text-sm text-muted-foreground">Connect a WooCommerce store to see analytics.</div>
            <Button asChild size="sm" className="rounded-xl">
              <Link to="/integrations">Connect a store</Link>
            </Button>
          </CardContent>
        </Card>
      ) : !selectedSiteId ? (
        <Card className="border-dashed">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Select a store from the dropdown to view its analytics.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* KPI strip */}
          <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <KpiCard
              label="Revenue"
              value={overview ? gbp(overview.totals.revenue_gbp) : "—"}
              delta={overview ? pctDelta(overview.totals.revenue_gbp, overview.previous?.revenue_gbp) : null}
              loading={overviewLoading}
            />
            <KpiCard
              label="Orders"
              value={overview ? num(overview.totals.orders) : "—"}
              delta={overview ? pctDelta(overview.totals.orders, overview.previous?.orders) : null}
              loading={overviewLoading}
            />
            <KpiCard
              label="Avg order value"
              value={overview ? gbp(overview.totals.avg_order_value_gbp) : "—"}
              delta={overview ? pctDelta(overview.totals.avg_order_value_gbp, overview.previous?.avg_order_value_gbp) : null}
              loading={overviewLoading}
            />
            <KpiCard
              label="Items sold"
              value={overview ? num(overview.totals.items_sold) : "—"}
              delta={overview ? pctDelta(overview.totals.items_sold, overview.previous?.items_sold) : null}
              loading={overviewLoading}
            />
            <KpiCard
              label="New customers"
              value={overview ? num(overview.totals.new_customers) : "—"}
              delta={overview ? pctDelta(overview.totals.new_customers, overview.previous?.new_customers) : null}
              loading={overviewLoading}
            />
            <KpiCard
              label="Refunds"
              value={overview ? gbp(overview.totals.refunds_gbp) : "—"}
              delta={overview ? pctDelta(overview.totals.refunds_gbp, overview.previous?.refunds_gbp) : null}
              loading={overviewLoading}
              invertDelta
            />
          </section>

          {overviewError && (
            <Card className="border-destructive/50 bg-destructive/5">
              <CardContent className="p-4 text-sm text-destructive">{overviewError}</CardContent>
            </Card>
          )}

          {/* Revenue + Status */}
          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <PanelCard
              title="Revenue over time"
              right={
                <Tabs value={intervalChoice} onValueChange={(v) => setIntervalChoice(v as Interval)}>
                  <TabsList className="h-8">
                    <TabsTrigger value="day" className="text-xs h-6">Day</TabsTrigger>
                    <TabsTrigger value="week" className="text-xs h-6">Week</TabsTrigger>
                    <TabsTrigger value="month" className="text-xs h-6">Month</TabsTrigger>
                  </TabsList>
                </Tabs>
              }
              className="lg:col-span-2"
            >
              {revenueLoading ? (
                <Skeleton className="h-64 w-full" />
              ) : (
                <RevenueChart data={revenue?.combined || []} />
              )}
              <div className="mt-2 text-xs text-muted-foreground">
                {days} {days === 1 ? "day" : "days"} · {revenue?.combined?.length ?? 0} data points
              </div>
            </PanelCard>

            <PanelCard title="Orders by status" right={null}>
              {orderStatsLoading ? (
                <Skeleton className="h-64 w-full" />
              ) : (
                <OrderStatusChart byStatus={orderStats?.by_status || {}} />
              )}
            </PanelCard>
          </section>

          {/* Top products + Customers */}
          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <PanelCard title="Top products" right={<Badge variant="secondary" className="text-[10px] rounded-full">Top {products.length}</Badge>} className="lg:col-span-2">
              {productsLoading ? (
                <Skeleton className="h-64 w-full" />
              ) : products.length === 0 ? (
                <EmptyMsg msg="No product data for this period." />
              ) : (
                <div className="overflow-hidden rounded-xl border border-border/70">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/60 text-muted-foreground">
                      <tr className="text-left text-xs uppercase tracking-[0.12em]">
                        <th className="px-3 py-2.5 font-semibold">#</th>
                        <th className="px-3 py-2.5 font-semibold">Product</th>
                        <th className="px-3 py-2.5 font-semibold text-right">Sold</th>
                        <th className="px-3 py-2.5 font-semibold text-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {products.map((p, i) => (
                        <tr key={`${p.site_id}-${p.product_id}`} className={`border-t border-border/60 ${i % 2 === 1 ? "bg-muted/20" : ""}`}>
                          <td className="px-3 py-2.5 text-muted-foreground tabular-nums">{i + 1}</td>
                          <td className="px-3 py-2.5 font-medium truncate max-w-xs">{p.name}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{num(p.items_sold)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{gbp(p.net_revenue_gbp)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </PanelCard>

            <PanelCard title="Customers" right={null}>
              {customersLoading ? (
                <Skeleton className="h-64 w-full" />
              ) : customers ? (
                <CustomersChart data={customers} />
              ) : (
                <EmptyMsg msg="No customer data." />
              )}
            </PanelCard>
          </section>

          {/* Coupons */}
          <section className="grid grid-cols-1 gap-4">
            <PanelCard title="Top coupons" right={null}>
              {couponsLoading ? (
                <Skeleton className="h-48 w-full" />
              ) : coupons.length === 0 ? (
                <EmptyMsg msg="No coupons used in this period." />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {coupons.map((c) => (
                    <div key={`${c.site_name}-${c.coupon_id}`} className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2">
                      <div>
                        <div className="text-sm font-semibold">{c.code}</div>
                        <div className="text-xs text-muted-foreground">{num(c.orders_count)} orders</div>
                      </div>
                      <div className="text-sm tabular-nums font-semibold">{gbp(c.amount_gbp)}</div>
                    </div>
                  ))}
                </div>
              )}
            </PanelCard>
          </section>
        </>
      )}
    </div>
  );
}

/* ---------------- Sub-components ---------------- */

function KpiCard({
  label, value, delta, loading, invertDelta,
}: {
  label: string; value: string;
  delta: { v: number; positive: boolean } | null;
  loading: boolean; invertDelta?: boolean;
}) {
  const showPositive = delta ? (invertDelta ? !delta.positive : delta.positive) : true;
  return (
    <Card className="border border-border/70">
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="text-xs text-muted-foreground">{label}</div>
          {delta && (
            <Badge
              variant="secondary"
              className={cn(
                "rounded-full text-[10px] gap-1",
                showPositive ? "bg-brand-emerald-soft text-brand-emerald" : "bg-brand-rose-soft text-brand-rose",
              )}
            >
              {showPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {delta.v.toFixed(1)}%
            </Badge>
          )}
        </div>
        <div className="mt-3 text-xl md:text-2xl font-bold tracking-tight tabular-nums">
          {loading ? <Skeleton className="h-7 w-20" /> : value}
        </div>
      </CardContent>
    </Card>
  );
}

function PanelCard({
  title, right, children, className,
}: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("border border-border/70", className)}>
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

function EmptyMsg({ msg }: { msg: string }) {
  return <div className="text-sm text-muted-foreground text-center py-8">{msg}</div>;
}

function RevenueChart({ data }: { data: Array<{ date: string; revenue: number; orders: number }> }) {
  if (!data || data.length === 0) return <EmptyMsg msg="No revenue data." />;
  return (
    <ChartContainer
      config={{ revenue: { label: "Revenue", color: "hsl(var(--primary))" } }}
      className="h-64 w-full"
    >
      <AreaChart data={data}>
        <defs>
          <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/40" />
        <XAxis
          dataKey="date"
          tickFormatter={(v) => {
            try { return format(new Date(v), "MMM d"); } catch { return v; }
          }}
          className="text-xs"
          tick={{ fill: "hsl(var(--muted-foreground))" }}
        />
        <YAxis
          tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)}
          className="text-xs"
          tick={{ fill: "hsl(var(--muted-foreground))" }}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Area
          type="monotone"
          dataKey="revenue"
          stroke="hsl(var(--primary))"
          fill="url(#revGrad)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  );
}

function OrderStatusChart({ byStatus }: { byStatus: Record<string, number> }) {
  const data = Object.entries(byStatus || {})
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({ name: k, value: v }));
  if (data.length === 0) return <EmptyMsg msg="No orders in this period." />;
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" innerRadius={45} outerRadius={75} paddingAngle={2}>
            {data.map((entry) => (
              <Cell key={entry.name} fill={STATUS_COLORS[entry.name] || CHART_COLORS[0]} />
            ))}
          </Pie>
          <Legend
            iconSize={8}
            wrapperStyle={{ fontSize: "11px" }}
            formatter={(value, _entry, i) => `${value} (${data[i]?.value || 0})`}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function CustomersChart({ data }: { data: CustomersStats }) {
  const chartData = [
    { name: "New", value: data.new_customers || 0 },
    { name: "Returning", value: data.returning_customers || 0 },
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-center">
        <div className="rounded-lg bg-muted/50 p-3">
          <div className="text-xs text-muted-foreground">Total</div>
          <div className="text-xl font-bold tabular-nums">{num(data.total_customers || 0)}</div>
        </div>
        <div className="rounded-lg bg-muted/50 p-3">
          <div className="text-xs text-muted-foreground">New</div>
          <div className="text-xl font-bold tabular-nums">{num(data.new_customers || 0)}</div>
        </div>
      </div>
      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/40" />
            <XAxis dataKey="name" className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))" }} />
            <YAxis className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))" }} />
            <Bar dataKey="value" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
