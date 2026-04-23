// /inventory/woo — WooCommerce-backed inventory editor.
//
// Lets the user pick a connected WC site, sync its catalog, then bulk-edit
// SKUs/prices/stock/descriptions locally. Edits are buffered in component
// state until "Save" pushes them to the local OMS DB. A separate "Push to
// WooCommerce" button kicks off a 3-step confirm dialog that snapshots the
// current WC state, then PUTs the changes to /wc/v3/products.

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  RefreshCw, Search, Save, Send, History, ChevronDown, ChevronRight,
  Loader2, AlertCircle, Undo2,
} from "lucide-react";
import { wcApi, type WcEditPayload } from "@/lib/inventory-woo-api";
import { api } from "@/lib/api";
import type { Product } from "@/lib/api-types";
import { PushToWcDialog } from "@/components/inventory/push-to-wc-dialog";

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
 *  a per-field diff so we only push fields the user actually changed —
 *  prevents wiping WC data we never had locally (real regular_price,
 *  sale_price, weight, description, etc.). */
type OriginalRow = {
  name: string;
  sku: string;
  regular_price: string;
  stock_quantity: string;
};

/** Pull WC mirror products + stock from the OMS endpoints (already implemented). */
function useWcCatalog(siteId: number | null, warehouseId: string | null) {
  const products = useQuery({
    queryKey: ["wc-products", siteId],
    queryFn: () => api<Product[]>(`/api/oms/products`),
    enabled: !!siteId,
  });
  const inventory = useQuery({
    queryKey: ["wc-inventory", siteId, warehouseId],
    queryFn: () => api<Array<{
      product_id: string; warehouse_id: string;
      quantity: number; reserved: number; reorder_level: number; version: number;
    }>>(`/api/oms/inventory`),
    enabled: !!siteId && !!warehouseId,
  });
  return { products, inventory };
}

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
  const warehouseId = site?.warehouse_id ?? null;
  const { products, inventory } = useWcCatalog(siteId, warehouseId);

  // Filter to this site's WC products.
  const siteProducts = useMemo(() => {
    if (!products.data || !site) return [];
    // The /api/oms/products endpoint returns all products. Filter client-side
    // by source='woo' and woo_product_id presence; site_id isn't exposed on
    // that endpoint but the per-site mirror warehouse uniquely identifies the
    // rows that belong to this site.
    return products.data.filter((p) => p.source === "woo" && p.woo_product_id != null);
  }, [products.data, site]);

  const stockByProduct = useMemo(() => {
    const m = new Map<string, number>();
    inventory.data?.forEach((r) => {
      if (r.warehouse_id === warehouseId) m.set(r.product_id, r.quantity);
    });
    return m;
  }, [inventory.data, warehouseId]);

  // Augmented rows pulled directly from WC sync (need the extra fields).
  // The /products endpoint only returns base fields, so we hit a thin
  // additional fetch via the woo bridge whenever the site changes.
  const fullRows = useQuery({
    queryKey: ["wc-full", siteId, warehouseId],
    enabled: !!siteId && !!warehouseId,
    queryFn: async () => {
      // Reuse inventory + products via parallel fetch already done above.
      // Then enrich with the extra columns by calling a /products route that
      // returns the extra columns. For simplicity we use a single JOIN view —
      // here, we just refetch products from the SQLite via a small endpoint.
      // (The /api/oms/products endpoint returns only the base shape; we ship
      // the extra fields by reading from the catalog endpoint we already have
      // — so we map from siteProducts and stockByProduct.)
      return null;
    },
  });
  // fullRows is a no-op placeholder; keep silent linter happy.
  void fullRows;

  /* ---------- Local edit buffer ---------- */
  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});
  const [originals, setOriginals] = useState<Record<string, OriginalRow>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [openDesc, setOpenDesc] = useState<Set<string>>(new Set());
  const [pushOpen, setPushOpen] = useState(false);
  const [showBackups, setShowBackups] = useState(false);

  // Initialise drafts whenever the site or product list changes. Defaults
  // intentionally use blank strings for fields we don't have locally
  // (sale_price, weight, description) — sending them would clobber WC data.
  useEffect(() => {
    const nextDrafts: Record<string, DraftRow> = {};
    const nextOriginals: Record<string, OriginalRow> = {};
    for (const p of siteProducts) {
      const stock = String(stockByProduct.get(p.id) ?? 0);
      const regular = String(p.base_price ?? "");
      nextDrafts[p.id] = {
        name: p.name ?? "",
        sku: p.sku ?? "",
        regular_price: regular,
        sale_price: "",
        stock_quantity: stock,
        stock_status: "instock",
        manage_stock: true,
        weight: "",
        description: "",
      };
      nextOriginals[p.id] = {
        name: p.name ?? "",
        sku: p.sku ?? "",
        regular_price: regular,
        stock_quantity: stock,
      };
    }
    setDrafts(nextDrafts);
    setOriginals(nextOriginals);
    setSelected(new Set());
  }, [siteId, siteProducts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return siteProducts;
    return siteProducts.filter(
      (p) => p.sku.toLowerCase().includes(term) || p.name.toLowerCase().includes(term),
    );
  }, [siteProducts, search]);

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
        d.stock_quantity !== o.stock_quantity ||
        d.sale_price !== "" || d.weight !== "" || d.description !== "";
    }).map((p) => p.id);
  }, [siteProducts, drafts, originals]);

  /* ---------- Mutations ---------- */
  const sync = async () => {
    if (!siteId) return;
    const t = toast.loading(`Syncing ${site?.name ?? "site"}…`);
    try {
      const r = await wcApi.sync(siteId);
      toast.success(`Synced: ${r.created} new, ${r.updated} updated`, { id: t });
      qc.invalidateQueries({ queryKey: ["wc-sites"] });
      qc.invalidateQueries({ queryKey: ["wc-products", siteId] });
      qc.invalidateQueries({ queryKey: ["wc-inventory", siteId] });
      qc.invalidateQueries({ queryKey: ["oms-products"] });
      qc.invalidateQueries({ queryKey: ["oms-inventory"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed", { id: t });
    }
  };

  /** Build a diff payload for the bulk-save endpoint. Only includes fields
   *  the user actually changed since the last sync — prevents wiping WC
   *  values we never had locally (real sale_price, weight, etc.). */
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
      if (d.sale_price !== "") fields.sale_price = Number(d.sale_price);
      if (d.stock_quantity !== o.stock_quantity) {
        fields.stock_quantity = Number(d.stock_quantity) || 0;
      }
      if (d.weight !== "") fields.weight = Number(d.weight);
      if (d.description !== "") fields.description = d.description;
      // Only send stock_status / manage_stock when the user touched stock,
      // so we don't overwrite the existing WC values on price-only edits.
      if (d.stock_quantity !== o.stock_quantity) {
        fields.stock_status = d.stock_status;
        fields.manage_stock = d.manage_stock;
      }
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

  const idsForPush = selectedIds.length ? selectedIds : dirtyIds;

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

        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="SKU or name…"
            className="h-8 w-56 pl-7 text-xs"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-[10px]">
            {selectedIds.length || dirtyIds.length} pending
          </Badge>
          <Button variant="outline" size="sm" onClick={() => setShowBackups(true)}>
            <History className="mr-1.5 h-3.5 w-3.5" /> Backups
          </Button>
          <Button variant="outline" size="sm" onClick={sync} disabled={!siteId}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Sync from WC
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
      <div className="overflow-auto border border-t-0 rounded-b-lg">
        {(products.isLoading || inventory.isLoading) ? (
          <div className="grid h-64 place-items-center text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : siteProducts.length === 0 ? (
          <div className="grid h-64 place-items-center text-sm text-muted-foreground">
            No products yet. Click <strong className="mx-1">Sync from WC</strong> to import.
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-10 bg-card">
              <tr>
                <th className="w-8 border-b px-2 py-2 text-left">
                  <Checkbox
                    checked={selected.size > 0 && selected.size === filteredProducts.length}
                    onCheckedChange={(v) => {
                      if (v) setSelected(new Set(filteredProducts.map((p) => p.id)));
                      else setSelected(new Set());
                    }}
                  />
                </th>
                <th className="w-8 border-b px-1 py-2"></th>
                <th className="border-b px-2 py-2 text-left">SKU</th>
                <th className="border-b px-2 py-2 text-left">Name</th>
                <th className="border-b px-2 py-2 text-right">Regular</th>
                <th className="border-b px-2 py-2 text-right">Sale</th>
                <th className="border-b px-2 py-2 text-right">Stock</th>
                <th className="border-b px-2 py-2 text-left">Status</th>
                <th className="border-b px-2 py-2 text-center">Manage</th>
                <th className="border-b px-2 py-2 text-right">Weight</th>
                <th className="border-b px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map((p) => {
                const d = drafts[p.id];
                if (!d) return null;
                const isDirty = dirtyIds.includes(p.id);
                const isOpen = openDesc.has(p.id);
                return (
                  <>
                    <tr
                      key={p.id}
                      className={cn("group", isDirty && "bg-brand-amber-soft/40")}
                    >
                      <td className="border-b px-2 py-1">
                        <Checkbox
                          checked={selected.has(p.id)}
                          onCheckedChange={() => toggleSel(p.id)}
                        />
                      </td>
                      <td className="border-b px-1 py-1">
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
                      </td>
                      <td className="border-b p-0">
                        <Input
                          value={d.sku}
                          onChange={(e) => updateDraft(p.id, { sku: e.target.value })}
                          className="h-7 rounded-none border-0 font-mono text-xs focus-visible:ring-1"
                        />
                      </td>
                      <td className="border-b p-0">
                        <Input
                          value={d.name}
                          onChange={(e) => updateDraft(p.id, { name: e.target.value })}
                          className="h-7 min-w-[180px] rounded-none border-0 text-xs focus-visible:ring-1"
                        />
                      </td>
                      <td className="border-b p-0">
                        <Input
                          value={d.regular_price}
                          onChange={(e) => updateDraft(p.id, { regular_price: e.target.value })}
                          inputMode="decimal"
                          className="h-7 w-20 rounded-none border-0 text-right font-mono text-xs focus-visible:ring-1"
                        />
                      </td>
                      <td className="border-b p-0">
                        <Input
                          value={d.sale_price}
                          onChange={(e) => updateDraft(p.id, { sale_price: e.target.value })}
                          inputMode="decimal"
                          className="h-7 w-20 rounded-none border-0 text-right font-mono text-xs focus-visible:ring-1"
                        />
                      </td>
                      <td className="border-b p-0">
                        <Input
                          value={d.stock_quantity}
                          onChange={(e) => updateDraft(p.id, { stock_quantity: e.target.value })}
                          inputMode="numeric"
                          className="h-7 w-20 rounded-none border-0 text-right font-mono text-xs focus-visible:ring-1"
                        />
                      </td>
                      <td className="border-b p-0">
                        <Select
                          value={d.stock_status}
                          onValueChange={(v) => updateDraft(p.id, { stock_status: v })}
                        >
                          <SelectTrigger className="h-7 rounded-none border-0 text-xs focus-visible:ring-1">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="instock">In stock</SelectItem>
                            <SelectItem value="outofstock">Out of stock</SelectItem>
                            <SelectItem value="onbackorder">Backorder</SelectItem>
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="border-b px-2 py-1 text-center">
                        <Checkbox
                          checked={d.manage_stock}
                          onCheckedChange={(v) => updateDraft(p.id, { manage_stock: !!v })}
                        />
                      </td>
                      <td className="border-b p-0">
                        <Input
                          value={d.weight}
                          onChange={(e) => updateDraft(p.id, { weight: e.target.value })}
                          inputMode="decimal"
                          className="h-7 w-16 rounded-none border-0 text-right font-mono text-xs focus-visible:ring-1"
                        />
                      </td>
                      <td className="border-b px-2 py-1 text-right">
                        {isDirty && (
                          <Badge variant="outline" className="text-[10px] border-brand-amber text-brand-amber">
                            edited
                          </Badge>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${p.id}-desc`} className={cn(isDirty && "bg-brand-amber-soft/40")}>
                        <td colSpan={11} className="border-b bg-muted/20 px-3 py-2">
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
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

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
