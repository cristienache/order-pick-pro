import { useEffect, useState } from "react";
import { api, type RmShipment } from "@/lib/api";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Loader2, Mail, Phone, MapPin, Truck, Receipt, MessageSquare, ExternalLink, Package, Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { RoyalMailLabelDialog } from "@/components/royal-mail-label-dialog";
import { EditAddressDialog } from "@/components/edit-address-dialog";

// Subset of WooCommerce order shape we render.
type WCAddress = {
  first_name?: string; last_name?: string; company?: string;
  address_1?: string; address_2?: string;
  city?: string; state?: string; postcode?: string; country?: string;
  email?: string; phone?: string;
};
type WCMeta = { key: string; display_key?: string; value: unknown; display_value?: unknown };
type WCLineItem = {
  id: number; name: string; quantity: number; sku?: string;
  price?: number; total?: string; subtotal?: string;
  meta_data?: WCMeta[];
};
type WCShippingLine = { method_title?: string; total?: string };
type WCOrder = {
  id: number; number: string; status: string;
  date_created: string; currency: string;
  total: string; subtotal?: string;
  discount_total?: string; shipping_total?: string; total_tax?: string;
  payment_method_title?: string;
  customer_note?: string;
  billing?: WCAddress;
  shipping?: WCAddress;
  line_items: WCLineItem[];
  shipping_lines?: WCShippingLine[];
};
type WCNote = {
  id: number; date_created: string; note: string;
  customer_note: boolean; author?: string;
};

type Props = {
  siteId: number | null;
  orderId: number | null;
  storeUrl?: string;       // used for "Open in WooCommerce" link
  onOpenChange: (open: boolean) => void;
};

function fmtAttrs(item: WCLineItem): string {
  if (!item.meta_data || item.meta_data.length === 0) return "";
  return item.meta_data
    .filter((m) => !m.key.startsWith("_") && (m.display_key || m.key) && (m.display_value ?? m.value))
    .map((m) => {
      const k = String(m.display_key || m.key).replace(/^pa_/, "");
      const v = String(m.display_value ?? m.value).replace(/<[^>]+>/g, "");
      return `${k}: ${v}`;
    })
    .join(" \u00B7 ");
}

