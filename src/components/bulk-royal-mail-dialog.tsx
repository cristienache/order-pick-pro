// Bulk Royal Mail dialog.
//
// Two modes triggered from the orders bulk-actions dropdown:
//   - "create": one shared form (service / format / weight / safe place) is
//     applied to every selected order. The server pulls each order's recipient
//     and line items from WooCommerce, so the user only confirms the shared
//     shipping params once. Mirrors Click & Drop's bulk "Apply postage".
//   - "print": no form. We look up existing shipments for the selection and
//     download a single merged multi-page PDF of all available labels.

import { useEffect, useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Loader2, Printer, Truck, AlertCircle, CheckCircle2, Globe } from "lucide-react";
import { toast } from "sonner";
import {
  api, apiBlob, RM_SERVICES, rmSignedVariant,
  markShipmentsPrinted,
  type RmShipment, type RmCustomsContentType, type RmSettings,
} from "@/lib/api";
import { Checkbox } from "@/components/ui/checkbox";
import { printPdfBlob } from "@/lib/print-pdf";

export type BulkSelection = { site_id: number; order_ids: number[] };

type Props = {
  open: boolean;
  mode: "create" | "print";
  selections: BulkSelection[];
  onOpenChange: (open: boolean) => void;
  // Called after a successful bulk create so the parent can refresh order
  // status/badges if needed.
  onCreated?: () => void;
};

type BulkResultRow = {
  site_id: number;
  order_id: number;
  order_number?: string;
  ok: boolean;
  error?: string;
  shipment?: RmShipment;
};

type ExistingRow = {
  site_id: number;
  order_id: number;
  shipment: RmShipment | null;
};

