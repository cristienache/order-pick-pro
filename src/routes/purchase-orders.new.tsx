import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { poApi, type PoLineInput } from "@/lib/purchase-orders-api";
import { omsApi } from "@/lib/inventory-api";
import { PoEditor } from "@/components/purchase-orders/po-editor";
import { toast } from "sonner";

export const Route = createFileRoute("/purchase-orders/new")({
  head: () => ({ meta: [{ title: "New Purchase Order — HeyShop" }] }),
  component: NewPoPage,
});

function NewPoPage() {
  const navigate = useNavigate();
  const suppliers = useQuery({ queryKey: ["po-suppliers"], queryFn: () => poApi.suppliers.list() });
  const warehouses = useQuery({ queryKey: ["oms-warehouses"], queryFn: () => omsApi.catalog.listWarehouses() });
  const products = useQuery({ queryKey: ["oms-products"], queryFn: () => omsApi.catalog.listProducts() });

  const [supplierId, setSupplierId] = useState<string>("");
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [currency, setCurrency] = useState("GBP");
  const [expectedAt, setExpectedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [shipping, setShipping] = useState(0);
  const [taxRate, setTaxRate] = useState(0);
  const [lines, setLines] = useState<PoLineInput[]>([
    { name: "", sku: "", quantity: 1, unit_cost: 0 },
  ]);
  const [saving, setSaving] = useState(false);

  const create = async (sendNow: boolean) => {
    if (!supplierId) { toast.error("Pick a supplier"); return; }
    const cleanLines = lines.filter((l) => (l.name || l.sku) && l.quantity > 0);
    if (cleanLines.length === 0) { toast.error("Add at least one line"); return; }
    setSaving(true);
    try {
      const po = await poApi.pos.create({
        supplier_id: supplierId,
        warehouse_id: warehouseId || null,
        currency,
        expected_at: expectedAt || null,
        notes: notes || null,
        shipping_cost: shipping,
        tax_rate: taxRate,
        lines: cleanLines,
      });
      if (sendNow) await poApi.pos.send(po.id);
      toast.success(sendNow ? "Purchase order sent" : "Draft saved");
      navigate({ to: "/purchase-orders/$id", params: { id: po.id } });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <PoEditor
      mode="create"
      title="New purchase order"
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
      onSaveDraft={() => create(false)}
      onSaveAndSend={() => create(true)}
    />
  );
}