function AddressBlock({
  a, label, onEdit,
}: {
  a?: WCAddress;
  label: string;
  onEdit?: () => void;
}) {
  const name = a ? `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() : "";
  const cityLine = a ? [a.city, a.state, a.postcode].filter(Boolean).join(", ") : "";
  const lines = a
    ? [name, a.company, a.address_1, a.address_2, cityLine, a.country]
        .map((s) => (s || "").trim()).filter(Boolean)
    : [];
  return (
    <div className="text-sm">
      <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <MapPin className="h-3 w-3" /> {label}
        </span>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1 text-[11px] normal-case tracking-normal text-muted-foreground hover:text-foreground"
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
        )}
      </div>
      {lines.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">No address on file</div>
      ) : (
        <div className="space-y-0.5 text-foreground">
          {lines.map((l, i) => (
            <div key={i} className={i === 0 ? "font-medium" : ""}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// Lightweight Royal Mail status used to decide what the label button does.
type RmStatus = {
  configured: boolean;
  shipment: RmShipment | null;
};
// Same idea for Packeta.
type PacketaStatus = {
  configured: boolean;
  shipment: RmShipment | null;
};

export function OrderDetailDrawer({ siteId, orderId, storeUrl, onOpenChange }: Props) {
  const open = siteId != null && orderId != null;
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ order: WCOrder; notes: WCNote[] } | null>(null);
  const [rm, setRm] = useState<RmStatus | null>(null);
  const [pk, setPk] = useState<PacketaStatus | null>(null);
  const [pkBusy, setPkBusy] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [editingAddress, setEditingAddress] = useState<"shipping" | "billing" | null>(null);

  useEffect(() => {
    if (!open) { setData(null); setRm(null); setPk(null); setLabelOpen(false); return; }
    let cancelled = false;
    setLoading(true);
    api<{ order: WCOrder; notes: WCNote[] }>(`/api/sites/${siteId}/orders/${orderId}`)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "Failed to load order");
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    // Fetch RM connection status + any existing shipment for this order in
    // parallel so the label button knows what to render. Failures are silent
    // — the order detail still loads.
    Promise.all([
      api<{ settings: { has_api_key: boolean } }>(
        "/api/royal-mail/settings",
      ).catch(() => null),
      api<{ shipment: RmShipment | null }>(
        `/api/royal-mail/shipments/by-order/${siteId}/${orderId}`,
      ).catch(() => null),
    ]).then(([s, ship]) => {
      if (cancelled) return;
      setRm({
        configured: Boolean(s?.settings?.has_api_key),
        shipment: ship?.shipment ?? null,
      });
    });

    // Same for Packeta. `has_api_password` mirrors `has_api_key`.
    Promise.all([
      api<{ settings: { has_api_password: boolean } | null }>(
        "/api/packeta/settings",
      ).catch(() => null),
      api<{ shipment: RmShipment | null }>(
        `/api/packeta/shipments/by-order/${siteId}/${orderId}`,
      ).catch(() => null),
    ]).then(([s, ship]) => {
      if (cancelled) return;
      setPk({
        configured: Boolean(s?.settings?.has_api_password),
        shipment: ship?.shipment ?? null,
      });
    });
    return () => { cancelled = true; };
  }, [open, siteId, orderId]);

  // Create (or reuse) a Packeta label for this order, then open the PDF.
  const createPacketaLabel = async () => {
    if (siteId == null || orderId == null) return;
    setPkBusy(true);
    try {
      const r = await api<{ shipment: RmShipment; label_warning?: string | null }>(
        `/api/packeta/orders/${siteId}/${orderId}/label`,
        { method: "POST" },
      );
      setPk((prev) => prev ? { ...prev, shipment: r.shipment } : prev);
      if (r.label_warning) toast.warning(r.label_warning);
      else toast.success("Packeta label created");
      // Open the merged PDF in a new tab for printing.
      window.open(`/api/packeta/shipments/${r.shipment.id}/label.pdf`, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create Packeta label");
    } finally {
      setPkBusy(false);
    }
  };

  const reprintPacketaLabel = () => {
    if (!pk?.shipment) return;
    window.open(`/api/packeta/shipments/${pk.shipment.id}/label.pdf`, "_blank", "noopener");
  };

  const order = data?.order;
  const notes = data?.notes ?? [];

  const wcUrl = order && storeUrl
    ? `${storeUrl.replace(/\/+$/, "")}/wp-admin/post.php?post=${order.id}&action=edit`
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 flex-wrap">
            {order ? <>Order #{order.number}</> : "Order"}
            {order && (
              <Badge variant="outline" className="capitalize">{order.status.replace("-", " ")}</Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            {order
              ? `Placed ${new Date(order.date_created).toLocaleString("en-GB")}`
              : "Loading order details\u2026"}
          </SheetDescription>
        </SheetHeader>

        {loading && (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && order && (
          <div className="space-y-5 mt-4">
            {/* Customer contact */}
            <div className="space-y-1 text-sm">
              <div className="font-medium">
                {`${order.billing?.first_name ?? ""} ${order.billing?.last_name ?? ""}`.trim() || "Guest"}
              </div>
              {order.billing?.email && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Mail className="h-3 w-3" />
                  <a href={`mailto:${order.billing.email}`} className="hover:underline">
                    {order.billing.email}
                  </a>
                </div>
              )}
              {order.billing?.phone && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Phone className="h-3 w-3" />
                  <a href={`tel:${order.billing.phone}`} className="hover:underline">
                    {order.billing.phone}
                  </a>
                </div>
              )}
            </div>

            <Separator />

            {/* Line items */}
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2">
                Items ({order.line_items.length} lines, {order.line_items.reduce((s, li) => s + li.quantity, 0)} total)
              </div>
              <div className="space-y-2">
                {order.line_items.map((item) => {
                  const attrs = fmtAttrs(item);
                  return (
                    <div key={item.id} className="flex items-start gap-3 p-2.5 rounded-md border bg-muted/30">
                      <div className="font-bold text-sm tabular-nums w-10 text-center">
                        {item.quantity}<span className="text-muted-foreground">x</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium">{item.name}</div>
                        {item.sku && (
                          <div className="text-xs text-muted-foreground font-mono mt-0.5">SKU: {item.sku}</div>
                        )}
                        {attrs && (
                          <div className="text-xs text-muted-foreground mt-0.5">{attrs}</div>
                        )}
                      </div>
                      {item.total && (
                        <div className="text-sm tabular-nums text-muted-foreground">
                          {order.currency} {item.total}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <Separator />

            {/* Addresses side-by-side */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <AddressBlock a={order.shipping} label="Ship to" />
              <AddressBlock a={order.billing} label="Bill to" />
            </div>

            <Separator />

            {/* Shipping + payment + totals */}
            <div className="space-y-2 text-sm">
              {order.shipping_lines && order.shipping_lines.length > 0 && (
                <div className="flex items-start gap-2">
                  <Truck className="h-3.5 w-3.5 mt-0.5 text-muted-foreground" />
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Shipping</div>
                    <div>{order.shipping_lines.map((s) => s.method_title).filter(Boolean).join(" + ")}</div>
                  </div>
                </div>
              )}
              {order.payment_method_title && (
                <div className="flex items-start gap-2">
                  <Receipt className="h-3.5 w-3.5 mt-0.5 text-muted-foreground" />
                  <div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Payment</div>
                    <div>{order.payment_method_title}</div>
                  </div>
                </div>
              )}

              <div className="rounded-md border bg-muted/30 p-3 space-y-1">
                {order.subtotal !== undefined && (
                  <Row label="Subtotal" value={`${order.currency} ${order.subtotal}`} />
                )}
                {order.discount_total && parseFloat(order.discount_total) > 0 && (
                  <Row label="Discount" value={`-${order.currency} ${order.discount_total}`} />
                )}
                {order.shipping_total && (
                  <Row label="Shipping" value={`${order.currency} ${order.shipping_total}`} />
                )}
                {order.total_tax && parseFloat(order.total_tax) > 0 && (
                  <Row label="Tax" value={`${order.currency} ${order.total_tax}`} />
                )}
                <Separator className="my-1" />
                <Row label="Total" value={`${order.currency} ${order.total}`} bold />
              </div>
            </div>

            {/* Customer note */}
            {order.customer_note && (
              <>
                <Separator />
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                    <MessageSquare className="h-3 w-3" /> Customer note
                  </div>
                  <div className="text-sm p-2.5 rounded-md bg-amber-500/10 border border-amber-500/30 whitespace-pre-wrap">
                    {order.customer_note}
                  </div>
                </div>
              </>
            )}

            {/* Order notes (history) */}
            {notes.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">
                    Order notes ({notes.length})
                  </div>
                  <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                    {notes.map((n) => (
                      <div key={n.id}
                        className={`text-sm p-2 rounded-md border ${
                          n.customer_note
                            ? "bg-blue-500/5 border-blue-500/30"
                            : "bg-muted/30"
                        }`}>
                        <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground uppercase tracking-wide mb-1">
                          <span>{n.author || "system"}{n.customer_note ? " \u2192 customer" : ""}</span>
                          <span>{new Date(n.date_created).toLocaleString("en-GB")}</span>
                        </div>
                        <div className="whitespace-pre-wrap text-foreground"
                          dangerouslySetInnerHTML={{ __html: n.note }} />
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Royal Mail label action — content depends on connection state */}
            {rm && (
              <>
                <Separator />
                {!rm.configured ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-dashed p-3 text-sm">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Truck className="h-4 w-4" />
                      <span>Connect Royal Mail to print labels.</span>
                    </div>
                    <Button asChild size="sm" variant="outline">
                      <Link to="/integrations/shipping/royal-mail">Set up</Link>
                    </Button>
                  </div>
                ) : rm.shipment ? (
                  <Button
                    onClick={() => setLabelOpen(true)}
                    variant="outline"
                    size="sm"
                    className="w-full"
                  >
                    <Truck className="h-3.5 w-3.5" />
                    View label · {rm.shipment.tracking_number || rm.shipment.service_code || "created"}
                  </Button>
                ) : (
                  <Button
                    onClick={() => setLabelOpen(true)}
                    size="sm"
                    className="w-full"
                  >
                    <Truck className="h-3.5 w-3.5" /> Create shipping label
                  </Button>
                )}
              </>
            )}

            {/* Packeta label action — same shape as Royal Mail above. */}
            {pk && (
              <>
                <Separator />
                {!pk.configured ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-dashed p-3 text-sm">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Package className="h-4 w-4" />
                      <span>Connect Packeta to print EU labels.</span>
                    </div>
                    <Button asChild size="sm" variant="outline">
                      <Link to="/integrations/shipping/packeta">Set up</Link>
                    </Button>
                  </div>
                ) : pk.shipment ? (
                  <Button
                    onClick={reprintPacketaLabel}
                    variant="outline"
                    size="sm"
                    className="w-full"
                  >
                    <Package className="h-3.5 w-3.5" />
                    Reprint Packeta label · {pk.shipment.packeta_barcode || pk.shipment.tracking_number || "created"}
                  </Button>
                ) : (
                  <Button
                    onClick={createPacketaLabel}
                    size="sm"
                    className="w-full"
                    disabled={pkBusy}
                  >
                    {pkBusy
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Package className="h-3.5 w-3.5" />}
                    Create Packeta label (4×6")
                  </Button>
                )}
              </>
            )}

            {wcUrl && (
              <>
                <Separator />
                <Button variant="outline" size="sm" asChild className="w-full">
                  <a href={wcUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" /> Open in WooCommerce admin
                  </a>
                </Button>
              </>
            )}
          </div>
        )}
      </SheetContent>

      {/* Label dialog lives outside the drawer body so it overlays correctly. */}
      {order && siteId != null && (
        <RoyalMailLabelDialog
          open={labelOpen}
          onOpenChange={setLabelOpen}
          siteId={siteId}
          order={{
            id: order.id,
            number: order.number,
            shipping: order.shipping,
            billing: order.billing,
          }}
          initialShipment={rm?.shipment ?? null}
          onCreated={(s) => setRm((prev) => prev ? { ...prev, shipment: s } : prev)}
          onVoided={() => setRm((prev) => prev ? { ...prev, shipment: null } : prev)}
        />
      )}
    </Sheet>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-bold text-base" : "text-sm text-muted-foreground"}`}>
      <span>{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}
