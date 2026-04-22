import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiBlob, fetchTodayStats, markShipmentsPrinted, type RmShipment, type Site, type TodayStats } from "@/lib/api";
import {
  ALL_STATUSES, isAging, isEuropeOrder, isExpedited, isHighValue, isRepeat,
  withinDateRange, type DatePreset, type Format, type OrderRow,
} from "@/lib/orders";
import { playChime } from "@/lib/chime";
import { printPdfBlob } from "@/lib/print-pdf";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { PriorityBadges } from "@/components/priority-badges";
import { FilterPresets, type PresetPayload } from "@/components/filter-presets";
import { OrderDetailDrawer } from "@/components/order-detail-drawer";
import { BulkRoyalMailDialog, type BulkSelection } from "@/components/bulk-royal-mail-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2, Download, RefreshCw, Package, Store, MoreHorizontal,
  CheckCircle2, MessageSquarePlus, Filter, Calendar as CalendarIcon, Bell, BellOff, ChevronDown,
  Truck, Printer,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/orders")({
  component: () => <RequireAuth><AppShell><PicklistPage /></AppShell></RequireAuth>,
  head: () => ({
    meta: [
      { title: "Orders | Ultrax" },
      { name: "description", content: "Pick, pack and ship WooCommerce orders across all your stores." },
    ],
  }),
});

const FORMATS: { value: Format; label: string; hint: string }[] = [
  { value: "picking_a4", label: "Picking slip (A4)", hint: "Warehouse \u2014 SKUs + attributes" },
  { value: "packing_a4", label: "Packing slip (A4)", hint: "Customer-facing \u2014 no SKUs" },
  { value: "packing_4x6", label: "Packing label (4\u00d76\")", hint: "Thermal label, one per order" },
  { value: "shipping_4x6", label: "Shipping label (4\u00d76\")", hint: "Royal Mail size \u2014 thermal" },
  { value: "shipping_a6", label: "Address labels (21 per A4)", hint: "60\u00d740 mm \u2014 3\u00d77 grid" },
];

const HIGH_VALUE_KEY = "ultrax_hv_threshold";
const NOTIFY_KEY = "ultrax_notify";
const POLL_NEW_MS = 60_000;
const AUTO_REFRESH_MS = 20 * 60_000;

function PicklistPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [loadingSites, setLoadingSites] = useState(true);
  
  const [format, setFormat] = useState<Format>("picking_a4");
  const [activeSites, setActiveSites] = useState<number[]>([]);
  const [statuses, setStatuses] = useState<string[]>(["processing"]);
  const [computeRepeat, setComputeRepeat] = useState(false);
  const [ordersBySite, setOrdersBySite] = useState<Record<number, OrderRow[]>>({});
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [selected, setSelected] = useState<Record<number, Set<number>>>({});
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<"recent" | "oldest">("recent");
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [generating, setGenerating] = useState(false);

  // High-value threshold (persisted)
  const [highValueThreshold, setHighValueThreshold] = useState<number>(() => {
    if (typeof window === "undefined") return 100;
    const v = Number(localStorage.getItem(HIGH_VALUE_KEY));
    return Number.isFinite(v) && v > 0 ? v : 100;
  });
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(HIGH_VALUE_KEY, String(highValueThreshold));
  }, [highValueThreshold]);

  // Notifications enabled? (persisted)
  const [notify, setNotify] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem(NOTIFY_KEY) !== "0";
  });
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(NOTIFY_KEY, notify ? "1" : "0");
  }, [notify]);

  // Bulk-action dialog state
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteCustomerEmail, setNoteCustomerEmail] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  // Bulk Royal Mail dialog state. mode === null means closed; selections are
  // snapshotted on open so a click on the dropdown freezes the working set.
  const [rmBulkMode, setRmBulkMode] = useState<"create" | "print" | null>(null);
  const [rmBulkSelections, setRmBulkSelections] = useState<BulkSelection[]>([]);

  // Map of `${siteId}:${orderId}` -> existing shipment, used to render the
  // "Printed" / "Label" badges in the row and power the unprinted filter.
  const [shipmentsByOrder, setShipmentsByOrder] = useState<Record<string, RmShipment>>({});
  // When true, the table only shows orders that have a shipping label which
  // hasn't been printed yet. Pairs with the toolbar "Print unprinted" button.
  const [showOnlyUnprinted, setShowOnlyUnprinted] = useState(false);
  // Busy state for the toolbar "Print unprinted labels" CTA.
  const [printingUnprinted, setPrintingUnprinted] = useState(false);

  // Auto-refresh + polling timestamps
  const lastSeenIdsRef = useRef<Set<number>>(new Set());
  // Tracks whether the new-order poll has done its initial silent seed for the
  // current activeSites set. Without this, the very first poll (or any poll
  // after activeSites changes) treats every processing order returned by the
  // server — including historical ones outside the user's date filter — as
  // "new" and chimes for them on every cycle.
  const pollSeededRef = useRef<string>("");

  // Order detail drawer state (siteId + orderId, both null = closed)
  const [drawerSiteId, setDrawerSiteId] = useState<number | null>(null);
  const [drawerOrderId, setDrawerOrderId] = useState<number | null>(null);
  const openOrder = (sid: number, oid: number) => {
    setDrawerSiteId(sid);
    setDrawerOrderId(oid);
  };
  const closeDrawer = (open: boolean) => {
    if (!open) { setDrawerSiteId(null); setDrawerOrderId(null); }
  };

  // FX rates (GBP base). Rates are "1 GBP = N <code>" -> divide to convert.
  const [fxRates, setFxRates] = useState<Record<string, number>>({ GBP: 1 });
  useEffect(() => {
    api<{ rates: Record<string, number> }>("/api/fx")
      .then((r) => setFxRates({ GBP: 1, ...r.rates }))
      .catch(() => { /* fallback handled server-side; ignore here */ });
  }, []);
  const toGbp = useCallback((amount: number, currency: string): number | null => {
    const code = (currency || "GBP").toUpperCase();
    if (code === "GBP") return amount;
    const r = fxRates[code];
    if (!r || !Number.isFinite(r) || r <= 0) return null;
    return amount / r;
  }, [fxRates]);

  // Today's stats — count + revenue across processing AND completed orders
  // for every site. Decoupled from the in-view rows so the user can filter
  // to "processing only" without hiding completed-today revenue.
  const [todayStats, setTodayStats] = useState<TodayStats | null>(null);
  const refreshTodayStats = useCallback(() => {
    fetchTodayStats()
      .then(setTodayStats)
      .catch(() => { /* silent — stats are best-effort */ });
  }, []);
  useEffect(() => { refreshTodayStats(); }, [refreshTodayStats]);

  useEffect(() => {
    api<{ sites: Site[] }>("/api/sites")
      .then((r) => {
        setSites(r.sites);
        if (r.sites.length > 0) setActiveSites(r.sites.map((s) => s.id));
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load sites"))
      .finally(() => setLoadingSites(false));
  }, []);

  // "All dates" is only allowed when the status filter includes "processing"
  // (and nothing heavy like completed). If the user changes the status set while
  // "all" is active, snap back to "today" so we don't pull the whole order history.
  const allowsAllDates =
    statuses.includes("processing") &&
    !statuses.some((s) => s === "completed" || s === "cancelled" || s === "refunded");
  useEffect(() => {
    if (allowsAllDates) setDatePreset("all");
    else if (datePreset === "all") setDatePreset("today");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowsAllDates]);

  const loadOrders = useCallback(async (silent = false, extraStatuses: string[] = []) => {
    if (activeSites.length === 0) return;
    setLoadingOrders(true);
    try {
      const results: Record<number, OrderRow[]> = {};
      const sel: Record<number, Set<number>> = {};
      const qs = new URLSearchParams();
      // Union the user's selected statuses with any extra ones the caller
      // wants temporarily included (e.g. "completed" right after a print, so
      // freshly-completed orders don't disappear from view).
      const mergedStatuses = Array.from(new Set([...statuses, ...extraStatuses]));
      qs.set("statuses", mergedStatuses.join(","));
      if (computeRepeat) qs.set("repeat", "1");

      // Push date bounds to the server so WooCommerce filters at the source.
      // Without this, "completed" pulls hundreds of historical orders even
      // when the user only wants today.
      const now = new Date();
      let afterIso: string | null = null;
      let beforeIso: string | null = null;
      if (datePreset === "today") {
        const start = new Date(); start.setHours(0, 0, 0, 0);
        afterIso = start.toISOString();
      } else if (datePreset === "24h") {
        afterIso = new Date(now.getTime() - 24 * 3600_000).toISOString();
      } else if (datePreset === "7d") {
        afterIso = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
      } else if (datePreset === "custom") {
        if (customFrom) afterIso = new Date(customFrom + "T00:00:00").toISOString();
        if (customTo) beforeIso = new Date(customTo + "T23:59:59").toISOString();
      }
      if (afterIso) qs.set("after", afterIso);
      if (beforeIso) qs.set("before", beforeIso);

      await Promise.all(activeSites.map(async (sid) => {
        const r = await api<{ orders: OrderRow[] }>(`/api/sites/${sid}/orders?${qs.toString()}`);
        results[sid] = r.orders;
        sel[sid] = new Set();
      }));
      setOrdersBySite(results);
      setSelected(sel);
      // seed lastSeen for new-order detection — union with any IDs the poll
      // has already discovered, so we don't wipe poll-tracked IDs each refresh.
      Object.values(results).forEach((arr) => arr.forEach((o) => lastSeenIdsRef.current.add(o.id)));
      if (!silent) {
        const total = Object.values(results).reduce((s, arr) => s + arr.length, 0);
        toast.success(`Loaded ${total} orders across ${activeSites.length} site(s)`);
      }
    } catch (e) {
      if (!silent) toast.error(e instanceof Error ? e.message : "Failed to load orders");
    } finally { setLoadingOrders(false); }
  }, [activeSites, statuses, computeRepeat, datePreset, customFrom, customTo]);

  // Initial load only — once sites are picked. Filter changes do NOT auto-fetch:
  // the user must press the Show button (avoids hammering WooCommerce on each toggle).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (activeSites.length === 0) return;
    loadOrders(true);
  }, [activeSites]);

  // 20-min silent auto-refresh
  useEffect(() => {
    if (activeSites.length === 0) return;
    const id = setInterval(() => loadOrders(true), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [activeSites, loadOrders]);

  // 60s new-order polling (lightweight: just IDs + count, processing only).
  // The first cycle after activeSites changes seeds the ref silently — we
  // never chime for orders that already existed before the user opened the
  // page, even if they fall outside the current date filter (loadOrders only
  // seeds what's in view, so historical processing orders would otherwise
  // ping every minute).
  useEffect(() => {
    if (activeSites.length === 0 || !notify) return;
    const seedKey = activeSites.slice().sort().join(",");
    const id = setInterval(async () => {
      try {
        const isFirstSeed = pollSeededRef.current !== seedKey;
        const allNew: { siteName: string; ids: number[] }[] = [];
        for (const sid of activeSites) {
          const r = await api<{ orders: OrderRow[] }>(`/api/sites/${sid}/orders?statuses=processing`);
          const newOnes = r.orders.filter((o) => !lastSeenIdsRef.current.has(o.id));
          // Always record what we've seen so they don't re-trigger.
          r.orders.forEach((o) => lastSeenIdsRef.current.add(o.id));
          if (newOnes.length > 0 && !isFirstSeed) {
            const site = sites.find((s) => s.id === sid);
            allNew.push({ siteName: site?.name || `Site ${sid}`, ids: newOnes.map((o) => o.id) });
          }
        }
        pollSeededRef.current = seedKey;
        const totalNew = allNew.reduce((s, x) => s + x.ids.length, 0);
        if (totalNew > 0) {
          playChime();
          const detail = allNew.map((g) => `${g.ids.length} on ${g.siteName}`).join(", ");
          toast.success(`${totalNew} new order${totalNew === 1 ? "" : "s"}`, {
            description: detail,
            action: { label: "Reload", onClick: () => loadOrders(false) },
          });
        }
      } catch { /* silent */ }
    }, POLL_NEW_MS);
    return () => clearInterval(id);
  }, [activeSites, sites, notify, loadOrders]);

  // Fetch existing Royal Mail shipments for the orders currently in view, so
  // we can decorate rows with a "Printed" badge and filter to the unprinted
  // set. Best-effort — silently no-ops if Royal Mail isn't configured or the
  // call fails. Re-runs whenever the loaded order set changes.
  const refreshShipments = useCallback(async () => {
    const selections: BulkSelection[] = activeSites
      .map((sid) => ({ site_id: sid, order_ids: (ordersBySite[sid] || []).map((o) => o.id) }))
      .filter((s) => s.order_ids.length > 0);
    if (selections.length === 0) {
      setShipmentsByOrder({});
      return;
    }
    try {
      const r = await api<{ shipments: Record<string, RmShipment> }>(
        "/api/royal-mail/shipments/by-orders",
        { body: { selections } },
      );
      setShipmentsByOrder(r.shipments || {});
    } catch {
      /* silent — RM not configured or transient failure */
    }
  }, [activeSites, ordersBySite]);

  useEffect(() => { refreshShipments(); }, [refreshShipments]);

  // Site toggling removed — all sites are always active. Orders from every
  // site are merged into a single sortable table, with a "Store" column on
  // each row to identify the source.

  // ---------- Unprinted helpers ----------
  const unprintedShipmentIds = useMemo(() => {
    const ids: number[] = [];
    for (const sid of activeSites) {
      for (const o of (ordersBySite[sid] || [])) {
        const sh = shipmentsByOrder[`${sid}:${o.id}`];
        if (sh && sh.has_label && !sh.printed_at && !sh.voided) ids.push(sh.id);
      }
    }
    return ids;
  }, [activeSites, ordersBySite, shipmentsByOrder]);

  const printUnprinted = async () => {
    if (unprintedShipmentIds.length === 0) {
      toast.info("Nothing to print — every label in view is already printed.");
      return;
    }
    // Snapshot the IDs once so they can't shift mid-flight, then run the
    // post-print bookkeeping (mark printed + refresh + reload) in the
    // background. Awaiting `printPdfBlob` would keep the spinner stuck on
    // the toolbar button until the user dismisses the print dialog (or up
    // to 10 minutes if the browser never fires `afterprint`).
    const ids = [...unprintedShipmentIds];
    setPrintingUnprinted(true);
    try {
      const blob = await apiBlob(
        `/api/royal-mail/shipments/bulk/labels.pdf?ids=${ids.join(",")}`,
      );
      // Fire-and-forget: opens the print dialog, resolves whenever the user
      // closes it. We don't await — the spinner is cleared as soon as the
      // dialog has been triggered.
      void printPdfBlob(
        blob,
        `rm-unprinted-${new Date().toISOString().slice(0, 10)}.pdf`,
      );
      toast.success(`Sent ${ids.length} label(s) to printer`);

      // Run server-side completion + UI refresh in the background so the
      // toolbar button is immediately interactive again.
      void (async () => {
        try {
          const r = await markShipmentsPrinted(ids);
          if (r.completed > 0) {
            toast.success(`Marked ${r.completed} order(s) as completed`);
          }
          if (r.completionErrors && r.completionErrors.length > 0) {
            toast.error(
              `Couldn't auto-complete: ${r.completionErrors[0].error}`,
              { description: r.completionErrors.length > 1
                  ? `+${r.completionErrors.length - 1} more — check WooCommerce.`
                  : undefined },
            );
          }
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Failed to mark printed");
        }
        // Refresh shipment badges, reload orders (temporarily including
        // "completed" so the freshly-completed orders stay visible), and
        // refresh today's stats so the revenue card jumps.
        await Promise.allSettled([
          refreshShipments(),
          loadOrders(true, ["completed"]),
        ]);
        refreshTodayStats();
      })();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Print failed");
    } finally {
      setPrintingUnprinted(false);
    }
  };

  const filteredBySite = useMemo(() => {
    const out: Record<number, OrderRow[]> = {};
    for (const sid of activeSites) {
      const arr = ordersBySite[sid] || [];
      const q = search.trim().toLowerCase();
      const filtered = arr.filter((o) => {
        if (!withinDateRange(o, datePreset, customFrom, customTo)) return false;
        if (showOnlyUnprinted) {
          const sh = shipmentsByOrder[`${sid}:${o.id}`];
          if (!sh || !sh.has_label || sh.printed_at || sh.voided) return false;
        }
        if (!q) return true;
        return o.number.toLowerCase().includes(q) || o.customer.toLowerCase().includes(q)
          || o.email.toLowerCase().includes(q);
      });
      out[sid] = [...filtered].sort((a, b) => {
        const ta = new Date(a.date_created).getTime();
        const tb = new Date(b.date_created).getTime();
        return sortOrder === "recent" ? tb - ta : ta - tb;
      });
    }
    return out;
  }, [ordersBySite, activeSites, search, sortOrder, datePreset, customFrom, customTo, showOnlyUnprinted, shipmentsByOrder]);

  // Flat, globally-sorted list of every visible order across all sites.
  // Each entry carries its siteId so the unified table can render the
  // "Store" column and selection bookkeeping still routes per-site.
  const flatOrders = useMemo(() => {
    const all: { sid: number; order: OrderRow }[] = [];
    for (const sid of activeSites) {
      for (const o of (filteredBySite[sid] || [])) all.push({ sid, order: o });
    }
    return all.sort((a, b) => {
      const ta = new Date(a.order.date_created).getTime();
      const tb = new Date(b.order.date_created).getTime();
      return sortOrder === "recent" ? tb - ta : ta - tb;
    });
  }, [filteredBySite, activeSites, sortOrder]);

  const toggleOne = (sid: number, oid: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev[sid] || []);
      if (checked) next.add(oid); else next.delete(oid);
      return { ...prev, [sid]: next };
    });
  };

  const toggleAllInSite = (sid: number, checked: boolean) => {
    setSelected((prev) => ({
      ...prev,
      [sid]: checked ? new Set((filteredBySite[sid] || []).map((o) => o.id)) : new Set(),
    }));
  };

  const totalSelected = activeSites.reduce((s, sid) => s + (selected[sid]?.size || 0), 0);
  const totalItems = activeSites.reduce((s, sid) => {
    const sel = selected[sid] || new Set();
    return s + (filteredBySite[sid] || []).filter((o) => sel.has(o.id))
      .reduce((a, o) => a + o.itemCount, 0);
  }, 0);

  // ---------- Queue stats (sourced from in-view processing rows) ----------
  // Backlog + aging are queue indicators driven by what the user has loaded.
  // Today-wide stats (count + revenue) come from the dedicated /api/stats/today
  // endpoint so they include completed orders even when the filter is
  // "processing only".
  const stats = useMemo(() => {
    let backlog = 0;
    let aging = 0;
    let totalItemsAll = 0;
    for (const sid of activeSites) {
      for (const o of (ordersBySite[sid] || [])) {
        totalItemsAll += o.itemCount;
        if (o.status === "processing") backlog++;
        if (isAging(o)) aging++;
      }
    }
    return { backlog, aging, totalItemsAll };
  }, [ordersBySite, activeSites]);

  // Convert today's per-currency revenue to a single GBP figure for display.
  const todaySummary = useMemo(() => {
    if (!todayStats) return { count: 0, revenueGbp: 0, unconverted: 0 };
    let revenueGbp = 0;
    let unconverted = 0;
    for (const [code, total] of Object.entries(todayStats.revenue_by_currency)) {
      const gbp = toGbp(total, code);
      if (gbp !== null) revenueGbp += gbp;
      else unconverted++;
    }
    return { count: todayStats.count, revenueGbp, unconverted };
  }, [todayStats, toGbp]);

  // ---------- Generate ----------
  const generate = async () => {
    const selections = activeSites
      .map((sid) => ({ site_id: sid, order_ids: Array.from(selected[sid] || []) }))
      .filter((s) => s.order_ids.length > 0);
    if (selections.length === 0) { toast.error("Select at least one order"); return; }
    setGenerating(true);
    try {
      const blob = await apiBlob("/api/picklist", { body: { selections, format } });
      const meta = FORMATS.find((f) => f.value === format)!;
      const stem =
        format === "picking_a4" ? "picking-slip"
        : format === "packing_a4" ? "packing-slip"
        : format === "packing_4x6" ? "packing-labels"
        : "shipping-labels";
      const filename = `${stem}-${new Date().toISOString().slice(0, 10)}.pdf`;
      // Open the print dialog directly instead of downloading. Falls back
      // to a normal download if the browser blocks print.
      await printPdfBlob(blob, filename);
      toast.success(`${meta.label} ready to print (${totalSelected} orders)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate");
    } finally { setGenerating(false); }
  };

  // ---------- Bulk actions ----------
  const buildSelections = () => activeSites
    .map((sid) => ({ site_id: sid, order_ids: Array.from(selected[sid] || []) }))
    .filter((s) => s.order_ids.length > 0);

  const bulkComplete = async () => {
    const selections = buildSelections();
    if (selections.length === 0) { toast.error("Select at least one order"); return; }
    if (!confirm(`Mark ${totalSelected} order(s) as completed and email customers?`)) return;
    setBulkBusy(true);
    try {
      const r = await api<{ results: { site_name: string; succeeded: number; failed: number }[] }>(
        "/api/orders/complete", { body: { selections, notify_customer: true } },
      );
      const ok = r.results.reduce((s, x) => s + x.succeeded, 0);
      const fail = r.results.reduce((s, x) => s + x.failed, 0);
      if (fail === 0) toast.success(`Marked ${ok} order(s) as completed`);
      else toast.warning(`Completed ${ok}, failed ${fail}`);
      loadOrders(true, ["completed"]);
      refreshTodayStats();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk complete failed");
    } finally { setBulkBusy(false); }
  };

  const bulkAddNote = async () => {
    const selections = buildSelections();
    if (selections.length === 0) { toast.error("Select at least one order"); return; }
    if (!noteText.trim()) { toast.error("Note is empty"); return; }
    setBulkBusy(true);
    try {
      const r = await api<{ results: { succeeded: number; failed: number }[] }>(
        "/api/orders/note",
        { body: { selections, note: noteText.trim(), customer_note: noteCustomerEmail } },
      );
      const ok = r.results.reduce((s, x) => s + x.succeeded, 0);
      const fail = r.results.reduce((s, x) => s + x.failed, 0);
      if (fail === 0) toast.success(`Added note to ${ok} order(s)`);
      else toast.warning(`Noted ${ok}, failed ${fail}`);
      setNoteDialogOpen(false);
      setNoteText("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk note failed");
    } finally { setBulkBusy(false); }
  };

  if (loadingSites) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (sites.length === 0) {
    return (
      <Card>
        <CardHeader className="text-center py-12">
          <Store className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
          <CardTitle>No sites configured</CardTitle>
          <CardDescription className="mb-4">Add a WooCommerce site to start generating picklists.</CardDescription>
          <Link to="/integrations"><Button>Add your first site</Button></Link>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Package}
        accent="violet"
        eyebrow="Workspace"
        title="Orders"
        description="Pull orders from your sites and generate picking, packing or shipping labels."
      />

      {/* Daily stats */}
      {Object.keys(ordersBySite).length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Backlog" value={stats.backlog} hint="processing orders" />
          <StatCard label="Aging > 24h" value={stats.aging}
            hint="needs attention"
            tone={stats.aging > 0 ? "warn" : "default"} />
          <StatCard label="Today's orders" value={todaySummary.count}
            hint="processing + completed today" />
          <StatCard label="Today's revenue" value={`£${todaySummary.revenueGbp.toFixed(2)}`}
            hint={todaySummary.unconverted > 0
              ? `GBP equivalent — ${todaySummary.unconverted} currency(ies) skipped (no rate)`
              : "GBP equivalent across currencies"} />
        </div>
      )}

      {Object.keys(ordersBySite).length > 0 && (
        <>
          {/* Filters */}
          <Card>
            <CardContent className="p-3 space-y-3">
              {/* Row 0 — Actions (bulk ops + slip generation + reload/print) */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground w-14 shrink-0">
                  Actions
                </span>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5">
                      <MoreHorizontal className="h-3.5 w-3.5" />
                      Actions{totalSelected > 0 ? ` (${totalSelected})` : ""}
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-64">
                    <DropdownMenuLabel>Bulk actions</DropdownMenuLabel>
                    <DropdownMenuItem onClick={bulkComplete} disabled={bulkBusy || totalSelected === 0}>
                      <CheckCircle2 className="h-4 w-4" /> Mark orders as completed
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setNoteDialogOpen(true)} disabled={bulkBusy || totalSelected === 0}>
                      <MessageSquarePlus className="h-4 w-4" /> Add note to orders
                    </DropdownMenuItem>

                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Packing / Shipping slips</DropdownMenuLabel>
                    {FORMATS.map((f) => (
                      <DropdownMenuCheckboxItem
                        key={f.value}
                        checked={format === f.value}
                        onCheckedChange={() => setFormat(f.value)}
                      >
                        <div className="flex flex-col">
                          <span>{f.label}</span>
                          <span className="text-xs text-muted-foreground">{f.hint}</span>
                        </div>
                      </DropdownMenuCheckboxItem>
                    ))}

                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Postage</DropdownMenuLabel>
                    <DropdownMenuItem
                      onClick={() => {
                        const sels = buildSelections();
                        if (sels.length === 0) return;
                        setRmBulkSelections(sels);
                        setRmBulkMode("create");
                      }}
                      disabled={bulkBusy || totalSelected === 0}
                    >
                      <Truck className="h-4 w-4" /> Create Royal Mail labels
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        const sels = buildSelections();
                        if (sels.length === 0) return;
                        setRmBulkSelections(sels);
                        setRmBulkMode("print");
                      }}
                      disabled={bulkBusy || totalSelected === 0}
                    >
                      <Printer className="h-4 w-4" /> Print Royal Mail labels
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => loadOrders(false)}
                  disabled={loadingOrders || activeSites.length === 0}
                  className="gap-1.5"
                >
                  {loadingOrders ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Reload
                </Button>

                <Button size="sm" onClick={generate} disabled={generating || totalSelected === 0} className="gap-1.5">
                  {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  Generate ({totalSelected})
                </Button>

                <Button
                  size="sm"
                  variant="secondary"
                  onClick={printUnprinted}
                  disabled={printingUnprinted || unprintedShipmentIds.length === 0}
                  title="Print every label in view that hasn't been printed yet"
                  className="gap-1.5 bg-brand-emerald text-white hover:bg-brand-emerald/90 disabled:bg-brand-emerald/40"
                >
                  {printingUnprinted ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
                  Print unprinted ({unprintedShipmentIds.length})
                </Button>
              </div>

              <div className="border-t" />

              {/* Row 1 — Filter (data fetching + narrowing) */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground w-14 shrink-0">
                  Filter
                </span>
                <Input placeholder="Order #, customer, or email..." value={search}
                  onChange={(e) => setSearch(e.target.value)} className="max-w-xs h-9" />

                {/* Status multi-select */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5">
                      <Filter className="h-3.5 w-3.5" />
                      {statuses.length === ALL_STATUSES.length
                        ? "All orders"
                        : statuses.length === 1
                          ? ALL_STATUSES.find((s) => s.value === statuses[0])?.label
                          : `${statuses.length} statuses`}
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuLabel>Order status</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuCheckboxItem
                      checked={statuses.length === ALL_STATUSES.length}
                      onCheckedChange={(v) => {
                        setStatuses(v ? ALL_STATUSES.map((s) => s.value) : ["processing"]);
                      }}
                    >
                      All orders
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                    {ALL_STATUSES.map((s) => (
                      <DropdownMenuCheckboxItem
                        key={s.value}
                        checked={statuses.includes(s.value)}
                        onCheckedChange={(v) => {
                          setStatuses((prev) => {
                            const next = v ? [...prev, s.value] : prev.filter((x) => x !== s.value);
                            return next.length === 0 ? ["processing"] : next;
                          });
                        }}
                      >
                        {s.label}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                <Select
                  value={datePreset}
                  onValueChange={(v) => setDatePreset(v as DatePreset)}
                >
                  <SelectTrigger className="w-[150px] h-9">
                    <CalendarIcon className="h-3.5 w-3.5" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* "All dates" is only meaningful for the live processing
                        backlog — for completed/cancelled/etc. it would pull
                        the entire WooCommerce history, so we hide it. */}
                    {allowsAllDates && (
                      <SelectItem value="all">All dates</SelectItem>
                    )}
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="24h">Last 24h</SelectItem>
                    <SelectItem value="7d">Last 7 days</SelectItem>
                    <SelectItem value="custom">Custom range</SelectItem>
                  </SelectContent>
                </Select>
                {datePreset === "custom" && (
                  <>
                    <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                      className="w-[150px] h-9" aria-label="From date" />
                    <span className="text-muted-foreground text-xs">to</span>
                    <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                      className="w-[150px] h-9" aria-label="To date" />
                  </>
                )}

                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5">
                      <Filter className="h-3.5 w-3.5" /> Priority
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="hv">High-value threshold</Label>
                      <div className="flex items-center gap-2">
                        <Input id="hv" type="number" min={0} step={10}
                          value={highValueThreshold}
                          onChange={(e) => setHighValueThreshold(Number(e.target.value) || 0)}
                          className="w-28" />
                        <span className="text-xs text-muted-foreground">currency units</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox id="repeat" checked={computeRepeat}
                        onCheckedChange={(v) => setComputeRepeat(Boolean(v))} />
                      <Label htmlFor="repeat" className="text-sm font-normal cursor-pointer">
                        Detect repeat customers <span className="text-muted-foreground">(slower)</span>
                      </Label>
                    </div>
                  </PopoverContent>
                </Popover>

                <Button size="sm" onClick={() => loadOrders(false)} disabled={loadingOrders}
                  className="gap-1.5 ml-auto">
                  {loadingOrders ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Show
                </Button>
              </div>

              <div className="border-t" />

              {/* Row 2 — View (sort, presets, notifications, counts) */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground w-14 shrink-0">
                  View
                </span>
                <Label htmlFor="sort-order" className="text-xs text-muted-foreground">Sort by</Label>
                <Select value={sortOrder} onValueChange={(v) => setSortOrder(v as "recent" | "oldest")}>
                  <SelectTrigger id="sort-order" className="w-[150px] h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recent">Most recent</SelectItem>
                    <SelectItem value="oldest">Oldest</SelectItem>
                  </SelectContent>
                </Select>

                <FilterPresets
                  siteId={activeSites.length === 1 ? activeSites[0] : null}
                  currentPayload={{
                    statuses, datePreset, customFrom, customTo, search, sortOrder,
                    highValueThreshold, computeRepeat,
                  }}
                  onApply={(p: PresetPayload) => {
                    setStatuses(p.statuses);
                    setDatePreset(p.datePreset as DatePreset);
                    setCustomFrom(p.customFrom);
                    setCustomTo(p.customTo);
                    setSearch(p.search);
                    setSortOrder(p.sortOrder as "recent" | "oldest");
                    setHighValueThreshold(p.highValueThreshold);
                    setComputeRepeat(p.computeRepeat);
                  }}
                />

                <Button variant="ghost" size="sm" onClick={() => setNotify(!notify)}
                  className="gap-1.5" aria-label={notify ? "Disable new-order notifications" : "Enable new-order notifications"}>
                  {notify ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5 text-muted-foreground" />}
                  {notify ? "Notifications on" : "Notifications off"}
                </Button>

                {/* Quick filter — show only orders with an unprinted RM label */}
                <Button
                  variant={showOnlyUnprinted ? "default" : "outline"}
                  size="sm"
                  onClick={() => setShowOnlyUnprinted((v) => !v)}
                  className="gap-1.5"
                  title="Toggle: show only orders with a label that hasn't been printed"
                >
                  <Printer className="h-3.5 w-3.5" />
                  Unprinted only ({unprintedShipmentIds.length})
                </Button>

                <div className="ml-auto flex gap-2">
                  <Badge variant="secondary">{totalSelected} selected</Badge>
                  <Badge variant="secondary">{totalItems} items</Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          {(() => {
            // Single merged table: every visible order across every site,
            // globally sorted, with a "Store" column to identify the source.
            const allSelected =
              flatOrders.length > 0 &&
              flatOrders.every(({ sid, order }) => (selected[sid] || new Set()).has(order.id));
            const toggleAllVisible = (checked: boolean) => {
              setSelected((prev) => {
                const next: Record<number, Set<number>> = { ...prev };
                if (checked) {
                  for (const { sid, order } of flatOrders) {
                    const s = new Set(next[sid] || []);
                    s.add(order.id);
                    next[sid] = s;
                  }
                } else {
                  for (const { sid, order } of flatOrders) {
                    const s = new Set(next[sid] || []);
                    s.delete(order.id);
                    next[sid] = s;
                  }
                }
                return next;
              });
            };
            return (
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Package className="h-4 w-4" /> Orders
                    <Badge variant="outline" className="ml-2">{flatOrders.length} orders</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="border-t">
                    <div className="flex items-center gap-3 px-4 py-2 bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={(v) => toggleAllVisible(Boolean(v))}
                        aria-label="Select all visible"
                      />
                      <div className="w-24">Order</div>
                      <div className="w-32">Store</div>
                      <div className="flex-1">Customer</div>
                      <div className="flex-[1.4] min-w-0">Items</div>
                      <div className="w-16 text-right">Qty</div>
                      <div className="w-24 text-right">Total</div>
                      <div className="w-28 text-right">Date</div>
                    </div>
                    {flatOrders.length === 0 && (
                      <div className="p-6 text-center text-muted-foreground text-sm">No orders match the current filters.</div>
                    )}
                    {flatOrders.map(({ sid, order: o }) => {
                      const site = sites.find((s) => s.id === sid);
                      const isSel = (selected[sid] || new Set()).has(o.id);
                      const aging = isAging(o);
                      return (
                        <div key={`${sid}:${o.id}`} role="button" tabIndex={0}
                          onClick={() => openOrder(sid, o.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault(); openOrder(sid, o.id);
                            }
                          }}
                          className={`flex items-center gap-3 px-4 py-2.5 border-t cursor-pointer hover:bg-muted/30 focus:outline-none focus:bg-muted/40 ${
                            isSel ? "bg-primary/5" : ""
                          } ${aging ? "border-l-2 border-l-red-500/60" : ""}`}>
                          <div onClick={(e) => e.stopPropagation()}
                            className="flex items-center" aria-label="Select order">
                            <Checkbox checked={isSel}
                              onCheckedChange={(v) => toggleOne(sid, o.id, Boolean(v))} />
                          </div>
                          <div className="w-24 font-medium">
                            <span>#{o.number}</span>
                          </div>
                          <div className="w-32 min-w-0">
                            <Badge variant="outline" className="gap-1 max-w-full">
                              <Store className="h-3 w-3 shrink-0" />
                              <span className="truncate">{site?.name || `Site ${sid}`}</span>
                            </Badge>
                          </div>
                          <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                            <span className="truncate">{o.customer || "\u2014"}</span>
                            {(() => {
                              const sh = shipmentsByOrder[`${sid}:${o.id}`];
                              if (sh && sh.printed_at) {
                                return (
                                  <Badge
                                    className="bg-slate-500 text-white border-0 text-[10px] px-1.5 py-0 gap-1 hover:bg-slate-500/90"
                                    title={`Printed ${new Date(sh.printed_at).toLocaleString()}`}
                                  >
                                    <Printer className="h-2.5 w-2.5" /> Printed
                                  </Badge>
                                );
                              }
                              if (sh && sh.has_label && !sh.voided) {
                                return (
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] px-1.5 py-0 gap-1 border-brand-amber/50 text-brand-amber"
                                    title="Label generated but not yet printed"
                                  >
                                    <Truck className="h-2.5 w-2.5" /> Label ready
                                  </Badge>
                                );
                              }
                              return null;
                            })()}
                            {o.status === "completed" && (
                              <Badge className="bg-brand-emerald text-white border-0 text-[10px] px-1.5 py-0">
                                Completed
                              </Badge>
                            )}
                            {o.status !== "processing" && o.status !== "completed" && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 capitalize">
                                {o.status.replace("-", " ")}
                              </Badge>
                            )}
                            {isEuropeOrder(o) && (
                              <Badge
                                className="bg-indigo-600 text-white border-0 text-[10px] px-1.5 py-0"
                                title="EU destination — print this label outside Ultrax"
                              >
                                Europe
                              </Badge>
                            )}
                            <PriorityBadges order={o} highValueThreshold={highValueThreshold} />
                          </div>
                          <div className="flex-[1.4] min-w-0 text-xs text-muted-foreground leading-tight">
                            {o.items && o.items.length > 0 ? (
                              <div className="space-y-0.5">
                                {o.items.slice(0, 3).map((it, idx) => (
                                  <div key={idx} className="truncate" title={`${it.quantity}× ${it.name}${it.sku ? ` [${it.sku}]` : ""}`}>
                                    <span className="tabular-nums font-medium text-foreground">{it.quantity}×</span>{" "}
                                    <span>{it.name}</span>
                                  </div>
                                ))}
                                {o.items.length > 3 && (
                                  <div className="text-muted-foreground/70">+{o.items.length - 3} more</div>
                                )}
                              </div>
                            ) : (
                              <span>—</span>
                            )}
                          </div>
                          <div className="w-16 text-right tabular-nums">
                            {o.itemCount}
                            <span className="text-muted-foreground text-xs ml-1">({o.lineCount})</span>
                          </div>
                          <div className="w-24 text-right tabular-nums text-muted-foreground flex flex-col items-end leading-tight">
                            <span>{o.currency} {o.total}</span>
                            {o.currency?.toUpperCase() !== "GBP" && (() => {
                              const v = parseFloat(o.total);
                              const gbp = Number.isFinite(v) ? toGbp(v, o.currency) : null;
                              return gbp !== null ? (
                                <span className="text-[10px] text-muted-foreground/70">
                                  ≈ £{gbp.toFixed(2)}
                                </span>
                              ) : null;
                            })()}
                          </div>
                          <div className="w-28 text-right text-muted-foreground text-sm">
                            {new Date(o.date_created).toLocaleDateString("en-GB")}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })()}
        </>
      )}

      {/* Bulk note dialog */}
      <Dialog open={noteDialogOpen} onOpenChange={setNoteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add note to {totalSelected} order(s)</DialogTitle>
            <DialogDescription>
              The note will be added to every selected order across all active sites.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea value={noteText} onChange={(e) => setNoteText(e.target.value)}
              placeholder="e.g. Fragile \u2014 pack with extra padding"
              rows={4} maxLength={2000} />
            <div className="flex items-center gap-2">
              <Checkbox id="cnote" checked={noteCustomerEmail}
                onCheckedChange={(v) => setNoteCustomerEmail(Boolean(v))} />
              <Label htmlFor="cnote" className="text-sm font-normal cursor-pointer">
                Email this note to the customer (otherwise stays internal)
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteDialogOpen(false)} disabled={bulkBusy}>Cancel</Button>
            <Button onClick={bulkAddNote} disabled={bulkBusy || !noteText.trim()}>
              {bulkBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              Add note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Order detail drawer */}
      <OrderDetailDrawer
        siteId={drawerSiteId}
        orderId={drawerOrderId}
        storeUrl={sites.find((s) => s.id === drawerSiteId)?.store_url}
        onOpenChange={closeDrawer}
      />

      {/* Bulk Royal Mail labels (create + print) */}
      <BulkRoyalMailDialog
        open={rmBulkMode !== null}
        mode={rmBulkMode || "create"}
        selections={rmBulkSelections}
        onOpenChange={(o) => { if (!o) setRmBulkMode(null); }}
        onCreated={() => {
          // After create or print, completed orders should re-appear in
          // view and the revenue card should jump.
          loadOrders(true, ["completed"]);
          refreshTodayStats();
        }}
      />
    </div>
  );
}

function StatCard({
  label, value, hint, tone = "default",
}: { label: string; value: number | string; hint: string; tone?: "default" | "warn" }) {
  const toneCls = tone === "warn" ? "text-amber-600 dark:text-amber-400" : "";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
        <div className={`text-2xl font-bold tabular-nums ${toneCls}`}>{value}</div>
        <div className="text-xs text-muted-foreground mt-1">{hint}</div>
      </CardContent>
    </Card>
  );
}
