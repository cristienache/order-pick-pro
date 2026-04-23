import { useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface BulkTarget {
  product_id: string;
  warehouse_id: string;
  current: number;
  productLabel: string;
  warehouseLabel: string;
}

type Op = "set" | "add" | "sub" | "mul" | "formula";

function applyOp(current: number, op: Op, value: number, formula: string): number {
  switch (op) {
    case "set": return Math.max(0, Math.round(value));
    case "add": return Math.max(0, current + Math.round(value));
    case "sub": return Math.max(0, current - Math.round(value));
    case "mul": return Math.max(0, Math.round(current * value));
    case "formula": {
      try {
        const fn = new Function("stock", `return (${formula});`);
        const out = fn(current);
        return Math.max(0, Math.round(Number(out)));
      } catch { return current; }
    }
  }
}

export function BulkEditDialog({
  open, onOpenChange, targets, onApply,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  targets: BulkTarget[];
  onApply: (updates: { product_id: string; warehouse_id: string; next: number }[]) => Promise<void>;
}) {
  const [op, setOp] = useState<Op>("add");
  const [val, setVal] = useState("10");
  const [formula, setFormula] = useState("stock + 50");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);

  const computed = useMemo(() => {
    const v = parseFloat(val) || 0;
    return targets.map((t) => ({ ...t, next: applyOp(t.current, op, v, formula) }));
  }, [targets, op, val, formula]);

  const negativeCount = computed.filter((c) => c.next < c.current && c.next === 0).length;
  const changed = computed.filter((c) => c.next !== c.current);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bulk edit stock</DialogTitle>
          <DialogDescription>
            {targets.length} cell{targets.length === 1 ? "" : "s"} selected. Apply an operation, preview, then commit.
          </DialogDescription>
        </DialogHeader>

        {!preview ? (
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Operation</Label>
                <Select value={op} onValueChange={(v) => setOp(v as Op)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="set">Set to N</SelectItem>
                    <SelectItem value="add">Add (+ N)</SelectItem>
                    <SelectItem value="sub">Subtract (− N)</SelectItem>
                    <SelectItem value="mul">Multiply (× N)</SelectItem>
                    <SelectItem value="formula">Formula (uses `stock`)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {op !== "formula" ? (
                <div>
                  <Label className="text-xs">Value</Label>
                  <Input type="number" value={val} onChange={(e) => setVal(e.target.value)} className="mt-1 font-mono" />
                </div>
              ) : (
                <div>
                  <Label className="text-xs">Formula</Label>
                  <Input value={formula} onChange={(e) => setFormula(e.target.value)} className="mt-1 font-mono" placeholder="stock + 50" />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="outline">{changed.length} cells will change</Badge>
              {negativeCount > 0 && <Badge variant="destructive">{negativeCount} clamped to 0</Badge>}
            </div>
            <ScrollArea className="h-72 rounded border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                  <tr className="text-left">
                    <th className="px-2 py-1.5">Product</th>
                    <th className="px-2 py-1.5">Warehouse</th>
                    <th className="px-2 py-1.5 text-right font-mono">Before</th>
                    <th className="px-2 py-1.5 text-right font-mono">After</th>
                    <th className="px-2 py-1.5 text-right font-mono">Δ</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {computed.map((c) => {
                    const d = c.next - c.current;
                    return (
                      <tr key={`${c.product_id}-${c.warehouse_id}`} className="border-t">
                        <td className="px-2 py-1">{c.productLabel}</td>
                        <td className="px-2 py-1">{c.warehouseLabel}</td>
                        <td className="px-2 py-1 text-right">{c.current}</td>
                        <td className="px-2 py-1 text-right">{c.next}</td>
                        <td className={`px-2 py-1 text-right ${d > 0 ? "text-emerald-600" : d < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                          {d > 0 ? "+" : ""}{d}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollArea>
          </div>
        )}

        <DialogFooter>
          {!preview ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => setPreview(true)} disabled={!changed.length}>
                Preview ({changed.length})
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setPreview(false)}>Back</Button>
              <Button
                disabled={busy || !changed.length}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onApply(changed.map((c) => ({
                      product_id: c.product_id,
                      warehouse_id: c.warehouse_id,
                      next: c.next,
                    })));
                    onOpenChange(false);
                    setPreview(false);
                  } finally { setBusy(false); }
                }}
              >
                {busy ? "Applying…" : `Apply to ${changed.length} cells`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
