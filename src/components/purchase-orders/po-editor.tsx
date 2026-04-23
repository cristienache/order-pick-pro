// Shared editor used by both /purchase-orders/new and the draft-edit view on
// /purchase-orders/$id. Pure presentational — parents own state + actions.
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, Send } from "lucide-react";
import type { PoLineInput, Supplier } from "@/lib/purchase-orders-api";
import type { Product, Warehouse } from "@/lib/inventory-api";

type Props = {
  mode: "create" | "edit";
  title: string;
  suppliers: Supplier[];
  warehouses: Warehouse[];
  products: Product[];
  supplierId: string; setSupplierId: (v: string) => void;
  warehouseId: string; setWarehouseId: (v: string) => void;
  currency: string; setCurrency: (v: string) => void;
  expectedAt: string; setExpectedAt: (v: string) => void;
  notes: string; setNotes: (v: string) => void;
  shipping: number; setShipping: (v: number) => void;
  taxRate: number; setTaxRate: (v: number) => void;
  lines: PoLineInput[]; setLines: (v: PoLineInput[]) => void;
  saving: boolean;
  onSaveDraft?: () => void;
  onSaveAndSend?: () => void;
};

export function PoEditor(p: Props) {
  const updateLine = (idx: number, patch: Partial<PoLineInput>) => {
    const next = p.lines.slice();
    next[idx] = { ...next[idx], ...patch };
    p.setLines(next);
  };
  const addLine = () => {
    p.setLines([...p.lines, { name: "", sku: "", quantity: 1, unit_cost: 0 }]);
  };
  const removeLine = (idx: number) => {
    const next = p.lines.slice();
    next.splice(idx, 1);
    p.setLines(next);
  };
  const pickProduct = (idx: number, productId: string) => {
    const product = p.products.find((pp) => pp.id === productId);
    if (!product) return;
    updateLine(idx, {
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      unit_cost: p.lines[idx]?.unit_cost || product.base_price,
    });
  };

  const subtotal = p.lines.reduce(
    (s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_cost) || 0), 0,
  );
  const tax = subtotal * (p.taxRate || 0);
  const total = subtotal + tax + (p.shipping || 0);

  return (
    <div className="space-y-4">
      {p.title && (
        <div>
          <h1 className="text-base font-semibold">{p.title}</h1>
          <p className="text-xs text-muted-foreground">
            Build the PO, save as draft, then send when ready. Receiving against a sent PO updates inventory.
          </p>
        </div>
      )}

      <Card className="p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <Label className="text-xs">Supplier</Label>
          <Select value={p.supplierId} onValueChange={p.setSupplierId}>
            <SelectTrigger><SelectValue placeholder="Pick supplier" /></SelectTrigger>
            <SelectContent>
              {p.suppliers.length === 0 && (
                <div className="px-3 py-2 text-xs text-muted-foreground">No suppliers — add one first.</div>
              )}
              {p.suppliers.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Warehouse (receive into)</Label>
          <Select value={p.warehouseId} onValueChange={p.setWarehouseId}>
            <SelectTrigger><SelectValue placeholder="Pick warehouse" /></SelectTrigger>
            <SelectContent>
              {p.warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>{w.name} ({w.code})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Currency</Label>
          <Input value={p.currency} onChange={(e) => p.setCurrency(e.target.value.toUpperCase().slice(0, 6))} />
        </div>
        <div>
          <Label className="text-xs">Expected delivery</Label>
          <Input type="date" value={p.expectedAt?.slice(0, 10) ?? ""} onChange={(e) => p.setExpectedAt(e.target.value)} />
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">Line items</h2>
          <Button size="sm" variant="outline" onClick={addLine}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add line
          </Button>
        </div>
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-xs table-fixed">
            <colgroup>
              <col style={{ width: "26%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "auto" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "40px" }} />
            </colgroup>
            <thead className="bg-muted/60 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
              <tr>
                <th className="px-2 py-2">Product</th>
                <th className="px-2 py-2">SKU</th>
                <th className="px-2 py-2">Description</th>
                <th className="px-2 py-2 text-right">Qty</th>
                <th className="px-2 py-2 text-right">Unit cost</th>
                <th className="px-2 py-2 text-right">Line total</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {p.lines.map((l, idx) => (
                <tr key={idx} className="align-middle">
                  <td className="px-2 py-1.5">
                    <Select
                      value={l.product_id ?? ""}
                      onValueChange={(v) => pickProduct(idx, v)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Free text" />
                      </SelectTrigger>
                      <SelectContent>
                        {p.products.map((prod) => (
                          <SelectItem key={prod.id} value={prod.id}>
                            {prod.name} <span className="text-muted-foreground">({prod.sku})</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      className="h-8" value={l.sku ?? ""}
                      onChange={(e) => updateLine(idx, { sku: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      className="h-8" value={l.name ?? ""}
                      onChange={(e) => updateLine(idx, { name: e.target.value })}
                      placeholder="Item description"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      className="h-8 text-right" type="number" min={0}
                      value={l.quantity}
                      onChange={(e) => updateLine(idx, { quantity: Number(e.target.value || 0) })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      className="h-8 text-right" type="number" min={0} step={0.01}
                      value={l.unit_cost}
                      onChange={(e) => updateLine(idx, { unit_cost: Number(e.target.value || 0) })}
                    />
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {((Number(l.quantity) || 0) * (Number(l.unit_cost) || 0)).toFixed(2)}
                  </td>
                  <td className="px-1 py-1.5 text-right">
                    <Button size="sm" variant="ghost" onClick={() => removeLine(idx)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-4">
          <Label className="text-xs">Notes</Label>
          <Textarea
            rows={5} value={p.notes}
            onChange={(e) => p.setNotes(e.target.value)}
            placeholder="Internal or supplier-facing notes…"
          />
        </Card>
        <Card className="p-4 space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Shipping cost</Label>
              <Input
                type="number" min={0} step={0.01} value={p.shipping}
                onChange={(e) => p.setShipping(Number(e.target.value || 0))}
              />
            </div>
            <div>
              <Label className="text-xs">Tax rate (e.g. 0.20)</Label>
              <Input
                type="number" min={0} max={1} step={0.01} value={p.taxRate}
                onChange={(e) => p.setTaxRate(Number(e.target.value || 0))}
              />
            </div>
          </div>
          <div className="border-t pt-2 mt-2 space-y-1 tabular-nums">
            <Row label="Subtotal" value={`${p.currency} ${subtotal.toFixed(2)}`} />
            <Row label={`Tax (${Math.round((p.taxRate || 0) * 100)}%)`} value={`${p.currency} ${tax.toFixed(2)}`} />
            <Row label="Shipping" value={`${p.currency} ${(p.shipping || 0).toFixed(2)}`} />
            <div className="border-t pt-1 font-semibold">
              <Row label="Total" value={`${p.currency} ${total.toFixed(2)}`} />
            </div>
          </div>
        </Card>
      </div>

      {(p.onSaveDraft || p.onSaveAndSend) && (
        <div className="flex items-center justify-end gap-2">
          {p.onSaveDraft && (
            <Button variant="outline" onClick={p.onSaveDraft} disabled={p.saving}>
              Save draft
            </Button>
          )}
          {p.onSaveAndSend && (
            <Button onClick={p.onSaveAndSend} disabled={p.saving}>
              <Send className="h-3.5 w-3.5 mr-1.5" /> Save &amp; send
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}
