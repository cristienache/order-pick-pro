import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { fetchProcessingOrders, generatePicklistPdf } from "@/lib/woocommerce.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast, Toaster } from "sonner";
import { Loader2, Download, RefreshCw, Package } from "lucide-react";

export const Route = createFileRoute("/")({
  component: PicklistPage,
  head: () => ({
    meta: [
      { title: "Ultraskins Picklist Generator" },
      { name: "description", content: "Generate pick-list PDFs from WooCommerce processing orders." },
    ],
  }),
});

type OrderRow = {
  id: number;
  number: string;
  date_created: string;
  total: string;
  currency: string;
  customer: string;
  itemCount: number;
  lineCount: number;
};

function PicklistPage() {
  const fetchOrders = useServerFn(fetchProcessingOrders);
  const generatePdf = useServerFn(generatePicklistPdf);

  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<"recent" | "oldest">("recent");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchOrders();
      setOrders(res.orders);
      setSelected(new Set(res.orders.map((o) => o.id)));
      toast.success(`Loaded ${res.orders.length} processing orders`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load orders";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [fetchOrders]);

  const filtered = useMemo(() => {
    if (!orders) return [];
    const q = search.trim().toLowerCase();
    const base = !q
      ? orders
      : orders.filter(
          (o) => o.number.toLowerCase().includes(q) || o.customer.toLowerCase().includes(q),
        );
    const sorted = [...base].sort((a, b) => {
      const ta = new Date(a.date_created).getTime();
      const tb = new Date(b.date_created).getTime();
      return sortOrder === "recent" ? tb - ta : ta - tb;
    });
    return sorted;
  }, [orders, search, sortOrder]);

  const toggleAll = (checked: boolean) => {
    if (checked) setSelected(new Set(filtered.map((o) => o.id)));
    else setSelected(new Set());
  };

  const toggleOne = (id: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleGenerate = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) {
      toast.error("Select at least one order");
      return;
    }
    setGenerating(true);
    try {
      const { base64, filename } = await generatePdf({ data: { orderIds: ids } });
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Picklist generated for ${ids.length} orders`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to generate picklist";
      toast.error(msg);
    } finally {
      setGenerating(false);
    }
  };

  const allFilteredSelected = filtered.length > 0 && filtered.every((o) => selected.has(o.id));
  const totalItems = filtered
    .filter((o) => selected.has(o.id))
    .reduce((sum, o) => sum + o.itemCount, 0);

  return (
    <div className="min-h-screen bg-background">
      <Toaster richColors position="top-right" />
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
              <Package className="h-7 w-7" /> Ultraskins Picklist
            </h1>
            <p className="text-muted-foreground mt-1">
              Pull processing orders from WooCommerce and generate a pick-list PDF.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={load} disabled={loading} variant={orders ? "outline" : "default"}>
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {orders ? "Reload" : "Load processing orders"}
            </Button>
            <Button
              onClick={handleGenerate}
              disabled={generating || selected.size === 0 || !orders}
            >
              {generating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Generate Picklist ({selected.size})
            </Button>
          </div>
        </header>

        {!orders && !loading && (
          <Card>
            <CardHeader>
              <CardTitle>Get started</CardTitle>
              <CardDescription>
                Click <strong>Load processing orders</strong> to fetch orders with status{" "}
                <code>processing</code> from ultraskins.co.uk. All orders are pre-selected by
                default — untick any you want to skip, then generate the picklist.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {orders && (
          <Card>
            <CardHeader className="space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <CardTitle>
                  {filtered.length} order{filtered.length === 1 ? "" : "s"}
                  {search && ` (filtered from ${orders.length})`}
                </CardTitle>
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <Badge variant="secondary">{selected.size} selected</Badge>
                  <Badge variant="secondary">{totalItems} items total</Badge>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Input
                  placeholder="Filter by order number or customer…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="max-w-sm"
                />
                <Select value={sortOrder} onValueChange={(v) => setSortOrder(v as "recent" | "oldest")}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recent">Most recent</SelectItem>
                    <SelectItem value="oldest">Oldest</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="border-t">
                <div className="flex items-center gap-3 px-4 py-2 bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  <Checkbox
                    checked={allFilteredSelected}
                    onCheckedChange={(v) => toggleAll(Boolean(v))}
                    aria-label="Select all"
                  />
                  <div className="w-24">Order</div>
                  <div className="flex-1">Customer</div>
                  <div className="w-24 text-right">Items</div>
                  <div className="w-24 text-right">Total</div>
                  <div className="w-32 text-right">Date</div>
                </div>
                {filtered.length === 0 && (
                  <div className="p-8 text-center text-muted-foreground text-sm">
                    No orders match the filter.
                  </div>
                )}
                {filtered.map((o) => {
                  const isSel = selected.has(o.id);
                  return (
                    <label
                      key={o.id}
                      className={`flex items-center gap-3 px-4 py-3 border-t cursor-pointer hover:bg-muted/30 transition-colors ${
                        isSel ? "bg-primary/5" : ""
                      }`}
                    >
                      <Checkbox
                        checked={isSel}
                        onCheckedChange={(v) => toggleOne(o.id, Boolean(v))}
                      />
                      <div className="w-24 font-medium">#{o.number}</div>
                      <div className="flex-1 truncate">{o.customer || "—"}</div>
                      <div className="w-24 text-right tabular-nums">
                        {o.itemCount}
                        <span className="text-muted-foreground text-xs ml-1">
                          ({o.lineCount})
                        </span>
                      </div>
                      <div className="w-24 text-right tabular-nums text-muted-foreground">
                        {o.currency} {o.total}
                      </div>
                      <div className="w-32 text-right text-muted-foreground text-sm">
                        {new Date(o.date_created).toLocaleDateString("en-GB")}
                      </div>
                    </label>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
