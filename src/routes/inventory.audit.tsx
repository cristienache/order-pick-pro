import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useState, useMemo } from "react";
import { Search, AlertCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { omsApi } from "@/lib/inventory-api";

export const Route = createFileRoute("/inventory/audit")({
  head: () => ({ meta: [{ title: "Inventory audit — HeyShop" }] }),
  component: AuditPage,
});

function AuditPage() {
  const audit = useQuery({ queryKey: ["oms-audit"], queryFn: () => omsApi.audit.list({ limit: 500 }) });
  const products = useQuery({ queryKey: ["oms-products"], queryFn: () => omsApi.catalog.listProducts() });
  const warehouses = useQuery({ queryKey: ["oms-warehouses"], queryFn: () => omsApi.catalog.listWarehouses() });

  const [q, setQ] = useState("");

  const productMap = useMemo(() => {
    const m = new Map<string, { sku: string; name: string }>();
    products.data?.forEach((p) => m.set(p.id, { sku: p.sku, name: p.name }));
    return m;
  }, [products.data]);
  const whMap = useMemo(() => {
    const m = new Map<string, string>();
    warehouses.data?.forEach((w) => m.set(w.id, w.code));
    return m;
  }, [warehouses.data]);

  const rows = useMemo(() => {
    if (!audit.data) return [];
    if (!q) return audit.data;
    const term = q.toLowerCase();
    return audit.data.filter((r) => {
      const p = productMap.get(r.product_id);
      return (
        r.reason.toLowerCase().includes(term) ||
        (p?.sku.toLowerCase().includes(term) ?? false) ||
        (p?.name.toLowerCase().includes(term) ?? false) ||
        (whMap.get(r.warehouse_id)?.toLowerCase().includes(term) ?? false)
      );
    });
  }, [audit.data, q, productMap, whMap]);

  if (audit.error) {
    return (
      <div className="rounded-lg border border-brand-amber/40 bg-brand-amber-soft p-4 text-sm">
        <div className="flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 text-brand-amber" />
          <div>
            <p className="font-semibold">Audit endpoint not available yet.</p>
            <p className="text-muted-foreground mt-1">Implement <code className="font-mono">GET /api/oms/inventory/audit</code> on the HeyShop server.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">Inventory audit log</h1>
          <p className="text-xs text-muted-foreground">Last 500 stock changes.</p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="h-8 w-64 pl-7 text-xs" />
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/60 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Warehouse</th>
              <th className="px-3 py-2 text-right">Δ</th>
              <th className="px-3 py-2 text-right">New</th>
              <th className="px-3 py-2">Reason</th>
              <th className="px-3 py-2">Source</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((r) => {
              const p = productMap.get(r.product_id);
              return (
                <tr key={r.id} className="border-t hover:bg-muted/30">
                  <td className="px-3 py-1.5 text-muted-foreground">{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</td>
                  <td className="px-3 py-1.5">
                    <span className="font-medium">{p?.sku ?? "?"}</span>{" "}
                    <span className="text-muted-foreground">{p?.name}</span>
                  </td>
                  <td className="px-3 py-1.5">{whMap.get(r.warehouse_id) ?? "?"}</td>
                  <td className={`px-3 py-1.5 text-right ${r.delta > 0 ? "text-brand-emerald" : "text-destructive"}`}>
                    {r.delta > 0 ? "+" : ""}{r.delta}
                  </td>
                  <td className="px-3 py-1.5 text-right">{r.new_qty}</td>
                  <td className="px-3 py-1.5"><Badge variant="outline" className="font-mono text-[10px]">{r.reason}</Badge></td>
                  <td className="px-3 py-1.5 text-muted-foreground">{r.source}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No audit rows.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
