import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, Route as RouteIcon, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { omsApi, type ShipmentStatus } from "@/lib/inventory-api";

export const Route = createFileRoute("/inventory/orders")({
  head: () => ({ meta: [{ title: "Orders & routing — HeyShop" }] }),
  component: OrdersPage,
});

function OrdersPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [activeOrder, setActiveOrder] = useState<string | null>(null);

  const orders = useQuery({ queryKey: ["oms-orders"], queryFn: () => omsApi.orders.list({ limit: 100 }) });

  if (orders.error) {
    return (
      <div className="rounded-lg border border-brand-amber/40 bg-brand-amber-soft p-4 text-sm">
        <div className="flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 text-brand-amber" />
          <div>
            <p className="font-semibold">Orders endpoint not available yet.</p>
            <p className="text-muted-foreground mt-1">Implement <code className="font-mono">GET/POST /api/oms/orders</code>.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">Orders & routing</h1>
          <p className="text-xs text-muted-foreground">Greedy nearest-warehouse allocation, split shipments allowed.</p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Create order
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/60 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Address</th>
              <th className="px-3 py-2 text-right">Shipments</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 w-px" />
            </tr>
          </thead>
          <tbody className="font-mono">
            {orders.data?.map((o) => (
              <tr key={o.id} className="border-t hover:bg-muted/30">
                <td className="px-3 py-1.5 text-muted-foreground">{formatDistanceToNow(new Date(o.created_at), { addSuffix: true })}</td>
                <td className="px-3 py-1.5">{o.customer_name}</td>
                <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[300px]">{o.customer_address}</td>
                <td className="px-3 py-1.5 text-right">{o.shipment_count}</td>
                <td className="px-3 py-1.5"><StatusBadge s={o.status} /></td>
                <td className="px-3 py-1.5">
                  <Button variant="ghost" size="sm" onClick={() => setActiveOrder(o.id)}>Open</Button>
                </td>
              </tr>
            ))}
            {orders.data?.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No orders yet. Create one to see the router in action.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <CreateOrderSheet open={createOpen} onOpenChange={setCreateOpen} />
      <OrderDetailSheet orderId={activeOrder} onClose={() => setActiveOrder(null)} />
    </div>
  );
}

function StatusBadge({ s }: { s: string }) {
  const tone =
    s === "shipped" ? "bg-brand-emerald text-background" :
    s === "allocated" ? "bg-foreground text-background" :
    s === "partial" || s === "backorder" ? "bg-brand-amber text-background" :
    s === "cancelled" ? "bg-muted text-muted-foreground" :
    "bg-muted text-muted-foreground";
  return <Badge className={`font-mono text-[10px] uppercase ${tone}`}>{s}</Badge>;
}

function CreateOrderSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const products = useQuery({ queryKey: ["oms-products"], queryFn: () => omsApi.catalog.listProducts() });

  const [name, setName] = useState("Acme Co.");
  const [address, setAddress] = useState("Denver, CO");
  const [lat, setLat] = useState("39.7392");
  const [lng, setLng] = useState("-104.9903");
  const [lines, setLines] = useState<{ product_id: string; quantity: number }[]>([]);
  const [busy, setBusy] = useState(false);

  const addLine = () => setLines((l) => [...l, { product_id: products.data?.[0]?.id ?? "", quantity: 1 }]);
  const updLine = (i: number, patch: Partial<{ product_id: string; quantity: number }>) =>
    setLines((l) => l.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const rmLine = (i: number) => setLines((l) => l.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!name || !lines.length) {
      toast.error("Customer and at least one item required");
      return;
    }
    setBusy(true);
    try {
      const detail = await omsApi.orders.create({
        customer_name: name,
        customer_address: address,
        customer_lat: parseFloat(lat),
        customer_lng: parseFloat(lng),
        items: lines,
      });
      const shipCount = detail.shipments.length;
      const short = detail.shortfall.length;
      toast.success(`Order routed: ${shipCount} shipment(s)` + (short ? `, ${short} short` : ""));
      onOpenChange(false);
      setLines([]);
      qc.invalidateQueries({ queryKey: ["oms-orders"] });
      qc.invalidateQueries({ queryKey: ["oms-inventory"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create order");
    } finally { setBusy(false); }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Create order</SheetTitle>
          <SheetDescription>Manual entry. Routing runs immediately on submit.</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label className="text-xs">Customer name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
            </div>
            <div className="col-span-2">
              <Label className="text-xs">Address</Label>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Latitude</Label>
              <Input value={lat} onChange={(e) => setLat(e.target.value)} className="mt-1 font-mono" />
            </div>
            <div>
              <Label className="text-xs">Longitude</Label>
              <Input value={lng} onChange={(e) => setLng(e.target.value)} className="mt-1 font-mono" />
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label className="text-xs">Items</Label>
              <Button variant="outline" size="sm" onClick={addLine}>
                <Plus className="mr-1 h-3 w-3" /> Add
              </Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <Card key={i} className="flex items-center gap-2 p-2">
                  <Select value={l.product_id} onValueChange={(v) => updLine(i, { product_id: v })}>
                    <SelectTrigger className="h-8 flex-1 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {products.data?.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.sku} — {p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number" min={1} value={l.quantity}
                    onChange={(e) => updLine(i, { quantity: parseInt(e.target.value) || 1 })}
                    className="h-8 w-20 font-mono text-xs"
                  />
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => rmLine(i)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </Card>
              ))}
              {!lines.length && (
                <div className="rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
                  No items yet. Click "Add".
                </div>
              )}
            </div>
          </div>

          <Button className="w-full" onClick={submit} disabled={busy}>
            <RouteIcon className="mr-2 h-3.5 w-3.5" />
            {busy ? "Routing…" : "Route & create"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function OrderDetailSheet({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({
    enabled: !!orderId,
    queryKey: ["oms-order-detail", orderId],
    queryFn: () => omsApi.orders.detail(orderId!),
  });
  const products = useQuery({ queryKey: ["oms-products"], queryFn: () => omsApi.catalog.listProducts() });
  const warehouses = useQuery({ queryKey: ["oms-warehouses"], queryFn: () => omsApi.catalog.listWarehouses() });

  const productMap = useMemo(() => new Map(products.data?.map((p) => [p.id, p]) ?? []), [products.data]);
  const whMap = useMemo(() => new Map(warehouses.data?.map((w) => [w.id, w]) ?? []), [warehouses.data]);

  const shipItemsByShip = useMemo(() => {
    const m = new Map<string, NonNullable<typeof detail.data>["shipment_items"]>();
    detail.data?.shipment_items.forEach((si) => {
      const arr = m.get(si.shipment_id) ?? [];
      arr.push(si);
      m.set(si.shipment_id, arr);
    });
    return m;
  }, [detail.data]);

  const setShipmentStatus = async (shipId: string, status: ShipmentStatus) => {
    try {
      await omsApi.orders.setShipmentStatus(shipId, status);
      toast.success(`Shipment marked ${status}`);
      qc.invalidateQueries({ queryKey: ["oms-order-detail", orderId] });
      qc.invalidateQueries({ queryKey: ["oms-orders"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  return (
    <Sheet open={!!orderId} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Order detail</SheetTitle>
          <SheetDescription>Items, computed shipment plan, and per-shipment status.</SheetDescription>
        </SheetHeader>

        {detail.data && (
          <div className="space-y-4 py-4">
            <Card className="p-3">
              <div className="text-sm font-semibold">{detail.data.order.customer_name}</div>
              <div className="text-xs text-muted-foreground">{detail.data.order.customer_address}</div>
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                {detail.data.order.customer_lat.toFixed(4)}, {detail.data.order.customer_lng.toFixed(4)}
              </div>
              <div className="mt-2"><StatusBadge s={detail.data.order.status} /></div>
            </Card>

            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Items</h3>
              <div className="space-y-1">
                {detail.data.items.map((it) => {
                  const p = productMap.get(it.product_id);
                  return (
                    <div key={it.id} className="flex items-center justify-between rounded border px-3 py-2 font-mono text-xs">
                      <span>{p?.sku} — {p?.name}</span>
                      <span>× {it.quantity}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Shipments ({detail.data.shipments.length})
              </h3>
              <div className="space-y-2">
                {detail.data.shipments.map((s) => {
                  const w = whMap.get(s.warehouse_id);
                  const items = shipItemsByShip.get(s.id) ?? [];
                  return (
                    <Card key={s.id} className="p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="font-mono text-xs font-semibold">
                          {w?.code} <span className="font-normal text-muted-foreground">{w?.name}</span>
                        </div>
                        <Badge variant="outline" className="font-mono text-[10px] uppercase">{s.status}</Badge>
                      </div>
                      <div className="space-y-1">
                        {items.map((it) => {
                          const p = productMap.get(it.product_id);
                          return (
                            <div key={it.id} className="flex items-center justify-between font-mono text-xs">
                              <span>{p?.sku}</span>
                              <span>× {it.quantity}</span>
                            </div>
                          );
                        })}
                      </div>
                      <div className="mt-2 flex gap-1">
                        {(["allocated", "picked", "shipped"] as const).map((st) => (
                          <Button
                            key={st} size="sm"
                            variant={s.status === st ? "default" : "outline"}
                            disabled={s.status === st}
                            onClick={() => setShipmentStatus(s.id, st)}
                            className="h-7 text-[11px]"
                          >
                            {st}
                          </Button>
                        ))}
                      </div>
                    </Card>
                  );
                })}
                {detail.data.shipments.length === 0 && (
                  <div className="rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
                    No shipments — order is fully backordered.
                  </div>
                )}
              </div>
            </div>

            {detail.data.shortfall.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Shortfall</h3>
                <div className="space-y-1">
                  {detail.data.shortfall.map((sf, i) => {
                    const p = productMap.get(sf.product_id);
                    return (
                      <div key={i} className="flex items-center justify-between rounded border border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-xs">
                        <span>{p?.sku ?? sf.product_id}</span>
                        <span className="text-destructive">short × {sf.quantity}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
