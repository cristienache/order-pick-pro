// Bulk-edit popover for the WooCommerce inventory grid.
//
// Lets the user apply a single operation (set price, +%, -%, +amt, -amt,
// round, set stock, set status, find/replace name) to ALL selected rows in
// one click. The parent owns the draft state; this panel only emits the
// computed patch via onApply.

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Wand2 } from "lucide-react";

export type TextField = "name" | "description";
export type TextMode = "find" | "prepend" | "append" | "upper" | "lower";

export type BulkOp =
  | { kind: "price"; field: "regular_price" | "sale_price"; mode: "set" | "incPct" | "decPct" | "incAmt" | "decAmt" | "round" | "clear"; value: number }
  | { kind: "stock"; mode: "set" | "inc" | "dec"; value: number }
  | { kind: "status"; value: string }
  | { kind: "manage"; value: boolean }
  | { kind: "weight"; value: number }
  | { kind: "text"; field: TextField; mode: TextMode; find: string; replace: string };

export function WcBulkPanel({
  selectedCount,
  onApply,
}: {
  selectedCount: number;
  onApply: (op: BulkOp) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("price");

  // Price tab
  const [priceField, setPriceField] = useState<"regular_price" | "sale_price">("regular_price");
  const [priceMode, setPriceMode] = useState<"set" | "incPct" | "decPct" | "incAmt" | "decAmt" | "round" | "clear">("set");
  const [priceValue, setPriceValue] = useState("");

  // Stock tab
  const [stockMode, setStockMode] = useState<"set" | "inc" | "dec">("set");
  const [stockValue, setStockValue] = useState("");

  // Status / manage tab
  const [statusValue, setStatusValue] = useState("instock");
  const [manageValue, setManageValue] = useState<"true" | "false">("true");

  // Text operations (find/replace, prepend, append, upper, lower)
  const [textField, setTextField] = useState<TextField>("name");
  const [textMode, setTextMode] = useState<TextMode>("find");
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");

  // Weight
  const [weightValue, setWeightValue] = useState("");

  const close = () => setOpen(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={selectedCount === 0}>
          <Wand2 className="mr-1.5 h-3.5 w-3.5" />
          Bulk edit{selectedCount > 0 && ` (${selectedCount})`}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-3" align="end">
        <div className="mb-2 flex items-baseline justify-between">
          <h4 className="text-sm font-semibold">Bulk edit selected</h4>
          <span className="text-[11px] text-muted-foreground">{selectedCount} row{selectedCount === 1 ? "" : "s"}</span>
        </div>
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="grid w-full grid-cols-5 h-8">
            <TabsTrigger value="price" className="text-[11px]">Price</TabsTrigger>
            <TabsTrigger value="stock" className="text-[11px]">Stock</TabsTrigger>
            <TabsTrigger value="status" className="text-[11px]">Status</TabsTrigger>
            <TabsTrigger value="weight" className="text-[11px]">Weight</TabsTrigger>
            <TabsTrigger value="text" className="text-[11px]">Text</TabsTrigger>
          </TabsList>

          <TabsContent value="price" className="space-y-2 pt-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[10px]">Field</Label>
                <Select
                  value={priceField}
                  onValueChange={(v) => {
                    const f = v as typeof priceField;
                    setPriceField(f);
                    // "clear" only makes sense for sale_price — reset mode if user switches away.
                    if (f === "regular_price" && priceMode === "clear") setPriceMode("set");
                  }}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="regular_price">Regular price</SelectItem>
                    <SelectItem value="sale_price">Sale price</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[10px]">Operation</Label>
                <Select value={priceMode} onValueChange={(v) => setPriceMode(v as typeof priceMode)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="set">Set to…</SelectItem>
                    <SelectItem value="incPct">Increase by %</SelectItem>
                    <SelectItem value="decPct">Decrease by %</SelectItem>
                    <SelectItem value="incAmt">Increase by amount</SelectItem>
                    <SelectItem value="decAmt">Decrease by amount</SelectItem>
                    <SelectItem value="round">Round to .99</SelectItem>
                    {priceField === "sale_price" && (
                      <SelectItem value="clear">Clear sale price</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {priceMode !== "round" && priceMode !== "clear" && (
              <div>
                <Label className="text-[10px]">Value</Label>
                <Input
                  value={priceValue}
                  onChange={(e) => setPriceValue(e.target.value)}
                  inputMode="decimal"
                  placeholder={priceMode === "set" ? "19.99" : priceMode.includes("Pct") ? "10" : "5.00"}
                  className="h-8 text-xs font-mono"
                />
              </div>
            )}
            {priceMode === "clear" && (
              <p className="text-[11px] text-muted-foreground">
                Removes the sale price on the selected rows. Save locally, then push to WooCommerce to apply.
              </p>
            )}
            <Button
              size="sm" className="w-full"
              onClick={() => {
                onApply({
                  kind: "price",
                  field: priceMode === "clear" ? "sale_price" : priceField,
                  mode: priceMode,
                  value: Number(priceValue) || 0,
                });
                close();
              }}
            >
              {priceMode === "clear"
                ? `Clear sale price on ${selectedCount} row${selectedCount === 1 ? "" : "s"}`
                : `Apply to ${selectedCount} row${selectedCount === 1 ? "" : "s"}`}
            </Button>
          </TabsContent>

          <TabsContent value="stock" className="space-y-2 pt-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[10px]">Operation</Label>
                <Select value={stockMode} onValueChange={(v) => setStockMode(v as typeof stockMode)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="set">Set to…</SelectItem>
                    <SelectItem value="inc">Add</SelectItem>
                    <SelectItem value="dec">Subtract</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[10px]">Quantity</Label>
                <Input
                  value={stockValue}
                  onChange={(e) => setStockValue(e.target.value)}
                  inputMode="numeric"
                  placeholder="0"
                  className="h-8 text-xs font-mono"
                />
              </div>
            </div>
            <Button
              size="sm" className="w-full"
              onClick={() => {
                onApply({ kind: "stock", mode: stockMode, value: Number(stockValue) || 0 });
                close();
              }}
            >
              Apply to {selectedCount} row{selectedCount === 1 ? "" : "s"}
            </Button>
          </TabsContent>

          <TabsContent value="status" className="space-y-2 pt-2">
            <div>
              <Label className="text-[10px]">Stock status</Label>
              <Select value={statusValue} onValueChange={setStatusValue}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="instock">In stock</SelectItem>
                  <SelectItem value="outofstock">Out of stock</SelectItem>
                  <SelectItem value="onbackorder">Backorder</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" className="w-full" onClick={() => { onApply({ kind: "status", value: statusValue }); close(); }}>
              Set status on {selectedCount} row{selectedCount === 1 ? "" : "s"}
            </Button>
            <div className="border-t pt-2">
              <Label className="text-[10px]">Manage stock</Label>
              <Select value={manageValue} onValueChange={(v) => setManageValue(v as "true" | "false")}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Enabled</SelectItem>
                  <SelectItem value="false">Disabled</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" className="mt-2 w-full" onClick={() => { onApply({ kind: "manage", value: manageValue === "true" }); close(); }}>
                Toggle manage stock
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="weight" className="space-y-2 pt-2">
            <div>
              <Label className="text-[10px]">Weight (kg)</Label>
              <Input
                value={weightValue}
                onChange={(e) => setWeightValue(e.target.value)}
                inputMode="decimal"
                placeholder="0.50"
                className="h-8 text-xs font-mono"
              />
            </div>
            <Button size="sm" className="w-full" onClick={() => { onApply({ kind: "weight", value: Number(weightValue) || 0 }); close(); }}>
              Set weight on {selectedCount} row{selectedCount === 1 ? "" : "s"}
            </Button>
          </TabsContent>

          <TabsContent value="text" className="space-y-2 pt-2">
            <div>
              <Label className="text-[10px]">Field</Label>
              <Select value={findField} onValueChange={(v) => setFindField(v as typeof findField)}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="name">Product name</SelectItem>
                  <SelectItem value="description">Description</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[10px]">Find</Label>
                <Input value={findText} onChange={(e) => setFindText(e.target.value)} className="h-8 text-xs" />
              </div>
              <div>
                <Label className="text-[10px]">Replace with</Label>
                <Input value={replaceText} onChange={(e) => setReplaceText(e.target.value)} className="h-8 text-xs" />
              </div>
            </div>
            <Button
              size="sm" className="w-full" disabled={!findText}
              onClick={() => { onApply({ kind: "find", field: findField, find: findText, replace: replaceText }); close(); }}
            >
              Replace in {selectedCount} row{selectedCount === 1 ? "" : "s"}
            </Button>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
