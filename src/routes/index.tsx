import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { api, apiBlob, type Site } from "@/lib/api";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Loader2, Download, RefreshCw, Package, Store } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/")({
  component: () => <RequireAuth><AppShell><PicklistPage /></AppShell></RequireAuth>,
  head: () => ({
    meta: [
      { title: "Picklist | Ultrax" },
      { name: "description", content: "Generate multi-site WooCommerce picklist PDFs." },
    ],
  }),
});

type OrderRow = {
  id: number; number: string; date_created: string;
  total: string; currency: string; customer: string;
  itemCount: number; lineCount: number;
};

type Mode = "single" | "multi";

function PicklistPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [loadingSites, setLoadingSites] = useState(true);
  const [mode, setMode] = useState<Mode>("single");
  const [activeSites, setActiveSites] = useState<number[]>([]);
  const [ordersBySite, setOrdersBySite] = useState<Record<number, OrderRow[]>>({});
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [selected, setSelected] = useState<Record<number, Set<number>>>({});
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<"recent" | "oldest">("recent");
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    api<{ sites: Site[] }>("/api/sites")
      .then((r) => {
        setSites(r.sites);
        if (r.sites.length > 0) setActiveSites([r.sites[0].id]);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load sites"))
      .finally(() => setLoadingSites(false));
  }, []);

  // Reset active sites when mode toggles
  useEffect(() => {
    if (sites.length === 0) return;
    if (mode === "single" && activeSites.length !== 1) setActiveSites([sites[0].id]);
  }, [mode, sites]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadOrders = useCallback(async () => {
    if (activeSites.length === 0) return;
    setLoadingOrders(true);
    try {
      const results: Record<number, OrderRow[]> = {};
      const sel: Record<number, Set<number>> = {};
      await Promise.all(activeSites.map(async (sid) => {
        const r = await api<{ orders: OrderRow[] }>(`/api/sites/${sid}/orders`);
        results[sid] = r.orders;
        // Start with NO orders selected — user picks what to include.
        sel[sid] = new Set();
      }));
      setOrdersBySite(results);
      setSelected(sel);
      const total = Object.values(results).reduce((s, arr) => s + arr.length, 0);
      toast.success(`Loaded ${total} orders across ${activeSites.length} site(s)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load orders");
    } finally { setLoadingOrders(false); }
  }, [activeSites]);

  const toggleSiteActive = (id: number) => {
    if (mode === "single") setActiveSites([id]);
    else setActiveSites((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);
  };

  const filteredBySite = useMemo(() => {
    const out: Record<number, OrderRow[]> = {};
    for (const sid of activeSites) {
      const arr = ordersBySite[sid] || [];
      const q = search.trim().toLowerCase();
      const filtered = !q ? arr : arr.filter((o) =>
        o.number.toLowerCase().includes(q) || o.customer.toLowerCase().includes(q));
      out[sid] = [...filtered].sort((a, b) => {
        const ta = new Date(a.date_created).getTime();
        const tb = new Date(b.date_created).getTime();
        return sortOrder === "recent" ? tb - ta : ta - tb;
      });
    }
    return out;
  }, [ordersBySite, activeSites, search, sortOrder]);

  const toggleOne = (sid: number, oid: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev[sid] || []);
      if (checked) next.add(oid); else next.delete(oid);
      return { ...prev, [sid]: next };
    });
  };

  const toggleAllInSite = (sid: number, checked: boolean) => {
    setSelected((prev) => ({
      ...prev,
      [sid]: checked ? new Set((filteredBySite[sid] || []).map((o) => o.id)) : new Set(),
    }));
  };

  const totalSelected = activeSites.reduce((s, sid) => s + (selected[sid]?.size || 0), 0);
  const totalItems = activeSites.reduce((s, sid) => {
    const sel = selected[sid] || new Set();
    return s + (filteredBySite[sid] || []).filter((o) => sel.has(o.id)).reduce((a, o) => a + o.itemCount, 0);
  }, 0);

  const generate = async () => {
    const selections = activeSites
      .map((sid) => ({ site_id: sid, order_ids: Array.from(selected[sid] || []) }))
      .filter((s) => s.order_ids.length > 0);
    if (selections.length === 0) { toast.error("Select at least one order"); return; }
    setGenerating(true);
    try {
      const blob = await apiBlob("/api/picklist", { body: { selections } });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `picklist-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Picklist generated (${totalSelected} orders)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate");
    } finally { setGenerating(false); }
  };

  if (loadingSites) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (sites.length === 0) {
    return (
      <Card>
        <CardHeader className="text-center py-12">
          <Store className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
          <CardTitle>No sites configured</CardTitle>
          <CardDescription className="mb-4">Add a WooCommerce site to start generating picklists.</CardDescription>
          <Link to="/sites"><Button>Add your first site</Button></Link>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Package className="h-6 w-6" /> Picklist
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Pull processing orders from your sites and generate a pick-list PDF.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={loadOrders} disabled={loadingOrders || activeSites.length === 0}
            variant={Object.keys(ordersBySite).length ? "outline" : "default"}>
            {loadingOrders ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {Object.keys(ordersBySite).length ? "Reload" : "Load orders"}
          </Button>
          <Button onClick={generate} disabled={generating || totalSelected === 0}>
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Generate ({totalSelected})
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-base">Sites</CardTitle>
              <CardDescription>
                Choose mode and select which sites to pull orders from.
              </CardDescription>
            </div>
            <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
              <TabsList>
                <TabsTrigger value="single">Single site</TabsTrigger>
                <TabsTrigger value="multi">Multi-site</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {sites.map((s) => {
              const active = activeSites.includes(s.id);
              return (
                <button key={s.id} onClick={() => toggleSiteActive(s.id)}
                  className={`px-3 py-2 rounded-md border text-sm transition-colors ${
                    active ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent"
                  }`}>
                  {s.name}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {Object.keys(ordersBySite).length > 0 && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <Input placeholder="Filter by order # or customer…" value={search}
              onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
            <Select value={sortOrder} onValueChange={(v) => setSortOrder(v as "recent" | "oldest")}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">Most recent</SelectItem>
                <SelectItem value="oldest">Oldest</SelectItem>
              </SelectContent>
            </Select>
            <div className="ml-auto flex gap-2">
              <Badge variant="secondary">{totalSelected} selected</Badge>
              <Badge variant="secondary">{totalItems} items</Badge>
            </div>
          </div>

          {activeSites.map((sid) => {
            const site = sites.find((s) => s.id === sid);
            const orders = filteredBySite[sid] || [];
            const sel = selected[sid] || new Set();
            const allSelected = orders.length > 0 && orders.every((o) => sel.has(o.id));
            return (
              <Card key={sid}>
                <CardHeader className="py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Store className="h-4 w-4" /> {site?.name}
                    <Badge variant="outline" className="ml-2">{orders.length} orders</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="border-t">
                    <div className="flex items-center gap-3 px-4 py-2 bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={(v) => toggleAllInSite(sid, Boolean(v))}
                        aria-label={search.trim() ? "Select all filtered" : "Select all"}
                      />
                      <div className="w-24">Order</div>
                      <div className="flex-1">Customer</div>
                      <div className="w-20 text-right">Items</div>
                      <div className="w-24 text-right">Total</div>
                      <div className="w-28 text-right">Date</div>
                    </div>
                    {orders.length === 0 && (
                      <div className="p-6 text-center text-muted-foreground text-sm">No orders.</div>
                    )}
                    {orders.map((o) => {
                      const isSel = sel.has(o.id);
                      return (
                        <label key={o.id}
                          className={`flex items-center gap-3 px-4 py-2.5 border-t cursor-pointer hover:bg-muted/30 ${
                            isSel ? "bg-primary/5" : ""
                          }`}>
                          <Checkbox checked={isSel} onCheckedChange={(v) => toggleOne(sid, o.id, Boolean(v))} />
                          <div className="w-24 font-medium">#{o.number}</div>
                          <div className="flex-1 truncate">{o.customer || "—"}</div>
                          <div className="w-20 text-right tabular-nums">
                            {o.itemCount}
                            <span className="text-muted-foreground text-xs ml-1">({o.lineCount})</span>
                          </div>
                          <div className="w-24 text-right tabular-nums text-muted-foreground">
                            {o.currency} {o.total}
                          </div>
                          <div className="w-28 text-right text-muted-foreground text-sm">
                            {new Date(o.date_created).toLocaleDateString("en-GB")}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}