export function BulkRoyalMailDialog({
  open, mode, selections, onOpenChange, onCreated,
}: Props) {
  const totalOrders = useMemo(
    () => selections.reduce((s, sel) => s + sel.order_ids.length, 0),
    [selections],
  );

  // Shared create-form state
  const [destination, setDestination] = useState<"domestic" | "international">("domestic");
  const [serviceMode, setServiceMode] = useState<string>("auto");
  const [customServiceCode, setCustomServiceCode] = useState<string>("");
  const [packageFormat, setPackageFormat] = useState<"L" | "F" | "P">("P");
  const [weightGrams, setWeightGrams] = useState<string>("500");
  const [length, setLength] = useState<string>("");
  const [width, setWidth] = useState<string>("");
  const [height, setHeight] = useState<string>("");
  const [safePlace, setSafePlace] = useState<string>("");
  const [requireSignature, setRequireSignature] = useState(false);

  // Royal Mail settings — used to seed sender defaults (origin country,
  // content type, currency reminder) for the bulk customs panel.
  const [rmSettings, setRmSettings] = useState<RmSettings | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{ settings: RmSettings }>("/api/royal-mail/settings")
      .then((r) => { if (!cancelled) setRmSettings(r.settings); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, []);

  const defaultOrigin = (rmSettings?.default_origin_country || "GB").toUpperCase();
  const defaultContentType: RmCustomsContentType = rmSettings?.default_content_type || "saleOfGoods";

  // Shared customs (only used when destination = international).
  const [customsContentType, setCustomsContentType] =
    useState<RmCustomsContentType>(defaultContentType);
  const [customsCurrency, setCustomsCurrency] = useState<string>("GBP");
  const [customsCode, setCustomsCode] = useState<string>("");
  const [customsOrigin, setCustomsOrigin] = useState<string>(defaultOrigin);
  const [customsDescription, setCustomsDescription] = useState<string>("");
  // Re-seed when settings load so the form shows the user's saved defaults.
  useEffect(() => {
    setCustomsContentType(defaultContentType);
    setCustomsOrigin(defaultOrigin);
  }, [defaultContentType, defaultOrigin]);

  // Run state
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BulkResultRow[] | null>(null);

  // Print mode: existing shipments across selection
  const [existing, setExisting] = useState<ExistingRow[] | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(false);

  // Reset on open/close so a stale run doesn't leak into the next dialog.
  useEffect(() => {
    if (!open) {
      setResults(null);
      setExisting(null);
      setBusy(false);
      return;
    }
    if (mode === "print") {
      let cancelled = false;
      setLoadingExisting(true);
      // Look up each order's existing shipment in parallel. Rate-limited at the
      // server (120 req/min default) so we cap parallelism implicitly via the
      // Promise.all window.
      (async () => {
        const flat: { site_id: number; order_id: number }[] = [];
        for (const sel of selections) {
          for (const oid of sel.order_ids) flat.push({ site_id: sel.site_id, order_id: oid });
        }
        const out: ExistingRow[] = await Promise.all(flat.map(async (row) => {
          try {
            const r = await api<{ shipment: RmShipment | null }>(
              `/api/royal-mail/shipments/by-order/${row.site_id}/${row.order_id}`,
            );
            return { ...row, shipment: r.shipment };
          } catch {
            return { ...row, shipment: null };
          }
        }));
        if (!cancelled) {
          setExisting(out);
          setLoadingExisting(false);
        }
      })();
      return () => { cancelled = true; };
    }
  }, [open, mode, selections]);

  const availableServices = useMemo(
    () => RM_SERVICES.filter(
      (s) => s.formats.includes(packageFormat) && s.scope === destination,
    ),
    [packageFormat, destination],
  );

  // Reset selection when destination/format makes it invalid.
  useEffect(() => {
    if (serviceMode === "auto" || serviceMode === "custom") return;
    if (!availableServices.some((s) => s.code === serviceMode)) {
      setServiceMode("auto");
      setRequireSignature(false);
    }
  }, [availableServices, serviceMode]);

  const baseServiceDef = useMemo(
    () => RM_SERVICES.find((s) => s.code === serviceMode),
    [serviceMode],
  );
  const canToggleSignature =
    destination === "domestic" &&
    serviceMode !== "auto" &&
    serviceMode !== "custom" &&
    !!baseServiceDef &&
    !baseServiceDef.signed &&
    !!rmSignedVariant(serviceMode);

  const resolvedServiceCode = useMemo(() => {
    if (serviceMode === "custom") return customServiceCode.trim().toUpperCase();
    if (serviceMode === "auto") return "auto";
    if (requireSignature && destination === "domestic") {
      return rmSignedVariant(serviceMode) ?? serviceMode;
    }
    return serviceMode;
  }, [serviceMode, customServiceCode, requireSignature, destination]);

  const serviceCode = resolvedServiceCode;
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

  const weightNum = Number(weightGrams);
  const overweight = Number.isFinite(weightNum) && weightNum > service.maxWeight;

  const isInternational = destination === "international";
  const customsValid =
    !isInternational ||
    (customsCode.trim().length >= 2 &&
      customsOrigin.trim().length === 2 &&
      customsDescription.trim().length > 0 &&
      customsCurrency.trim().length === 3);

  // ---------- Create flow ----------
  const runCreate = async () => {
    if (!Number.isInteger(weightNum) || weightNum < 1) {
      toast.error("Weight must be a positive whole number of grams.");
      return;
    }
    if (overweight) {
      toast.error(`Weight exceeds the ${service.maxWeight}g limit for ${service.label}.`);
      return;
    }
    if (isInternational && !customsValid) {
      toast.error("Fill in customs HS code, origin country, currency and description.");
      return;
    }
    setBusy(true);
    setResults(null);
    try {
      const body: Record<string, unknown> = {
        service_code: serviceCode,
        service_format: packageFormat,
        weight_grams: weightNum,
        safe_place: safePlace || undefined,
        description_of_goods: "Goods",
        selections,
      };
      if (length && width && height) {
        body.length_mm = Number(length);
        body.width_mm = Number(width);
        body.height_mm = Number(height);
      }
      if (isInternational) {
        body.bulk_customs = {
          content_type: customsContentType,
          currency_code: customsCurrency.toUpperCase(),
          customs_code: customsCode.trim(),
          origin_country: customsOrigin.trim().toUpperCase(),
          customs_description: customsDescription.trim(),
        };
      }
      const res = await api<{ succeeded: number; failed: number; results: BulkResultRow[] }>(
        "/api/royal-mail/shipments/bulk",
        { body },
      );
      setResults(res.results);
      if (res.failed === 0) {
        toast.success(`Created ${res.succeeded} label${res.succeeded === 1 ? "" : "s"}`);
      } else if (res.succeeded === 0) {
        toast.error(`All ${res.failed} label(s) failed`);
      } else {
        toast.warning(`Created ${res.succeeded}, failed ${res.failed}`);
      }
      onCreated?.();

      // Auto-print: as soon as labels are created successfully, send the
      // merged PDF to the browser's print dialog. The user can still re-print
      // from the results screen if the dialog was dismissed.
      const newPrintableIds = res.results
        .filter((r) => r.ok && r.shipment?.has_label)
        .map((r) => r.shipment!.id);
      if (newPrintableIds.length > 0) {
        await printIds(newPrintableIds);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk label creation failed");
    } finally {
      setBusy(false);
    }
  };

  // ---------- Print flow ----------
  // Pull every shipment that has a printable PDF, merge them server-side.
  const printableIds = useMemo(() => {
    const src = results
      ? results.filter((r) => r.ok && r.shipment?.has_label).map((r) => r.shipment!.id)
      : (existing || []).filter((r) => r.shipment?.has_label).map((r) => r.shipment!.id);
    return src;
  }, [results, existing]);

  const missingCount = mode === "print" && existing
    ? existing.filter((r) => !r.shipment).length
    : 0;
  const noPdfCount = mode === "print" && existing
    ? existing.filter((r) => r.shipment && !r.shipment.has_label).length
    : 0;

  const printIds = async (ids: number[]) => {
    if (ids.length === 0) {
      toast.error("No printable labels available");
      return;
    }
    setBusy(true);
    try {
      const blob = await apiBlob(
        `/api/royal-mail/shipments/bulk/labels.pdf?ids=${ids.join(",")}`,
      );
      // Fire-and-forget the print dialog. Awaiting `printPdfBlob` would keep
      // `busy` true until the user dismissed the print dialog (or up to 10
      // minutes if `afterprint` never fires), freezing this dialog and the
      // entire orders toolbar.
      void printPdfBlob(
        blob,
        `rm-labels-${new Date().toISOString().slice(0, 10)}.pdf`,
      );
      toast.success(`Sent ${ids.length} label(s) to printer`);
      // Mark printed server-side: stamps printed_at + auto-completes the
      // matching WooCommerce orders. Run in the background so we can release
      // the spinner immediately.
      void (async () => {
        try {
          const r = await markShipmentsPrinted(ids);
          if (r.completed > 0) {
            toast.success(
              `Marked ${r.completed} order${r.completed === 1 ? "" : "s"} as completed in WooCommerce`,
            );
          }
          if (r.completionErrors && r.completionErrors.length > 0) {
            // Surface the actual error from WooCommerce — not just a count —
            // so the user knows which call failed and why.
            toast.error(
              `Couldn't auto-complete: ${r.completionErrors[0].error}`,
              { description: r.completionErrors.length > 1
                  ? `+${r.completionErrors.length - 1} more — check WooCommerce.`
                  : undefined },
            );
          }
          onCreated?.();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Failed to mark printed");
        }
      })();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Print failed");
    } finally {
      setBusy(false);
    }
  };

  const downloadMerged = () => printIds(printableIds);

  // ---------- Render ----------
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5" />
            {mode === "create"
              ? `Create Royal Mail labels (${totalOrders})`
              : `Print Royal Mail labels (${totalOrders})`}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Apply the same postage to every selected order. Recipient addresses are pulled from each WooCommerce order automatically."
              : "Merge every existing label for the selected orders into a single multi-page PDF."}
          </DialogDescription>
        </DialogHeader>

        {mode === "create" && !results && (
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="bulk-destination">Destination</Label>
              <Select value={destination} onValueChange={(v) => setDestination(v as "domestic" | "international")}>
                <SelectTrigger id="bulk-destination"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="domestic">UK domestic</SelectItem>
                  <SelectItem value="international">International (non-EU)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                EU orders ship via Packeta and are not handled here.
              </p>
            </div>

            <div className="grid sm:grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="bulk-format">Package format</Label>
                <Select value={packageFormat} onValueChange={(v) => setPackageFormat(v as "L" | "F" | "P")}>
                  <SelectTrigger id="bulk-format"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="L">Letter</SelectItem>
                    <SelectItem value="F">Large Letter</SelectItem>
                    <SelectItem value="P">Parcel</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="bulk-service">Service</Label>
                <Select value={serviceMode} onValueChange={setServiceMode}>
                  <SelectTrigger id="bulk-service"><SelectValue /></SelectTrigger>
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
                    value={customServiceCode}
                    onChange={(e) => setCustomServiceCode(e.target.value.toUpperCase())}
                    placeholder="Enter code"
                    maxLength={10}
                  />
                )}
                {canToggleSignature && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer pt-1">
                    <Checkbox
                      checked={requireSignature}
                      onCheckedChange={(v) => setRequireSignature(v === true)}
                    />
                    Signature required ({rmSignedVariant(serviceMode)})
                  </label>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="bulk-weight">Weight (grams)</Label>
                <Input
                  id="bulk-weight"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={30000}
                  value={weightGrams}
                  onChange={(e) => setWeightGrams(e.target.value)}
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
                Dimensions (mm) — optional, applied to every parcel
              </Label>
              <div className="grid grid-cols-3 gap-3">
                <Input placeholder="Length" type="number" min={0} value={length} onChange={(e) => setLength(e.target.value)} />
                <Input placeholder="Width" type="number" min={0} value={width} onChange={(e) => setWidth(e.target.value)} />
                <Input placeholder="Height" type="number" min={0} value={height} onChange={(e) => setHeight(e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="bulk-safeplace">Safe place (Tracked services only)</Label>
              <Input
                id="bulk-safeplace"
                value={safePlace}
                onChange={(e) => setSafePlace(e.target.value)}
                placeholder="e.g. Behind the bins"
                maxLength={120}
              />
            </div>

            <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              Will create labels for <span className="font-semibold text-foreground">{totalOrders}</span> order
              {totalOrders === 1 ? "" : "s"} across {selections.length} site
              {selections.length === 1 ? "" : "s"}. Orders that already have a non-voided label will be skipped.
            </div>
          </div>
        )}

        {mode === "create" && results && (
          <ResultsList results={results} />
        )}

        {mode === "print" && (
          <div className="space-y-3 mt-2">
            {loadingExisting ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <div className="rounded-md border bg-muted/30 p-3 space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Selected orders</span>
                    <span className="font-medium tabular-nums">{totalOrders}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Printable labels</span>
                    <span className="font-medium tabular-nums">{printableIds.length}</span>
                  </div>
                  {missingCount > 0 && (
                    <div className="flex justify-between text-amber-600 dark:text-amber-400">
                      <span>No label yet</span>
                      <span className="tabular-nums">{missingCount}</span>
                    </div>
                  )}
                  {noPdfCount > 0 && (
                    <div className="flex justify-between text-amber-600 dark:text-amber-400">
                      <span>Label without PDF (open in Click &amp; Drop)</span>
                      <span className="tabular-nums">{noPdfCount}</span>
                    </div>
                  )}
                </div>
                {missingCount > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Use "Create Royal Mail labels" first for orders that don't have one yet.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 flex-wrap">
          {mode === "create" && !results && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={runCreate} disabled={busy || overweight}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Create {totalOrders} label{totalOrders === 1 ? "" : "s"}
              </Button>
            </>
          )}
          {mode === "create" && results && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
              {printableIds.length > 0 && (
                <Button onClick={downloadMerged} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                  Print {printableIds.length} label{printableIds.length === 1 ? "" : "s"}
                </Button>
              )}
            </>
          )}
          {mode === "print" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Close</Button>
              <Button onClick={downloadMerged} disabled={busy || loadingExisting || printableIds.length === 0}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                Print labels
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResultsList({ results }: { results: BulkResultRow[] }) {
  return (
    <div className="space-y-2 mt-2">
      <Separator />
      <div className="text-xs text-muted-foreground uppercase tracking-wide">
        Results ({results.length})
      </div>
      <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
        {results.map((r, i) => (
          <div
            key={`${r.site_id}-${r.order_id}-${i}`}
            className={`flex items-start gap-2 p-2 rounded-md border text-sm ${
              r.ok ? "bg-emerald-500/5 border-emerald-500/30" : "bg-destructive/5 border-destructive/30"
            }`}
          >
            {r.ok ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
            ) : (
              <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="font-medium">
                Order #{r.order_number || r.order_id}
              </div>
              {r.ok && r.shipment?.tracking_number && (
                <div className="text-xs text-muted-foreground font-mono">
                  Tracking: {r.shipment.tracking_number}
                </div>
              )}
              {!r.ok && r.error && (
                <div className="text-xs text-muted-foreground break-words">{r.error}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
