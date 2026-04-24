// /inventory/woo — WooCommerce-backed inventory editor.
//
// Lets the user pick a connected WC site, sync its catalog, then bulk-edit
// SKUs/prices/stock/descriptions locally. Edits are buffered in component
// state until "Save" pushes them to the local OMS DB. A separate "Push to
// WooCommerce" button kicks off a 3-step confirm dialog that snapshots the
// current WC state, then PUTs the changes to /wc/v3/products.

import { createFileRoute } from "@tanstack/react-router";
import React, { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  RefreshCw, Save, Send, History, ChevronDown, ChevronRight,
  Loader2, AlertCircle, Undo2, Download, Copy, Trash2, RotateCw,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { wcApi, type WcEditPayload } from "@/lib/inventory-woo-api";
import { PushToWcDialog } from "@/components/inventory/push-to-wc-dialog";
import { WcBulkPanel, type BulkOp } from "@/components/inventory/wc-bulk-panel";
import { PaginationBar, type PageSize } from "@/components/inventory/pagination-bar";
import {
  InventoryFilterBar, DEFAULT_FILTERS,
  type InventoryFilters, type SortOption,
} from "@/components/inventory/inventory-filter-bar";
import { useSync } from "@/lib/sync-context";

const SORT_OPTIONS: SortOption[] = [
  { value: "name", label: "Name" },
  { value: "sku", label: "SKU" },
  { value: "regular_price", label: "Regular price" },
  { value: "sale_price", label: "Sale price" },
  { value: "stock_quantity", label: "Stock" },
  { value: "weight", label: "Weight" },
  { value: "wc_date_created", label: "Newest / Oldest" },
  { value: "last_synced_at", label: "Last sync" },
  { value: "dirty", label: "Edited first" },
];

export const Route = createFileRoute("/inventory/woo")({
  head: () => ({ meta: [{ title: "WooCommerce inventory — HeyShop" }] }),
  component: WooInventory,
});

/** Locally-edited row state. We mirror the server fields the user can edit.
 *  Keeping `description` as `string | null` lets us tell "user typed empty"
 *  apart from "never touched" (null). Same idea for the other fields: blank
 *  string = user cleared it on purpose; null = unchanged from sync. */
type DraftRow = {
  name: string;
  sku: string;
  regular_price: string;
  sale_price: string;
  stock_quantity: string;
  stock_status: string;
  manage_stock: boolean;
  weight: string;
  description: string;
};

/** Snapshot of the row as it was right after the last sync. Used to compute
 *  a per-field diff so we only push fields the user actually changed. We
 *  store EVERY editable field (not just the four base ones) so the diff is
 *  accurate even after the user types and reverts. */
type OriginalRow = DraftRow;

function WooInventory() {
  const qc = useQueryClient();
  const sites = useQuery({ queryKey: ["wc-sites"], queryFn: () => wcApi.listSites() });
  const [siteId, setSiteId] = useState<number | null>(null);

  // Default to the first site once loaded.
  useEffect(() => {
    if (siteId === null && sites.data?.length) setSiteId(sites.data[0].id);
  }, [sites.data, siteId]);

  const site = useMemo(
    () => sites.data?.find((s) => s.id === siteId) ?? null,
    [sites.data, siteId],
  );
  // Single source of truth — the new /api/oms/woo/products endpoint returns
  // every editable field (incl. real sale_price, weight, description and
  // image_url) plus variations as their own rows.
  const products = useQuery({
    queryKey: ["wc-products", siteId],
    queryFn: () => wcApi.listProducts(siteId!),
    enabled: !!siteId,
  });
  const siteProducts = products.data ?? [];

  /* ---------- Local edit buffer ---------- */
  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});
  const [originals, setOriginals] = useState<Record<string, OriginalRow>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<InventoryFilters>({
    ...DEFAULT_FILTERS,
    sortKey: "wc_date_created",
    sortDir: "desc",
  });
  const [openDesc, setOpenDesc] = useState<Set<string>>(new Set());
  const [pushOpen, setPushOpen] = useState(false);
  const [showBackups, setShowBackups] = useState(false);
  // Collapsed variable-parent ids: when collapsed, hide their variation rows.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Pagination state. `pageSize === 0` means "All".
  const [pageSize, setPageSize] = useState<PageSize>(25);
  const [page, setPage] = useState(1);
  // Wipe & re-sync confirmation dialog.
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeText, setWipeText] = useState("");
  const [wiping, setWiping] = useState(false);
  // Delete-from-HeyShop-only confirmation dialog (does not touch WC).
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Re-seed drafts whenever the products list arrives or a fresh sync lands.
  // Drafts are seeded with the REAL WC values (regular_price, sale_price,
  // description, weight, etc.) so the diff in buildEditsForIds correctly
  // detects what the user typed vs what WC already had.
  useEffect(() => {
    if (!products.data) return;
    const nextDrafts: Record<string, DraftRow> = {};
    const nextOriginals: Record<string, OriginalRow> = {};
    for (const p of products.data) {
      const row: DraftRow = {
        name: p.name ?? "",
        sku: p.sku ?? "",
        regular_price: p.regular_price != null ? String(p.regular_price) : "",
        sale_price: p.sale_price != null ? String(p.sale_price) : "",
        stock_quantity: String(p.stock_quantity ?? 0),
        stock_status: p.stock_status || "instock",
        manage_stock: !!p.manage_stock,
        weight: p.weight != null ? String(p.weight) : "",
        description: p.description ?? "",
      };
      nextDrafts[p.id] = row;
      nextOriginals[p.id] = { ...row };
    }
    setDrafts(nextDrafts);
    setOriginals(nextOriginals);
    setSelected(new Set());
  }, [products.data]);

  const updateDraft = (pid: string, patch: Partial<DraftRow>) =>
    setDrafts((d) => ({ ...d, [pid]: { ...d[pid], ...patch } }));

  const toggleSel = (pid: string) =>
    setSelected((s) => { const n = new Set(s); n.has(pid) ? n.delete(pid) : n.add(pid); return n; });

  const selectedIds = [...selected];
  const dirtyIds = useMemo(() => {
    return siteProducts.filter((p) => {
      const d = drafts[p.id]; const o = originals[p.id];
      if (!d || !o) return false;
      return d.name !== o.name ||
        d.sku !== o.sku ||
        d.regular_price !== o.regular_price ||
        d.sale_price !== o.sale_price ||
        d.stock_quantity !== o.stock_quantity ||
        d.stock_status !== o.stock_status ||
        d.manage_stock !== o.manage_stock ||
        d.weight !== o.weight ||
        d.description !== o.description;
    }).map((p) => p.id);
  }, [siteProducts, drafts, originals]);

  // Filtered + sorted visible rows. Collapsed variable-parents hide their
  // variation rows. Filters come from the shared InventoryFilterBar.
  const filteredProducts = useMemo(() => {
    const term = filters.search.trim().toLowerCase();
    const dirtySet = new Set(dirtyIds);
    const pMin = filters.priceMin ? Number(filters.priceMin) : null;
    const pMax = filters.priceMax ? Number(filters.priceMax) : null;
    const sMin = filters.salePriceMin ? Number(filters.salePriceMin) : null;
    const sMax = filters.salePriceMax ? Number(filters.salePriceMax) : null;
    const wMin = filters.weightMin ? Number(filters.weightMin) : null;
    const wMax = filters.weightMax ? Number(filters.weightMax) : null;

    // Pre-index variations by parent so we can answer "does any variation of
    // this variable parent match the numeric range filters?" in O(1).
    const allVariationsByParent = new Map<string, typeof siteProducts>();
    for (const p of siteProducts) {
      if (p.wc_type === "variation" && p.parent_product_id) {
        const arr = allVariationsByParent.get(p.parent_product_id) ?? [];
        arr.push(p);
        allVariationsByParent.set(p.parent_product_id, arr);
      }
    }
    const inRange = (val: number | null | undefined, lo: number | null, hi: number | null) => {
      if (lo == null && hi == null) return true;
      if (val == null) return false;
      if (lo != null && val < lo) return false;
      if (hi != null && val > hi) return false;
      return true;
    };
    const matchesNumericRanges = (p: typeof siteProducts[number]) => {
      // Variable parents have no own price/weight — defer to their variations.
      if (p.wc_type === "variable") {
        const vars = allVariationsByParent.get(p.id) ?? [];
        if (pMin == null && pMax == null && sMin == null && sMax == null && wMin == null && wMax == null) return true;
        return vars.some((v) =>
          inRange(v.regular_price, pMin, pMax) &&
          inRange(v.sale_price, sMin, sMax) &&
          inRange(v.weight, wMin, wMax),
        );
      }
      return (
        inRange(p.regular_price, pMin, pMax) &&
        inRange(p.sale_price, sMin, sMax) &&
        inRange(p.weight, wMin, wMax)
      );
    };

    const list = siteProducts.filter((p) => {
      if (term && !p.sku.toLowerCase().includes(term) && !p.name.toLowerCase().includes(term)) return false;
      if (p.parent_product_id && collapsed.has(p.parent_product_id)) return false;
      if (filters.wcType !== "all" && p.wc_type !== filters.wcType) return false;
      if (filters.editedOnly && !dirtySet.has(p.id)) return false;
      if (filters.stockStatus !== "any" && p.stock_status !== filters.stockStatus) return false;
      if (filters.manageStock !== "any" && p.manage_stock !== (filters.manageStock === "yes")) return false;
      if (filters.hasImage !== "any" && Boolean(p.image_url) !== (filters.hasImage === "yes")) return false;
      if (filters.hasSale !== "any") {
        const onSale = p.sale_price != null && p.sale_price > 0 && (p.regular_price == null || p.sale_price < p.regular_price);
        if (onSale !== (filters.hasSale === "yes")) return false;
      }
      if (filters.stockState !== "any" && p.wc_type !== "variable") {
        const q = p.stock_quantity ?? 0;
        if (filters.stockState === "out" && q > 0) return false;
        if (filters.stockState === "inStock" && q <= 0) return false;
        if (filters.stockState === "low" && (q <= 0 || q > 5)) return false;
        if (filters.stockState === "over" && q <= 100) return false;
      }
      if (!matchesNumericRanges(p)) return false;
      return true;
    });

    // Sort. Variations are NEVER mixed in with simple/variable products —
    // they always render directly under their own parent (and only when that
    // parent is in the visible set). The sort key applies to parents/simples;
    // variations under a sorted parent keep their original WC order.
    const dir = filters.sortDir === "asc" ? 1 : -1;
    const num = (v: number | null | undefined) => (v == null ? -Infinity : v);
    const cmp = (a: typeof list[number], b: typeof list[number]) => {
      switch (filters.sortKey) {
        case "sku": return a.sku.localeCompare(b.sku) * dir;
        case "regular_price": return (num(a.regular_price) - num(b.regular_price)) * dir;
        case "sale_price": return (num(a.sale_price) - num(b.sale_price)) * dir;
        case "stock_quantity": return ((a.stock_quantity ?? 0) - (b.stock_quantity ?? 0)) * dir;
        case "weight": return (num(a.weight) - num(b.weight)) * dir;
        case "wc_date_created": {
          const ta = a.wc_date_created ? Date.parse(a.wc_date_created) : 0;
          const tb = b.wc_date_created ? Date.parse(b.wc_date_created) : 0;
          return (ta - tb) * dir;
        }
        case "last_synced_at": {
          const ta = a.last_synced_at ? Date.parse(a.last_synced_at) : 0;
          const tb = b.last_synced_at ? Date.parse(b.last_synced_at) : 0;
          return (ta - tb) * dir;
        }
        case "dirty": {
          const da = dirtySet.has(a.id) ? 1 : 0;
          const db = dirtySet.has(b.id) ? 1 : 0;
          return (db - da);
        }
        case "name":
        default: return a.name.localeCompare(b.name) * dir;
      }
    };

    // Split into top-level rows (simples + variable parents) and a lookup of
    // variations indexed by their parent_product_id. Sort the top-level rows
    // by the chosen key, then re-assemble: each parent immediately followed
    // by its own variations (kept in their original WC order).
    const topLevel = list.filter((p) => !p.parent_product_id);
    const variationsByParent = new Map<string, typeof list>();
    for (const p of list) {
      if (p.parent_product_id) {
        const arr = variationsByParent.get(p.parent_product_id) ?? [];
        arr.push(p);
        variationsByParent.set(p.parent_product_id, arr);
      }
    }
    topLevel.sort(cmp);
    const ordered: typeof list = [];
    for (const p of topLevel) {
      ordered.push(p);
      const vars = variationsByParent.get(p.id);
      if (vars && vars.length) ordered.push(...vars);
    }
    return ordered;
  }, [siteProducts, filters, collapsed, dirtyIds]);

  // Reset to page 1 whenever the filter/search changes the visible set.
  useEffect(() => { setPage(1); }, [filters, pageSize, siteId]);

  // Paginated slice rendered into the table. `pageSize === 0` shows everything.
  const pagedProducts = useMemo(() => {
    if (pageSize === 0) return filteredProducts;
    const start = (page - 1) * pageSize;
    return filteredProducts.slice(start, start + pageSize);
  }, [filteredProducts, page, pageSize]);

  /* ---------- Bulk operations ---------- */
  const applyBulk = (op: BulkOp) => {
    if (selectedIds.length === 0) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const pid of selectedIds) {
        const d = next[pid]; if (!d) continue;
        const patch: Partial<DraftRow> = {};
        if (op.kind === "price") {
          const cur = Number(op.field === "regular_price" ? d.regular_price : d.sale_price) || 0;
          let n = cur;
          switch (op.mode) {
            case "set": n = op.value; break;
            case "incPct": n = cur * (1 + op.value / 100); break;
            case "decPct": n = cur * (1 - op.value / 100); break;
            case "incAmt": n = cur + op.value; break;
            case "decAmt": n = cur - op.value; break;
            case "round": n = Math.max(0, Math.floor(cur) + 0.99); break;
          }
          n = Math.max(0, Math.round(n * 100) / 100);
          patch[op.field] = n.toFixed(2);
        } else if (op.kind === "stock") {
          const cur = Number(d.stock_quantity) || 0;
          const n = op.mode === "set" ? op.value : op.mode === "inc" ? cur + op.value : Math.max(0, cur - op.value);
          patch.stock_quantity = String(Math.max(0, Math.floor(n)));
          patch.manage_stock = true;
        } else if (op.kind === "status") {
          patch.stock_status = op.value;
        } else if (op.kind === "manage") {
          patch.manage_stock = op.value;
        } else if (op.kind === "weight") {
          patch.weight = op.value.toFixed(3);
        } else if (op.kind === "find") {
          const src = op.field === "name" ? d.name : d.description;
          patch[op.field] = src.split(op.find).join(op.replace);
        }
        next[pid] = { ...d, ...patch };
      }
      return next;
    });
    toast.success(`Applied to ${selectedIds.length} row${selectedIds.length === 1 ? "" : "s"}`);
  };

  /** Copy a variable parent's edits down to ALL of its variation rows. */
  const copyParentToVariations = (parentId: string) => {
    const parentDraft = drafts[parentId];
    const variations = siteProducts.filter((p) => p.parent_product_id === parentId);
    if (!parentDraft || variations.length === 0) {
      toast.info("No variations under this product"); return;
    }
    setDrafts((prev) => {
      const next = { ...prev };
      for (const v of variations) {
        const cur = next[v.id]; if (!cur) continue;
        next[v.id] = {
          ...cur,
          regular_price: parentDraft.regular_price || cur.regular_price,
          sale_price: parentDraft.sale_price,
          weight: parentDraft.weight || cur.weight,
          stock_status: parentDraft.stock_status,
        };
      }
      return next;
    });
    toast.success(`Copied to ${variations.length} variation${variations.length === 1 ? "" : "s"}`);
  };

  /** Export the currently filtered + draft-edited rows as CSV. */
  const exportCsv = () => {
    const cols = ["sku", "name", "type", "regular_price", "sale_price", "stock_quantity", "stock_status", "manage_stock", "weight"];
    const rows = filteredProducts.map((p) => {
      const d = drafts[p.id] || ({} as DraftRow);
      return [
        d.sku ?? p.sku, d.name ?? p.name, p.wc_type,
        d.regular_price ?? "", d.sale_price ?? "",
        d.stock_quantity ?? "", d.stock_status ?? "",
        d.manage_stock ? "yes" : "no", d.weight ?? "",
      ];
    });
    const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [cols.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `wc-inventory-${site?.name ?? "export"}-${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const toggleCollapse = (parentId: string) =>
    setCollapsed((s) => { const n = new Set(s); n.has(parentId) ? n.delete(parentId) : n.add(parentId); return n; });

  /* ---------- Mutations ---------- */
  // Sync is delegated to the global SyncProvider so it survives page
  // navigation. The user can leave this page, browse orders / inventory,
  // and the topbar pill keeps showing live progress.
  const { startWcSync, current: syncState } = useSync();
  const syncing = !!syncState && !syncState.done && syncState.siteId === siteId;
  const sync = async (opts: { full?: boolean } = {}) => {
    if (!siteId || !site) return;
    await startWcSync(siteId, site.name, opts);
  };

  /** Wipe every imported product for the active site, then immediately
   *  kick off a fresh background sync. Other sites are untouched. */
  const wipeAndResync = async () => {
    if (!siteId || !site) return;
    setWiping(true);
    try {
      const r = await wcApi.wipeSite(siteId);
      toast.success(`Deleted ${r.deleted} products from ${site.name}. Re-syncing…`);
      // Clear local edit buffer + drop the cached product list immediately so
      // the grid empties before the sync repopulates it.
      setDrafts({}); setOriginals({}); setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["wc-products", siteId] });
      qc.invalidateQueries({ queryKey: ["wc-sites"] });
      qc.invalidateQueries({ queryKey: ["oms-products"] });
      qc.invalidateQueries({ queryKey: ["oms-inventory"] });
      setWipeOpen(false);
      setWipeText("");
      // Fire & forget — the SyncProvider drives the chunked loop and the
      // topbar pill shows progress, so the user can navigate away.
      void startWcSync(siteId, site.name);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Wipe failed");
    } finally {
      setWiping(false);
    }
  };

  const buildEditsForIds = (ids: string[]): WcEditPayload[] => {
    return ids.map((pid) => {
      const d = drafts[pid]; const o = originals[pid];
      if (!d || !o) return null;
      const fields: WcEditPayload["fields"] = {};
      if (d.name !== o.name) fields.name = d.name;
      if (d.sku !== o.sku) fields.sku = d.sku;
      if (d.regular_price !== o.regular_price) {
        fields.regular_price = d.regular_price === "" ? null : Number(d.regular_price);
      }
      if (d.sale_price !== o.sale_price) {
        fields.sale_price = d.sale_price === "" ? null : Number(d.sale_price);
      }
      if (d.weight !== o.weight) {
        fields.weight = d.weight === "" ? null : Number(d.weight);
      }
      if (d.description !== o.description) fields.description = d.description;
      if (d.stock_quantity !== o.stock_quantity) {
        fields.stock_quantity = Number(d.stock_quantity) || 0;
      }
      if (d.stock_status !== o.stock_status) fields.stock_status = d.stock_status;
      if (d.manage_stock !== o.manage_stock) fields.manage_stock = d.manage_stock;
      if (Object.keys(fields).length === 0) return null;
      return { product_id: pid, fields };
    }).filter((x): x is WcEditPayload => x !== null);
  };

  const saveLocal = async () => {
    if (!siteId) return;
    const ids = selectedIds.length ? selectedIds : dirtyIds;
    if (ids.length === 0) {
      toast.info("Nothing to save"); return;
    }
    const payload = buildEditsForIds(ids);
    if (payload.length === 0) { toast.info("Nothing to save"); return; }
    const t = toast.loading(`Saving ${payload.length} change${payload.length === 1 ? "" : "s"}…`);
    try {
      const r = await wcApi.saveLocal(siteId, payload);
      toast.success(`Saved locally: ${r.ok}${r.failed.length ? `, ${r.failed.length} failed` : ""}`, { id: t });
      qc.invalidateQueries({ queryKey: ["wc-sites"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed", { id: t });
    }
  };

  // What we'll push: any selected rows that actually have unsaved changes,
  // PLUS any dirty variations under a selected variable parent (so picking the
  // parent row pushes its edited children too). If nothing is selected, fall
  // back to all dirty rows. We never include rows that are already in sync —
  // those just produce a confusing "No changes to push" error per row.
  const dirtySet = useMemo(() => new Set(dirtyIds), [dirtyIds]);
  const idsForPush = useMemo(() => {
    if (selectedIds.length === 0) return dirtyIds;
    const expanded = new Set<string>();
    for (const id of selectedIds) {
      const row = siteProducts.find((p) => p.id === id);
      if (!row) continue;
      if (dirtySet.has(id)) expanded.add(id);
      // Selecting a variable parent implicitly includes any dirty variation
      // beneath it — so the user doesn't have to expand + tick each one.
      if (row.wc_type === "variable") {
        for (const v of siteProducts) {
          if (v.parent_product_id === id && dirtySet.has(v.id)) expanded.add(v.id);
        }
      }
    }
    return [...expanded];
  }, [selectedIds, siteProducts, dirtyIds, dirtySet]);

  const doBackup = async () => {
    if (!siteId || idsForPush.length === 0) return false;
    try {
      const r = await wcApi.createBackup(siteId, idsForPush);
      toast.success(`Backup saved (${r.count} products)`);
      qc.invalidateQueries({ queryKey: ["wc-backups"] });
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Backup failed");
      return false;
    }
  };

  const doPush = async () => {
    if (!siteId || idsForPush.length === 0) return;
    // First save anything still in the local buffer so the server has the
    // latest values to push.
    try {
      await wcApi.saveLocal(siteId, buildEditsForIds(idsForPush));
    } catch (e) {
      toast.error(e instanceof Error ? `Save before push failed: ${e.message}` : "Save before push failed");
      return;
    }
    const t = toast.loading(`Pushing ${idsForPush.length} product${idsForPush.length === 1 ? "" : "s"} to WooCommerce…`);
    try {
      const r = await wcApi.push(siteId, idsForPush);
      if (r.failed.length) {
        const first = r.failed[0]?.error || r.failed[0]?.reason || "unknown";
        toast.warning(
          `Pushed ${r.ok}, failed ${r.failed.length}. First error: ${first}`,
          { id: t, duration: 8000 },
        );
      } else {
        toast.success(`Pushed ${r.ok} product${r.ok === 1 ? "" : "s"} to WooCommerce`, { id: t });
      }
      qc.invalidateQueries({ queryKey: ["wc-sites"] });
      qc.invalidateQueries({ queryKey: ["wc-backups"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Push failed", { id: t });
    }
  };

  /* ---------- Empty / error states ---------- */
  if (sites.error) {
    return (
      <div className="rounded-lg border border-brand-amber/40 bg-brand-amber-soft p-4 text-sm">
        <div className="flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 text-brand-amber" />
          <div>
            <p className="font-semibold">WooCommerce bridge not available.</p>
            <p className="text-muted-foreground mt-1">
              Could not reach <code className="font-mono">/api/oms/woo/*</code>. Make sure the
              backend is running and you're signed in.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!sites.isLoading && (!sites.data || sites.data.length === 0)) {
    return (
      <div className="rounded-lg border bg-card p-6 text-center">
        <p className="font-semibold">No WooCommerce sites connected yet.</p>
        <p className="text-sm text-muted-foreground mt-1">
          Add a site under <strong>Integrations → Channels</strong> first, then come back here to
          sync its catalog.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-2.5 rounded-t-lg">
        <h1 className="mr-2 text-sm font-semibold">WooCommerce inventory</h1>
        <Select
          value={siteId != null ? String(siteId) : ""}
          onValueChange={(v) => setSiteId(Number(v))}
        >
          <SelectTrigger className="h-8 w-[220px] text-xs">
            <SelectValue placeholder="Select site" />
          </SelectTrigger>
          <SelectContent>
            {sites.data?.map((s) => (
              <SelectItem key={s.id} value={String(s.id)}>
                {s.name} {s.dirty_count > 0 && (
                  <span className="ml-1 text-brand-amber">• {s.dirty_count} unpushed</span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <InventoryFilterBar
          presetKey={`wc-${siteId ?? "none"}`}
          value={filters}
          onChange={setFilters}
          availableFields={[
            "search", "wcType", "stockState", "stockStatus", "manageStock",
            "priceRange", "salePriceRange", "weightRange", "edited", "hasImage", "hasSale",
          ]}
          sortOptions={SORT_OPTIONS}
          counts={{
            total: siteProducts.length,
            visible: filteredProducts.length,
            edited: dirtyIds.length,
          }}
        />

        <div className="ml-auto flex items-center gap-2">
          <Badge
            variant="outline"
            className="font-mono text-[10px]"
            title={
              selectedIds.length > 0 && idsForPush.length === 0
                ? "Selected rows have no unsaved changes — edit a field first, or use ‘Copy to variations’ on the parent row."
                : `${idsForPush.length} row${idsForPush.length === 1 ? "" : "s"} ready to push`
            }
          >
            {idsForPush.length} to push
          </Badge>
          <WcBulkPanel selectedCount={selectedIds.length} onApply={applyBulk} />
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={filteredProducts.length === 0}>
            <Download className="mr-1.5 h-3.5 w-3.5" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowBackups(true)}>
            <History className="mr-1.5 h-3.5 w-3.5" /> Backups
          </Button>
          <div className="inline-flex">
            <Button
              variant="outline"
              size="sm"
              onClick={() => sync()}
              disabled={!siteId || syncing}
              className="rounded-r-none border-r-0"
              title="Pull only products newly added in WooCommerce since the last full sync"
            >
              {syncing
                ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              {syncing ? "Syncing…" : "Sync from WC"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!siteId || syncing}
                  className="rounded-l-none px-2"
                  aria-label="Sync options"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel>Sync options</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => sync()}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  <div className="flex flex-col">
                      <span>Sync new products only</span>
                    <span className="text-xs text-muted-foreground">
                        Default. Pulls only products added in WC since the last full sync.
                    </span>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => sync({ full: true })}>
                  <RotateCw className="mr-2 h-4 w-4" />
                  <div className="flex flex-col">
                    <span>Full re-sync (all products)</span>
                    <span className="text-xs text-muted-foreground">
                      Re-imports the entire catalog. Use after restoring or if data looks stale.
                    </span>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button
            variant="outline" size="sm"
            onClick={() => { setWipeText(""); setWipeOpen(true); }}
            disabled={!siteId || syncing || siteProducts.length === 0}
            className="text-destructive hover:text-destructive"
            title="Delete all imported products for this site"
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Wipe & re-sync
          </Button>
          <Button variant="outline" size="sm" onClick={saveLocal} disabled={!siteId}>
            <Save className="mr-1.5 h-3.5 w-3.5" /> Save
          </Button>
          <Button
            size="sm"
            onClick={() => setPushOpen(true)}
            disabled={!siteId || idsForPush.length === 0}
          >
            <Send className="mr-1.5 h-3.5 w-3.5" /> Push to WooCommerce
          </Button>
        </div>
      </div>

      {/* Status row */}
      {site && (
        <div className="flex items-center gap-3 border-b border-t-0 bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
          <span className="font-mono">{site.store_url}</span>
          <span>•</span>
          <span>{site.product_count} products synced</span>
          {site.last_synced_at ? (
            <>
              <span>•</span>
              <span>last sync {new Date(site.last_synced_at).toLocaleString()}</span>
            </>
          ) : (
            <span className="text-brand-amber">never synced — click "Sync from WC"</span>
          )}
        </div>
      )}

      {/* Grid */}
      <div className="overflow-auto border border-t-0">
        {products.isLoading ? (
          <div className="grid h-64 place-items-center text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : siteProducts.length === 0 ? (
          <div className="grid h-64 place-items-center text-sm text-muted-foreground">
            No products yet. Click <strong className="mx-1">Sync from WC</strong> to import.
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-xs table-fixed">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="h-9">
                <th className="w-8 border-b px-2 text-left align-middle">
                  <Checkbox
                    checked={selected.size > 0 && selected.size === filteredProducts.length}
                    onCheckedChange={(v) => {
                      if (v) setSelected(new Set(filteredProducts.map((p) => p.id)));
                      else setSelected(new Set());
                    }}
                  />
                </th>
                <th className="w-7 border-b px-1 text-left align-middle"></th>
                <th className="w-12 border-b px-1 text-left align-middle"></th>
                <th className="w-[120px] border-b px-2 text-left align-middle">SKU</th>
                <th className="border-b px-2 text-left align-middle">Name</th>
                <th className="w-[88px] border-b px-2 text-right align-middle">Regular</th>
                <th className="w-[88px] border-b px-2 text-right align-middle">Sale</th>
                <th className="w-[72px] border-b px-2 text-right align-middle">Stock</th>
                <th className="w-[120px] border-b px-2 text-left align-middle">Status</th>
                <th className="w-[64px] border-b px-2 text-center align-middle">Manage</th>
                <th className="w-[72px] border-b px-2 text-right align-middle">Weight</th>
                <th className="w-16 border-b px-2 align-middle"></th>
              </tr>
            </thead>
            <tbody>
              {pagedProducts.map((p) => {
                const d = drafts[p.id];
                if (!d) return null;
                const isDirty = dirtyIds.includes(p.id);
                const isOpen = openDesc.has(p.id);
                const isVariation = p.wc_type === "variation";
                const isVariableParent = p.wc_type === "variable";
                return (
                  <React.Fragment key={p.id}>
                    <tr
                      className={cn("group h-9", isDirty && "bg-brand-amber-soft/40")}
                    >
                      <td className="h-9 border-b px-2 align-middle">
                        <Checkbox
                          checked={selected.has(p.id)}
                          onCheckedChange={() => {
                            // For variable parents, toggle ALL of its variations.
                            if (isVariableParent) {
                              const vIds = siteProducts.filter((x) => x.parent_product_id === p.id).map((x) => x.id);
                              setSelected((s) => {
                                const n = new Set(s);
                                const allSelected = vIds.every((id) => n.has(id));
                                vIds.forEach((id) => allSelected ? n.delete(id) : n.add(id));
                                return n;
                              });
                            } else {
                              toggleSel(p.id);
                            }
                          }}
                        />
                      </td>
                      <td className="h-9 border-b px-1 align-middle">
                        {isVariableParent ? (
                          <button
                            onClick={() => toggleCollapse(p.id)}
                            className="rounded p-0.5 hover:bg-muted"
                            aria-label="Collapse variations"
                          >
                            {collapsed.has(p.id) ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </button>
                        ) : (
                          <button
                            onClick={() =>
                              setOpenDesc((s) => {
                                const n = new Set(s);
                                n.has(p.id) ? n.delete(p.id) : n.add(p.id);
                                return n;
                              })
                            }
                            className="rounded p-0.5 hover:bg-muted"
                            aria-label="Toggle description"
                          >
                            {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </button>
                        )}
                      </td>
                      <td className="h-9 border-b px-1 align-middle">
                        {p.image_url ? (
                          <img
                            src={p.image_url}
                            alt=""
                            loading="lazy"
                            className="h-7 w-7 rounded object-cover border bg-muted"
                          />
                        ) : (
                          <div className="h-7 w-7 rounded border bg-muted/40" />
                        )}
                      </td>
                      <td className="h-9 border-b p-0 align-middle">
                        <Input
                          value={d.sku}
                          onChange={(e) => updateDraft(p.id, { sku: e.target.value })}
                          className="h-9 w-full rounded-none border-0 bg-transparent px-2 font-mono text-xs focus-visible:ring-1"
                        />
                      </td>
                      <td className="h-9 border-b p-0 align-middle">
                        <div className={cn("flex items-center gap-1", isVariation && "pl-4")}>
                          {isVariation && (
                            <span className="text-muted-foreground text-[10px]">↳</span>
                          )}
                          <Input
                            value={d.name}
                            onChange={(e) => updateDraft(p.id, { name: e.target.value })}
                            disabled={isVariation}
                            className="h-9 w-full rounded-none border-0 bg-transparent px-2 text-xs focus-visible:ring-1 disabled:opacity-100"
                          />
                          {isVariableParent && (() => {
                            const vCount = siteProducts.filter((x) => x.parent_product_id === p.id).length;
                            return (
                              <>
                                <Badge variant="outline" className="text-[9px]">
                                  VARIABLE • {vCount} {vCount === 1 ? "variation" : "variations"}
                                </Badge>
                                {vCount === 0 && (
                                  <span
                                    className="text-[9px] text-brand-amber font-semibold"
                                    title="WooCommerce returned no variations for this parent — check that variations are published in WC."
                                  >
                                    ⚠ no variations imported
                                  </span>
                                )}
                                <button
                                  onClick={() => copyParentToVariations(p.id)}
                                  className="mr-1 rounded p-1 hover:bg-muted"
                                  title="Copy price/weight/status to all variations"
                                  aria-label="Copy to variations"
                                >
                                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                                </button>
                              </>
                            );
                          })()}
                        </div>
                      </td>
                      <td className="h-9 border-b p-0 align-middle">
                        <Input
                          value={d.regular_price}
                          onChange={(e) => updateDraft(p.id, { regular_price: e.target.value })}
                          inputMode="decimal"
                          placeholder={isVariableParent ? "→ all" : ""}
                          className="h-9 w-full rounded-none border-0 bg-transparent px-2 text-right font-mono text-xs focus-visible:ring-1"
                        />
                      </td>
                      <td className="h-9 border-b p-0 align-middle">
                        <div className="relative h-9">
                          <Input
                            value={d.sale_price}
                            onChange={(e) => updateDraft(p.id, { sale_price: e.target.value })}
                            inputMode="decimal"
                            placeholder={isVariableParent ? "→ all" : ""}
                            className="h-9 w-full rounded-none border-0 bg-transparent pl-2 pr-6 text-right font-mono text-xs focus-visible:ring-1"
                          />
                          {d.sale_price !== "" && (
                            <button
                              type="button"
                              onClick={() => updateDraft(p.id, { sale_price: "" })}
                              title="Clear sale price (will remove the sale on WooCommerce after Save + Push)"
                              className="absolute right-1 top-1/2 -translate-y-1/2 grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              <span className="text-xs leading-none">×</span>
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="h-9 border-b p-0 align-middle">
                        <Input
                          value={d.stock_quantity}
                          onChange={(e) => updateDraft(p.id, { stock_quantity: e.target.value })}
                          inputMode="numeric"
                          disabled={isVariableParent}
                          className="h-9 w-full rounded-none border-0 bg-transparent px-2 text-right font-mono text-xs focus-visible:ring-1"
                        />
                      </td>
                      <td className="h-9 border-b p-0 align-middle">
                        <Select
                          value={d.stock_status}
                          onValueChange={(v) => updateDraft(p.id, { stock_status: v })}
                        >
                          <SelectTrigger className="h-9 w-full rounded-none border-0 bg-transparent px-2 text-xs focus-visible:ring-1">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="instock">In stock</SelectItem>
                            <SelectItem value="outofstock">Out of stock</SelectItem>
                            <SelectItem value="onbackorder">Backorder</SelectItem>
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="h-9 border-b px-2 text-center align-middle">
                        <Checkbox
                          checked={d.manage_stock}
                          onCheckedChange={(v) => updateDraft(p.id, { manage_stock: !!v })}
                          disabled={isVariableParent}
                        />
                      </td>
                      <td className="h-9 border-b p-0 align-middle">
                        <Input
                          value={d.weight}
                          onChange={(e) => updateDraft(p.id, { weight: e.target.value })}
                          inputMode="decimal"
                          placeholder={isVariableParent ? "→ all" : ""}
                          className="h-9 w-full rounded-none border-0 bg-transparent px-2 text-right font-mono text-xs focus-visible:ring-1"
                        />
                      </td>
                      <td className="h-9 border-b px-2 text-right align-middle">
                        {isDirty && (
                          <Badge variant="outline" className="text-[10px] border-brand-amber text-brand-amber">
                            edited
                          </Badge>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className={cn(isDirty && "bg-brand-amber-soft/40")}>
                        <td colSpan={12} className="border-b bg-muted/20 px-3 py-2">
                          <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            Description (HTML)
                          </label>
                          <Textarea
                            value={d.description}
                            onChange={(e) => updateDraft(p.id, { description: e.target.value })}
                            placeholder="Leave blank to keep existing WooCommerce description"
                            rows={4}
                            className="mt-1 font-mono text-xs"
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <PaginationBar
        total={filteredProducts.length}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      {/* Push dialog */}
      <PushToWcDialog
        open={pushOpen}
        onOpenChange={setPushOpen}
        productCount={idsForPush.length}
        siteName={site?.name ?? ""}
        onBackup={doBackup}
        onPush={doPush}
      />

      {/* Backups drawer */}
      {showBackups && <BackupsPanel onClose={() => setShowBackups(false)} />}

      {/* Wipe & re-sync confirmation. Requires the user to type DELETE so it
          cannot be triggered by an accidental Enter / double-click. */}
      <AlertDialog open={wipeOpen} onOpenChange={(o) => { setWipeOpen(o); if (!o) setWipeText(""); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-destructive" />
              Wipe & re-sync {site?.name ?? "site"}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  This deletes <strong>{siteProducts.length}</strong> imported products
                  (including variations and stock levels) for this site only. Other
                  connected stores are not affected.
                </p>
                <p>
                  A fresh sync from WooCommerce will start automatically. Any local
                  edits you haven&apos;t pushed yet will be lost.
                </p>
                <p className="text-xs text-muted-foreground">
                  Type <strong className="font-mono text-foreground">DELETE</strong> to confirm.
                </p>
                <input
                  autoFocus
                  value={wipeText}
                  onChange={(e) => setWipeText(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  placeholder="DELETE"
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={wiping}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); wipeAndResync(); }}
              disabled={wipeText !== "DELETE" || wiping}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {wiping ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Wiping…</> : "Wipe & re-sync"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ---------- Backups panel ---------- */
function BackupsPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const backups = useQuery({ queryKey: ["wc-backups"], queryFn: () => wcApi.listBackups() });
  const [restoring, setRestoring] = useState<string | null>(null);

  const restore = async (id: string) => {
    setRestoring(id);
    const t = toast.loading("Restoring snapshot to WooCommerce…");
    try {
      const r = await wcApi.restoreBackup(id);
      toast.success(`Restored ${r.ok}${r.failed.length ? `, ${r.failed.length} failed` : ""}`, { id: t });
      qc.invalidateQueries({ queryKey: ["wc-backups"] });
      qc.invalidateQueries({ queryKey: ["wc-sites"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Restore failed", { id: t });
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <aside className="ml-auto h-full w-full max-w-md overflow-y-auto bg-background p-4 shadow-2xl">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <History className="h-4 w-4" /> WooCommerce backups
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
        {backups.isLoading ? (
          <div className="grid h-32 place-items-center"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : !backups.data || backups.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No backups yet. Snapshots are created automatically when you push, if you confirm "Create backup".</p>
        ) : (
          <ul className="space-y-2">
            {backups.data.map((b) => (
              <li key={b.id} className="rounded-md border bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{b.label || "Snapshot"}</p>
                    <p className="text-xs text-muted-foreground">
                      {b.site_name} • {b.product_count} product{b.product_count === 1 ? "" : "s"}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {new Date(b.created_at).toLocaleString()}
                      {b.restored_at && (
                        <span className="ml-1 text-brand-emerald">• restored {new Date(b.restored_at).toLocaleString()}</span>
                      )}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => restore(b.id)}
                    disabled={restoring === b.id}
                  >
                    {restoring === b.id
                      ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Restoring</>
                      : <><Undo2 className="mr-1 h-3.5 w-3.5" /> Restore</>}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
