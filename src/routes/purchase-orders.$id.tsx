import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { poApi, PO_STATUS_LABEL, type PoLineInput, type PoStatus } from "@/lib/purchase-orders-api";
import { omsApi } from "@/lib/inventory-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { PoEditor } from "@/components/purchase-orders/po-editor";
import { Download, Send, X, Truck, ArrowLeft } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/purchase-orders/$id")({
  head: () => ({ meta: [{ title: "Purchase order — HeyShop" }] }),
  component: PoDetailPage,
});

const STATUS_TONE: Record<PoStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  sent: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  partial: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  received: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  cancelled: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
};

function PoDetailPage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const po = useQuery({ queryKey: ["po", id], queryFn: () => poApi.pos.get(id) });
  const suppliers = useQuery({ queryKey: ["po-suppliers"], queryFn: () => poApi.suppliers.list() });
  const warehouses = useQuery({ queryKey: ["oms-warehouses"], queryFn: () => omsApi.catalog.listWarehouses() });
  const products = useQuery({ queryKey: ["oms-products"], queryFn: () => omsApi.catalog.listProducts() });

  const [supplierId, setSupplierId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [currency, setCurrency] = useState("GBP");
  const [expectedAt, setExpectedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [shipping, setShipping] = useState(0);
  const [taxRate, setTaxRate] = useState(0);
  const [lines, setLines] = useState<PoLineInput[]>([]);
  const [saving, setSaving] = useState(false);

  const [receiving, setReceiving] = useState(false);
  const [receiveQty, setReceiveQty] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!po.data) return;
    setSupplierId(po.data.supplier_id);
    setWarehouseId(po.data.warehouse_id ?? "");
    setCurrency(po.data.currency);
    setExpectedAt(po.data.expected_at ?? "");
    setNotes(po.data.notes ?? "");
    setShipping(po.data.shipping_cost);
    setTaxRate(po.data.tax_rate);
    setLines(po.data.lines.map((l) => ({
      id: l.id, product_id: l.product_id, sku: l.sku, name: l.name,
      quantity: l.quantity, unit_cost: l.unit_cost,
    })));
  }, [po.data]);

  const isDraft = po.data?.status === "draft";
  const canReceive = po.data && (po.data.status === "sent" || po.data.status === "partial");

  const remainingByLine = useMemo(() => {
    const m: Record<string, number> = {};
    for (const l of po.data?.lines ?? []) {
      m[l.id] = Math.max(0, l.quantity - l.received_quantity);
    }
    return m;
  }, [po.data]);

  const saveDraft = async () => {
    if (!po.data) return;
    setSaving(true);
    try {
      await poApi.pos.update(po.data.id, {
        supplier_id: supplierId,
        warehouse_id: warehouseId || null,
        currency, expected_at: expectedAt || null, notes: notes || null,
        shipping_cost: shipping, tax_rate: taxRate,
        lines: lines.filter((l) => (l.name || l.sku) && l.quantity > 0),
      });
      toast.success("Draft saved");
      qc.invalidateQueries({ queryKey: ["po", id] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setSaving(false); }
  };

  const sendPo = async () => {
    if (!po.data) return;
    setSaving(true);
    try {
      await saveDraft();
      await poApi.pos.send(po.data.id);
      toast.success("Sent to supplier");
      qc.invalidateQueries({ queryKey: ["po", id] });
    } catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const cancelPo = async () => {
    if (!po.data) return;
    try {
      await poApi.pos.cancel(po.data.id);
      toast.success("PO cancelled");
      qc.invalidateQueries({ queryKey: ["po", id] });
    } catch (e) { toast.error((e as Error).message); }
  };

  const downloadPdf = async () => {
    if (!po.data) return;
    try {
      const blob = await poApi.pos.pdfBlob(po.data.id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { toast.error((e as Error).message); }
  };

  const submitReceive = async () => {
    if (!po.data) return;
    const receipts = Object.entries(receiveQty)
      .map(([line_id, q]) => ({ line_id, quantity: Math.max(0, Math.floor(q || 0)) }))
      .filter((r) => r.quantity > 0);
    if (!receipts.length) { toast.error("Enter at least one received quantity"); return; }
    setReceiving(true);
    try {
      await poApi.pos.receive(po.data.id, { receipts });
      toast.success("Stock received and inventory updated");
      setReceiveQty({});
      qc.invalidateQueries({ queryKey: ["po", id] });
      qc.invalidateQueries({ queryKey: ["oms-inventory"] });
    } catch (e) { toast.error((e as Error).message); }
    finally { setReceiving(false); }
  };

  if (po.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (po.error || !po.data) {
    return (
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-3">
          <Link to="/purchase-orders"><ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back</Link>
        </Button>
        <p className="text-sm text-destructive">Couldn't load this PO.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/purchase-orders"><ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back</Link>
          </Button>
          <div>
            <h1 className="text-base font-semibold flex items-center gap-2">
              <span className="font-mono">{po.data.po_number}</span>
              <Badge className={STATUS_TONE[po.data.status]} variant="secondary">
                {PO_STATUS_LABEL[po.data.status]}
              </Badge>
            </h1>
            <p className="text-xs text-muted-foreground">
              {po.data.supplier?.name} · created {new Date(po.data.created_at).toLocaleDateString("en-GB")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={downloadPdf}>
            <Download className="h-3.5 w-3.5 mr-1.5" /> Print PDF
          </Button>
          {isDraft && (
            <>
              <Button size="sm" variant="outline" onClick={saveDraft} disabled={saving}>
                Save draft
              </Button>
              <Button size="sm" onClick={sendPo} disabled={saving}>
                <Send className="h-3.5 w-3.5 mr-1.5" /> Send to supplier
              </Button>
            </>
          )}
          {po.data.status !== "received" && po.data.status !== "cancelled" && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost">
                  <X className="h-3.5 w-3.5 mr-1" /> Cancel
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Cancel this PO?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Cancelling won't undo any stock you've already received against it.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep open</AlertDialogCancel>
                  <AlertDialogAction onClick={cancelPo}>Cancel PO</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {isDraft ? (
        <PoEditor
          mode="edit"
          title=""
          suppliers={suppliers.data ?? []}
          warehouses={warehouses.data ?? []}
          products={products.data ?? []}
          supplierId={supplierId} setSupplierId={setSupplierId}
          warehouseId={warehouseId} setWarehouseId={setWarehouseId}
          currency={currency} setCurrency={setCurrency}
          expectedAt={expectedAt} setExpectedAt={setExpectedAt}
          notes={notes} setNotes={setNotes}
          shipping={shipping} setShipping={setShipping}
          taxRate={taxRate} setTaxRate={setTaxRate}
          lines={lines} setLines={setLines}
          saving={saving}
        />
      ) : (
        <ReadOnlyView po={po.data} />
      )}

      {canReceive && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Truck className="h-4 w-4" /> Receive stock
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Enter what arrived. Linked products are added to inventory at{" "}
            <strong>{po.data.warehouse?.name ?? "(no warehouse set on PO)"}</strong>.
          </p>
          <div className="mt-3 overflow-hidden rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/60 text-left">
                <tr>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2 text-right">Ordered</th>
                  <th className="px-3 py-2 text-right">Already received</th>
                  <th className="px-3 py-2 text-right">Outstanding</th>
                  <th className="px-3 py-2 w-32">Receive now</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {po.data.lines.map((l) => {
                  const remaining = remainingByLine[l.id];
                  return (
                    <tr key={l.id}>
                      <td className="px-3 py-2 font-mono">{l.sku ?? "—"}</td>
                      <td className="px-3 py-2">{l.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{l.received_quantity}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{remaining}</td>
                      <td className="px-3 py-2">
                        <Input
                          type="number" min={0} max={remaining} className="h-8"
                          value={receiveQty[l.id] ?? ""}
                          onChange={(e) => setReceiveQty({
                            ...receiveQty, [l.id]: Number(e.target.value || 0),
                          })}
                          disabled={remaining <= 0}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              size="sm" variant="ghost"
              onClick={() => {
                const all: Record<string, number> = {};
                for (const l of po.data!.lines) all[l.id] = remainingByLine[l.id];
                setReceiveQty(all);
              }}
            >
              Receive all outstanding
            </Button>
            <Button size="sm" onClick={submitReceive} disabled={receiving}>
              <Truck className="h-3.5 w-3.5 mr-1.5" /> Confirm receipt
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function ReadOnlyView({ po }: { po: NonNullable<ReturnType<typeof usePo>> }) {
  return (
    <Card className="p-4 space-y-4">
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <Label className="text-xs text-muted-foreground">Supplier</Label>
          <p className="font-medium">{po.supplier?.name}</p>
          <p className="text-xs text-muted-foreground whitespace-pre-line">
            {[po.supplier?.address_line1, po.supplier?.city, po.supplier?.country]
              .filter(Boolean).join(", ")}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Meta label="Warehouse" value={po.warehouse?.name ?? "—"} />
          <Meta label="Currency" value={po.currency} />
          <Meta label="Expected" value={po.expected_at ? new Date(po.expected_at).toLocaleDateString("en-GB") : "—"} />
          <Meta label="Tax rate" value={`${Math.round(po.tax_rate * 100)}%`} />
        </div>
      </div>
      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/60 text-left">
            <tr>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Unit cost</th>
              <th className="px-3 py-2 text-right">Line total</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {po.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-3 py-2 font-mono">{l.sku ?? "—"}</td>
                <td className="px-3 py-2">{l.name}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.unit_cost.toFixed(2)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {(l.quantity * l.unit_cost).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end">
        <div className="w-72 text-xs space-y-1">
          <Row label="Subtotal" value={`${po.currency} ${po.totals.subtotal.toFixed(2)}`} />
          <Row label={`Tax (${Math.round(po.tax_rate * 100)}%)`} value={`${po.currency} ${po.totals.tax.toFixed(2)}`} />
          <Row label="Shipping" value={`${po.currency} ${po.totals.shipping.toFixed(2)}`} />
          <div className="border-t pt-1 mt-1 font-semibold text-sm">
            <Row label="Total" value={`${po.currency} ${po.totals.total.toFixed(2)}`} />
          </div>
        </div>
      </div>
      {po.notes && (
        <div>
          <Label className="text-xs text-muted-foreground">Notes</Label>
          <p className="text-sm whitespace-pre-line">{po.notes}</p>
        </div>
      )}
    </Card>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between tabular-nums">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}
type usePo = ReturnType<typeof poApi.pos.get> extends Promise<infer T> ? T : never;
