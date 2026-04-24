// Royal Mail label creation dialog.
//
// Two modes, decided by what the parent already knows:
//   - No existing shipment for this order  -> form mode (collect weight/dims/
//     service + editable recipient, POST, then switch to view mode).
//   - Existing shipment found              -> view mode (show tracking + PDF
//     preview, print, download).
//
// The PDF lives behind an authenticated endpoint so we fetch it as a Blob via
// apiBlob() and turn it into an object URL. Revoked on unmount/dialog close.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, Printer, Download, Truck, AlertCircle, CheckCircle2, Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { api, apiBlob, RM_SERVICES, rmServicesForFormat, rmSignedVariant, rmDestinationScope, markShipmentsPrinted, type RmShipment } from "@/lib/api";
import { Checkbox } from "@/components/ui/checkbox";

// Just enough of the WooCommerce order shape to prefill the recipient.
type WCAddress = {
  first_name?: string; last_name?: string; company?: string;
  address_1?: string; address_2?: string;
  city?: string; state?: string; postcode?: string; country?: string;
  email?: string; phone?: string;
};
type Order = {
  id: number;
  number: string;
  shipping?: WCAddress;
  billing?: WCAddress;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: number;
  order: Order;
  // Existing shipment (if any) — when set the dialog opens straight to the
  // label viewer instead of the create form.
  initialShipment: RmShipment | null;
  // Notify parent when a label is created so it can refresh order status etc.
  onCreated?: (s: RmShipment) => void;
  // Notify parent when the user cancels/voids the shipment, so it can clear
  // its cached copy and let the user create a new one.
  onVoided?: () => void;
};

type RecipientForm = {
  name: string;
  company: string;
  line1: string;
  line2: string;
  city: string;
  county: string;
  postcode: string;
  country_code: string;
  phone: string;
  email: string;
};

