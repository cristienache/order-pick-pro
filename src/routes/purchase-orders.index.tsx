import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { poApi, PO_STATUS_LABEL, type PoStatus } from "@/lib/purchase-orders-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, FileText, AlertCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/purchase-orders/")({
  head: () => ({ meta: [{ title: "Purchase orders — HeyShop" }] }),
  component: PoListPage,
});

const STATUS_TONE: Record<PoStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  sent: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  partial: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  received: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  cancelled: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
};

function PoListPage() {
  const list = useQuery({ queryKey: ["po-list"], queryFn: () => poApi.pos.list() });

  if (list.error) {
    return (
      <div className="rounded-lg border border-amber-300/40 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm flex items-start gap-2">
        <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
        <div>
          <p className="font-semibold">Couldn't load purchase orders.</p>
          <p className="text-muted-foreground mt-1">{(list.error as Error).message}</p>
        </div>
      </div>
    );
  }

  const rows = list.data ?? [];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">Purchase orders</h1>
          <p className="text-xs text-muted-foreground">
            Create, track and print purchase orders. Receiving updates stock automatically.
          </p>
        </div>
        <Button size="sm" asChild>
          <Link to="/purchase-orders/new"><Plus className="mr-1.5 h-3.5 w-3.5" /> New PO</Link>
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/60 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
            <tr>
              <th className="px-3 py-2">PO #</th>
              <th className="px-3 py-2">Supplier</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Lines</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2">Expected</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2 w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {list.isLoading && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!list.isLoading && rows.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-12 text-center text-muted-foreground">
                No purchase orders yet. <Link to="/purchase-orders/new" className="underline">Create one</Link>.
              </td></tr>
            )}
            {rows.map((po) => (
              <tr key={po.id} className="hover:bg-accent/30">
                <td className="px-3 py-2 font-mono">{po.po_number}</td>
                <td className="px-3 py-2">{po.supplier_name}</td>
                <td className="px-3 py-2">
                  <Badge className={STATUS_TONE[po.status]} variant="secondary">
                    {PO_STATUS_LABEL[po.status]}
                  </Badge>
                </td>
                <td className="px-3 py-2 tabular-nums">{po.line_count}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {po.currency} {po.total.toFixed(2)}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {po.expected_at ? new Date(po.expected_at).toLocaleDateString("en-GB") : "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {formatDistanceToNow(new Date(po.created_at), { addSuffix: true })}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button asChild size="sm" variant="ghost">
                    <Link to="/purchase-orders/$id" params={{ id: po.id }}>
                      <FileText className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
