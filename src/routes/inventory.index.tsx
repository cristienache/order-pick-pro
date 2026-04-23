import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { StockCell } from "@/components/inventory/stock-cell";
import { BulkEditDialog, type BulkTarget } from "@/components/inventory/bulk-edit-dialog";
import { PaginationBar, type PageSize } from "@/components/inventory/pagination-bar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Wand2, RefreshCw, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { omsApi } from "@/lib/inventory-api";
import {
  InventoryFilterBar, DEFAULT_FILTERS,
  type InventoryFilters, type SortOption,
} from "@/components/inventory/inventory-filter-bar";

export const Route = createFileRoute("/inventory/")({
  head: () => ({ meta: [{ title: "Inventory grid — HeyShop" }] }),
  component: InventoryGrid,
});

function InventoryGrid() {
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ["oms-session"], queryFn: () => omsApi.session.me() });
  const products = useQuery({ queryKey: ["oms-products"], queryFn: () => omsApi.catalog.listProducts() });
  const warehouses = useQuery({
    queryKey: ["oms-warehouses"],
    queryFn: () => omsApi.catalog.listWarehouses({ activeOnly: true }),
  });
  const inventory = useQuery({ queryKey: ["oms-inventory"], queryFn: () => omsApi.inventory.list() });

  const isAdmin = session.data?.roles.includes("admin") ?? false;
  const assignedWh = session.data?.warehouse_ids ?? [];

  const [filters, setFilters] = useState<InventoryFilters>({ ...DEFAULT_FILTERS, sortKey: "sku" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  // Pagination state. `pageSize === 0` means "All".
  const [pageSize, setPageSize] = useState<PageSize>(25);
  const [page, setPage] = useState(1);

  // Warehouses available to this user (admin = all, else only assigned).
  const userWarehouses = useMemo(() => {
    if (!warehouses.data) return [];
    return isAdmin ? warehouses.data : warehouses.data.filter((w) => assignedWh.includes(w.id));
  }, [warehouses.data, isAdmin, assignedWh]);

  // Columns shown in the grid — narrowed by the multi-warehouse filter.
  const visibleWarehouses = useMemo(() => {
    if (filters.warehouseIds.length === 0) return userWarehouses;
    return userWarehouses.filter((w) => filters.warehouseIds.includes(w.id));
  }, [userWarehouses, filters.warehouseIds]);

  const invByKey = useMemo(() => {
    const m = new Map<string, NonNullable<typeof inventory.data>[number]>();
    inventory.data?.forEach((r) => m.set(`${r.product_id}:${r.warehouse_id}`, r));
    return m;
  }, [inventory.data]);

  // Per-product helpers used by stockState filter and sorting.
  const productStock = (pid: string) => {
    let qty = 0; let low = false;
    for (const w of visibleWarehouses) {
      const r = invByKey.get(`${pid}:${w.id}`);
      if (!r) continue;
      qty += r.quantity;
      if (r.quantity <= r.reorder_level) low = true;
    }
    return { qty, low };
  };

  const filteredProducts = useMemo(() => {
    if (!products.data) return [];
    const term = filters.search.trim().toLowerCase();
    const pMin = filters.priceMin ? Number(filters.priceMin) : null;
    const pMax = filters.priceMax ? Number(filters.priceMax) : null;

    const list = products.data.filter((p) => {
      if (filters.source !== "all" && p.source !== filters.source) return false;
      if (term && !p.sku.toLowerCase().includes(term) && !p.name.toLowerCase().includes(term)) return false;
      if (pMin != null && p.base_price < pMin) return false;
      if (pMax != null && p.base_price > pMax) return false;
      if (filters.stockState !== "any") {
        const { qty, low } = productStock(p.id);
        if (filters.stockState === "out" && qty > 0) return false;
        if (filters.stockState === "inStock" && qty <= 0) return false;
        if (filters.stockState === "low" && !low) return false;
        if (filters.stockState === "over" && qty <= 100) return false;
      }
      return true;
    });

    // Sort
    const dir = filters.sortDir === "asc" ? 1 : -1;
    const totalsLocal = (pid: string) => {
      let t = 0;
      for (const w of visibleWarehouses) t += invByKey.get(`${pid}:${w.id}`)?.quantity ?? 0;
      return t;
    };
    list.sort((a, b) => {
      switch (filters.sortKey) {
        case "sku": return a.sku.localeCompare(b.sku) * dir;
        case "regular_price": return (a.base_price - b.base_price) * dir;
        case "stock_quantity": return (totalsLocal(a.id) - totalsLocal(b.id)) * dir;
        case "name":
        default: return a.name.localeCompare(b.name) * dir;
      }
    });
    return list;
  }, [products.data, filters, invByKey, visibleWarehouses]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset to page 1 whenever the filtered set shrinks/changes meaningfully.
  useEffect(() => { setPage(1); }, [filters, pageSize]);

  // Paginated slice fed to the table. `pageSize === 0` shows everything.
  const pagedProducts = useMemo(() => {
    if (pageSize === 0) return filteredProducts;
    const start = (page - 1) * pageSize;
    return filteredProducts.slice(start, start + pageSize);
  }, [filteredProducts, page, pageSize]);

  const totalsByProduct = useMemo(() => {
    const m = new Map<string, number>();
    inventory.data?.forEach((r) => m.set(r.product_id, (m.get(r.product_id) ?? 0) + r.quantity));
    return m;
  }, [inventory.data]);

  const commitCell = async (
    product_id: string, warehouse_id: string, next: number, reason = "Manual edit",
  ) => {
    const row = invByKey.get(`${product_id}:${warehouse_id}`);
    if (!row) return;
    try {
      await omsApi.inventory.updateCell({
        product_id, warehouse_id,
        next_quantity: next,
        expected_version: row.version,
        reason,
      });
      qc.invalidateQueries({ queryKey: ["oms-inventory"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  const toggleSel = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });

  const selectAllFiltered = () => {
    const n = new Set<string>();
    for (const p of filteredProducts) for (const w of visibleWarehouses) n.add(`${p.id}:${w.id}`);
    setSelected(n);
  };

  const bulkTargets: BulkTarget[] = useMemo(() => {
    const out: BulkTarget[] = [];
    for (const key of selected) {
      const [pid, wid] = key.split(":");
      const row = invByKey.get(key);
      const p = products.data?.find((x) => x.id === pid);
      const w = warehouses.data?.find((x) => x.id === wid);
      if (row && p && w) {
        out.push({
          product_id: pid, warehouse_id: wid,
          current: row.quantity,
          productLabel: p.sku, warehouseLabel: w.code,
        });
      }
    }
    return out;
  }, [selected, invByKey, products.data, warehouses.data]);

  const applyBulk = async (
    updates: { product_id: string; warehouse_id: string; next: number }[],
  ) => {
    const payload = updates
      .map((u) => {
        const row = invByKey.get(`${u.product_id}:${u.warehouse_id}`);
        if (!row) return null;
        return {
          product_id: u.product_id,
          warehouse_id: u.warehouse_id,
          next_quantity: u.next,
          expected_version: row.version,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    try {
      const result = await omsApi.inventory.bulkUpdate({ reason: "Bulk edit", updates: payload });
      const failed = result.failed.length;
      toast[failed ? "warning" : "success"](
        `Bulk: ${result.ok} updated${failed ? `, ${failed} failed` : ""}`,
      );
      qc.invalidateQueries({ queryKey: ["oms-inventory"] });
      setSelected(new Set());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk update failed");
    }
  };

  const anyError = products.error || warehouses.error || inventory.error;
  if (anyError) {
    return (
      <div className="rounded-lg border border-brand-amber/40 bg-brand-amber-soft p-4 text-sm">
        <div className="flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 text-brand-amber" />
          <div>
            <p className="font-semibold">Inventory backend not available yet.</p>
            <p className="text-muted-foreground mt-1">
              The Inventory module talks to <code className="font-mono">/api/oms/*</code> on
              the HeyShop server. See <code>docs/heyshop-api-contract.md</code> for the endpoints
              that need to be implemented.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2 border-b bg-card px-4 py-2.5 rounded-t-lg">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-2 text-sm font-semibold">Global inventory</h1>
          <InventoryFilterBar
            presetKey="oms-global"
            value={filters}
            onChange={setFilters}
            availableFields={["search", "source", "warehouse", "stockState", "priceRange"]}
            warehouseOptions={userWarehouses.map((w) => ({ id: w.id, label: `${w.code} — ${w.name}` }))}
            sortOptions={SORT_OPTIONS}
            counts={{ total: products.data?.length ?? 0, visible: filteredProducts.length }}
          />
          <div className="ml-auto flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-[10px]">{selected.size} selected</Badge>
            {selected.size > 0 && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
                <Button size="sm" onClick={() => setBulkOpen(true)}>
                  <Wand2 className="mr-1.5 h-3.5 w-3.5" /> Bulk edit
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" onClick={selectAllFiltered}>Select all</Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => qc.invalidateQueries({ queryKey: ["oms-inventory"] })}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <div className="overflow-auto border border-t-0">
        {(products.isLoading || warehouses.isLoading || inventory.isLoading) ? (
          <div className="grid h-64 place-items-center text-sm text-muted-foreground">Loading inventory…</div>
        ) : (
          <table className="w-full border-separate border-spacing-0">
            <thead className="sticky top-0 z-20 bg-card">
              <tr>
                <th className="sticky left-0 z-30 w-10 border-b border-r bg-card px-2 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  <Checkbox
                    checked={selected.size > 0 && selected.size === filteredProducts.length * visibleWarehouses.length}
                    onCheckedChange={(v) => v ? selectAllFiltered() : setSelected(new Set())}
                  />
                </th>
                <th className="sticky left-10 z-30 min-w-[260px] border-b border-r bg-card px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Product
                </th>
                {visibleWarehouses.map((w) => (
                  <th key={w.id} className="border-b border-r bg-card px-2 py-2 text-right text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                    {w.code}
                  </th>
                ))}
                <th className="border-b bg-card px-3 py-2 text-right text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {pagedProducts.map((p, rIdx) => {
                const isLowRow = visibleWarehouses.some((w) => {
                  const r = invByKey.get(`${p.id}:${w.id}`);
                  return r && r.quantity <= r.reorder_level;
                });
                return (
                  <tr key={p.id} className={cn("group h-9", isLowRow && "bg-destructive/5")}>
                    <td className="sticky left-0 z-10 h-9 w-10 border-b border-r bg-background px-2 group-hover:bg-muted/50">
                      <Checkbox
                        checked={visibleWarehouses.every((w) => selected.has(`${p.id}:${w.id}`))}
                        onCheckedChange={(v) => {
                          const n = new Set(selected);
                          for (const w of visibleWarehouses) {
                            const k = `${p.id}:${w.id}`;
                            if (v) n.add(k); else n.delete(k);
                          }
                          setSelected(n);
                        }}
                      />
                    </td>
                    <td className="sticky left-10 z-10 h-9 min-w-[260px] border-b border-r bg-background px-3 group-hover:bg-muted/50">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-medium">{p.sku}</span>
                        <span className="text-xs text-muted-foreground truncate">{p.name}</span>
                        <Badge variant="outline" className="ml-auto h-4 font-mono text-[9px] uppercase">
                          {p.source}
                        </Badge>
                      </div>
                    </td>
                    {visibleWarehouses.map((w, cIdx) => {
                      const key = `${p.id}:${w.id}`;
                      const r = invByKey.get(key);
                      const editable = isAdmin || assignedWh.includes(w.id);
                      return (
                        <td key={w.id} className={cn("h-9 border-b border-r bg-background p-0 group-hover:bg-muted/30", selected.has(key) && "bg-foreground/5")}>
                          {r ? (
                            <StockCell
                              cellId={`r${rIdx}-c${cIdx}`}
                              value={r.quantity}
                              reorder={r.reorder_level}
                              disabled={!editable}
                              onCommit={(n) => commitCell(p.id, w.id, n)}
                              selected={selected.has(key)}
                              onSelect={() => toggleSel(key)}
                            />
                          ) : (
                            <div className="flex h-9 items-center justify-end px-2 font-mono text-xs text-muted-foreground">—</div>
                          )}
                        </td>
                      );
                    })}
                    <td className="h-9 border-b bg-muted/30 px-3 text-right font-mono text-xs font-semibold align-middle">
                      {totalsByProduct.get(p.id) ?? 0}
                    </td>
                  </tr>
                );
              })}
              {filteredProducts.length === 0 && (
                <tr>
                  <td colSpan={visibleWarehouses.length + 3} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    No products match the current filters.
                  </td>
                </tr>
              )}
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

      <BulkEditDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        targets={bulkTargets}
        onApply={applyBulk}
      />
    </div>
  );
}