function recipientFromOrder(order: Order): RecipientForm {
  // Prefer shipping address; fall back to billing if shipping is empty.
  const a = order.shipping && (order.shipping.address_1 || order.shipping.first_name)
    ? order.shipping
    : (order.billing || {});
  return {
    name: `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim(),
    company: a.company ?? "",
    line1: a.address_1 ?? "",
    line2: a.address_2 ?? "",
    city: a.city ?? "",
    county: a.state ?? "",
    postcode: (a.postcode ?? "").toUpperCase(),
    country_code: (a.country ?? "GB").toUpperCase().slice(0, 2),
    phone: order.billing?.phone ?? "",
    email: order.billing?.email ?? "",
  };
}

export function RoyalMailLabelDialog({
  open, onOpenChange, siteId, order, initialShipment, onCreated, onVoided,
}: Props) {
  const [shipment, setShipment] = useState<RmShipment | null>(initialShipment);
  useEffect(() => { setShipment(initialShipment); }, [initialShipment, order.id]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5" />
            Royal Mail label — Order #{order.number}
          </DialogTitle>
          <DialogDescription>
            {shipment
              ? "Label created. Print or download below."
              : "Confirm the recipient, pick a service, and create the label."}
          </DialogDescription>
        </DialogHeader>

        {shipment ? (
          <LabelViewer
            shipment={shipment}
            onClose={() => onOpenChange(false)}
            onVoided={() => {
              setShipment(null);
              onVoided?.();
            }}
          />
        ) : (
          <LabelForm
            siteId={siteId}
            order={order}
            onCreated={(s) => {
              setShipment(s);
              onCreated?.(s);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Form ----------------

function LabelForm({
  siteId, order, onCreated,
}: {
  siteId: number;
  order: Order;
  onCreated: (s: RmShipment) => void;
}) {
  const [recipient, setRecipient] = useState<RecipientForm>(() => recipientFromOrder(order));
  // Reset when the parent opens us with a different order.
  useEffect(() => { setRecipient(recipientFromOrder(order)); }, [order.id]);

  // Default to Auto so Click & Drop can use the services/rules enabled on the account.
  const [serviceMode, setServiceMode] = useState<string>("auto");
  const [customServiceCode, setCustomServiceCode] = useState<string>("");
  const [packageFormat, setPackageFormat] = useState<"L" | "F" | "P">("P");
  const [weightGrams, setWeightGrams] = useState<string>("500");
  const [length, setLength] = useState<string>("");
  const [width, setWidth] = useState<string>("");
  const [height, setHeight] = useState<string>("");
  const [safePlace, setSafePlace] = useState<string>("");
  const [reference, setReference] = useState<string>(order.number);
  const [requireSignature, setRequireSignature] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const setField = (k: keyof RecipientForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setRecipient((r) => ({ ...r, [k]: e.target.value }));

  const destScope = rmDestinationScope(recipient.country_code);
  const availableServices = useMemo(
    () => rmServicesForFormat(packageFormat, { country: recipient.country_code }),
    [packageFormat, recipient.country_code],
  );

  // If destination changes and current selection is no longer available, reset.
  useEffect(() => {
    if (serviceMode === "auto" || serviceMode === "custom") return;
    if (!availableServices.some((s) => s.code === serviceMode)) {
      setServiceMode("auto");
      setRequireSignature(false);
    }
  }, [availableServices, serviceMode]);

  // Resolve the final service code, applying signature mapping for domestic.
  const resolvedServiceCode = useMemo(() => {
    if (serviceMode === "custom") return customServiceCode.trim().toUpperCase();
    if (serviceMode === "auto") return "auto";
    if (requireSignature && destScope === "domestic") {
      return rmSignedVariant(serviceMode) ?? serviceMode;
    }
    return serviceMode;
  }, [serviceMode, customServiceCode, requireSignature, destScope]);

  const serviceCode = resolvedServiceCode;

  // Look up suggestion metadata if the selected/typed code matches one we know about.
  // Falls back to a generic 20kg cap so unknown codes still pass weight checks.
  const service = useMemo(() => {
    const code = serviceCode.trim().toUpperCase();
    return (
      RM_SERVICES.find((s) => s.code === code) ?? {
        code,
        label: code && code !== "AUTO" ? code : "Auto",
        maxWeight: 20000,
      }
    );
  }, [serviceCode]);

  // Whether the "Signature required" checkbox should be offered for the
  // currently-selected base service. Only domestic, non-signed picks qualify.
  const baseServiceDef = useMemo(
    () => RM_SERVICES.find((s) => s.code === serviceMode),
    [serviceMode],
  );
  const canToggleSignature =
    destScope === "domestic" &&
    serviceMode !== "auto" &&
    serviceMode !== "custom" &&
    !!baseServiceDef &&
    !baseServiceDef.signed &&
    !!rmSignedVariant(serviceMode);

  const weightNum = Number(weightGrams);
  const overweight = Number.isFinite(weightNum) && weightNum > service.maxWeight;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!Number.isInteger(weightNum) || weightNum < 1) {
      toast.error("Weight must be a positive whole number of grams.");
      return;
    }
    if (overweight) {
      toast.error(`Weight exceeds the ${service.maxWeight}g limit for ${service.label}.`);
      return;
    }
    setSubmitting(true);
    try {
      const dims =
        length && width && height
          ? {
              length_mm: Number(length),
              width_mm: Number(width),
              height_mm: Number(height),
            }
          : {};
      const res = await api<{ shipment: RmShipment }>("/api/royal-mail/shipments", {
        method: "POST",
        body: {
          site_id: siteId,
          woocommerce_order_id: order.id,
          customer_reference: reference || String(order.number),
          service_code: serviceCode,
          service_format: packageFormat,
          weight_grams: weightNum,
          ...dims,
          safe_place: safePlace || undefined,
          description_of_goods: "Goods",
          recipient: {
            name: recipient.name,
            company: recipient.company || undefined,
            line1: recipient.line1,
            line2: recipient.line2 || undefined,
            city: recipient.city,
            county: recipient.county || undefined,
            postcode: recipient.postcode,
            country_code: recipient.country_code || "GB",
            phone: recipient.phone || undefined,
            email: recipient.email || undefined,
          },
        },
      });
      toast.success("Label created");
      onCreated(res.shipment);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Label creation failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5 mt-2">
      {/* Recipient */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Recipient
        </h3>
        <div className="grid sm:grid-cols-2 gap-3">
          <FormRow id="r-name" label="Name" value={recipient.name} onChange={setField("name")} required />
          <FormRow id="r-company" label="Company (optional)" value={recipient.company} onChange={setField("company")} />
        </div>
        <FormRow id="r-line1" label="Address line 1" value={recipient.line1} onChange={setField("line1")} required />
        <FormRow id="r-line2" label="Address line 2" value={recipient.line2} onChange={setField("line2")} />
        <div className="grid sm:grid-cols-3 gap-3">
          <FormRow id="r-city" label="City" value={recipient.city} onChange={setField("city")} required />
          <FormRow id="r-county" label="County" value={recipient.county} onChange={setField("county")} />
          <FormRow id="r-postcode" label="Postcode" value={recipient.postcode} onChange={setField("postcode")} required />
        </div>
        <div className="grid sm:grid-cols-3 gap-3">
          <FormRow id="r-country" label="Country" value={recipient.country_code} onChange={setField("country_code")} maxLength={2} required />
          <FormRow id="r-phone" label="Phone" value={recipient.phone} onChange={setField("phone")} />
          <FormRow id="r-email" label="Email" value={recipient.email} onChange={setField("email")} type="email" />
        </div>
      </section>

      <Separator />

      {/* Package + service */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Package & service
        </h3>

        <div className="grid sm:grid-cols-3 gap-3">
          <div className="space-y-2">
            <Label htmlFor="format">Package format</Label>
            <Select value={packageFormat} onValueChange={(v) => setPackageFormat(v as "L" | "F" | "P")}>
              <SelectTrigger id="format"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="L">Letter</SelectItem>
                <SelectItem value="F">Large Letter</SelectItem>
                <SelectItem value="P">Parcel</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Matches Click &amp; Drop's format options.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="service">Service</Label>
            <Select value={serviceMode} onValueChange={setServiceMode}>
              <SelectTrigger id="service"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto / Click &amp; Drop rules</SelectItem>
                {availableServices.map((s) => (
                  <SelectItem key={s.code} value={s.code}>
                    {s.label} ({s.code})
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom code…</SelectItem>
              </SelectContent>
            </Select>
            {serviceMode === "custom" && (
              <Input
                id="custom-service"
                value={customServiceCode}
                onChange={(e) => setCustomServiceCode(e.target.value.toUpperCase())}
                placeholder="Enter code from Click & Drop"
                maxLength={10}
                autoComplete="off"
                required
              />
            )}
            {canToggleSignature && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer pt-1">
                <Checkbox
                  checked={requireSignature}
                  onCheckedChange={(v) => setRequireSignature(v === true)}
                />
                Signature required (uses {rmSignedVariant(serviceMode)})
              </label>
            )}
            {destScope === "eu" && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                EU destination — ship via Packeta instead of Royal Mail.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Choose Auto if a code is rejected; otherwise use a service enabled on your account.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="weight">Weight (grams)</Label>
            <Input
              id="weight"
              type="number"
              inputMode="numeric"
              min={1}
              max={30000}
              value={weightGrams}
              onChange={(e) => setWeightGrams(e.target.value)}
              required
            />
            {overweight && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> Above limit for {service.label}.
              </p>
            )}
          </div>
        </div>


        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">
            Dimensions (mm) — optional but recommended
          </Label>
          <div className="grid grid-cols-3 gap-3">
            <Input placeholder="Length" type="number" min={0} value={length} onChange={(e) => setLength(e.target.value)} />
            <Input placeholder="Width" type="number" min={0} value={width} onChange={(e) => setWidth(e.target.value)} />
            <Input placeholder="Height" type="number" min={0} value={height} onChange={(e) => setHeight(e.target.value)} />
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="reference">Your reference</Label>
            <Input
              id="reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={40}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="safeplace">Safe place (Tracked services)</Label>
            <Input
              id="safeplace"
              value={safePlace}
              onChange={(e) => setSafePlace(e.target.value)}
              placeholder="e.g. Behind the bins"
              maxLength={120}
            />
          </div>
        </div>
      </section>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={submitting || overweight}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Create label
        </Button>
      </div>
    </form>
  );
}

function FormRow({
  id, label, value, onChange, type = "text", maxLength, required,
}: {
  id: string; label: string; value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: string; maxLength?: number; required?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}{required && <span className="text-destructive ml-0.5">*</span>}</Label>
      <Input id={id} type={type} value={value} onChange={onChange} maxLength={maxLength} required={required} />
    </div>
  );
}

// ---------------- Viewer ----------------

function LabelViewer({
  shipment, onClose, onVoided,
}: {
  shipment: RmShipment;
  onClose: () => void;
  onVoided: () => void;
}) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [voiding, setVoiding] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Cancel = delete the Click & Drop order (when still cancellable) and
  // mark the local shipment voided so the user can create a fresh label.
  // Uses force=true so we still recover locally if Royal Mail refuses
  // (e.g. label already generated their side, or remote order missing).
  const cancelLabel = async () => {
    const ok = window.confirm(
      "Cancel this label and delete the order in Click & Drop? You'll be able to create a new label afterwards.",
    );
    if (!ok) return;
    setVoiding(true);
    try {
      const res = await api<{ ok: boolean; remoteWarning?: string }>(
        `/api/royal-mail/shipments/${shipment.id}?force=true`,
        { method: "DELETE" },
      );
      if (res.remoteWarning) {
        toast.warning(`Cancelled locally. Royal Mail said: ${res.remoteWarning}`);
      } else {
        toast.success("Label cancelled");
      }
      onVoided();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setVoiding(false);
    }
  };

  useEffect(() => {
    if (!shipment.has_label) {
      setPdfUrl(null);
      setLoading(false);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    apiBlob(`/api/royal-mail/shipments/${shipment.id}/label.pdf`)
      .then((blob) => {
        if (cancelled) return;
        if (blob.type && blob.type !== "application/pdf") {
          throw new Error("Royal Mail did not return a PDF for this shipment.");
        }
        url = URL.createObjectURL(blob);
        setPdfUrl(url);
      })
      .catch((e) => {
        if (!cancelled) {
          setPdfUrl(null);
          toast.error(e instanceof Error ? e.message : "Could not load label");
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [shipment.id, shipment.has_label]);

  // Track whether we've already marked this shipment printed in this session
  // so we don't fire it for every print click. The first print is what
  // matters for "label was printed" tracking.
  const markedRef = useRef(false);
  const markPrintedOnce = async () => {
    if (markedRef.current) return;
    markedRef.current = true;
    try {
      const r = await markShipmentsPrinted([shipment.id]);
      if (r.completed > 0) {
        toast.success("Order marked as completed in WooCommerce");
      }
      if (r.completionErrors && r.completionErrors.length > 0) {
        toast.warning("Order auto-complete failed — check WooCommerce.");
      }
    } catch {
      /* silent — print already happened */
    }
  };

  const printLabel = () => {
    const win = iframeRef.current?.contentWindow;
    if (!win) { toast.error("Label still loading"); return; }
    try {
      win.focus();
      win.print();
      markPrintedOnce();
    }
    catch { toast.error("Print failed — try Download PDF instead."); }
  };

  // Auto-open the print dialog as soon as the label PDF has rendered in the
  // iframe. Saves the user from clicking Print every time. The iframe's
  // onLoad handler triggers this once the embedded viewer is ready.
  const handleIframeLoaded = () => {
    // Small delay so Chrome/Edge mounts the PDF plugin before we ask it to print.
    setTimeout(() => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      try {
        win.focus();
        win.print();
        markPrintedOnce();
      } catch { /* user can still click Print */ }
    }, 250);
  };

  return (
    <div className="space-y-4 mt-2">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1">
          <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3 w-3" /> Created
          </Badge>
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Tracking number</div>
          <div className="text-lg font-mono font-semibold tabular-nums">
            {shipment.tracking_number || "—"}
          </div>
          {shipment.service_code && (
            <div className="text-xs text-muted-foreground">Service: {shipment.service_code}</div>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={printLabel} disabled={!shipment.has_label || !pdfUrl}>
            <Printer className="h-4 w-4" /> Print
          </Button>
          {pdfUrl ? (
            <Button asChild variant="outline">
              <a
                href={pdfUrl}
                download={`rm-${shipment.tracking_number || shipment.id}.pdf`}
              >
                <Download className="h-4 w-4" /> Download PDF
              </a>
            </Button>
          ) : (
            <Button variant="outline" disabled>
              <Download className="h-4 w-4" /> Download PDF
            </Button>
          )}
        </div>
      </div>

      <Separator />

      <div className="rounded-md border bg-muted/30 overflow-hidden h-[60vh] flex items-center justify-center">
        {loading ? (
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        ) : pdfUrl ? (
          <iframe
            ref={iframeRef}
            src={pdfUrl}
            title="Royal Mail label"
            className="w-full h-full"
            onLoad={handleIframeLoaded}
          />
        ) : (
          <div className="text-sm text-muted-foreground p-6 text-center max-w-md space-y-2">
            <p>
              No printable PDF was returned by Royal Mail for this shipment.
            </p>
            <p>
              The order was created in Click &amp; Drop, but PDF retrieval is only available for some account/service combinations. Open Click &amp; Drop to buy/generate the label there.
            </p>
            {shipment.royal_mail_shipment_id && (
              <p>Click &amp; Drop order ID: <span className="font-mono">{shipment.royal_mail_shipment_id}</span></p>
            )}
            {shipment.tracking_number && (
              <p>Tracking: <span className="font-mono">{shipment.tracking_number}</span></p>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-between items-center gap-2 flex-wrap">
        <Button
          variant="outline"
          onClick={cancelLabel}
          disabled={voiding}
          className="text-destructive hover:text-destructive"
        >
          {voiding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          Cancel label &amp; create new
        </Button>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}
