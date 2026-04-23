// Edit a WooCommerce order's shipping or billing address from inside the
// order detail drawer. Saving PUTs to /api/sites/:id/orders/:orderId/addresses
// which forwards the patch straight to WC.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export type WCAddressInput = {
  first_name?: string; last_name?: string; company?: string;
  address_1?: string; address_2?: string;
  city?: string; state?: string; postcode?: string; country?: string;
  email?: string; phone?: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: number;
  orderId: number;
  kind: "shipping" | "billing";
  initial: WCAddressInput | undefined;
  // Receives the freshly re-loaded order payload so the parent can update.
  onSaved: (payload: { order: unknown; notes: unknown }) => void;
};

export function EditAddressDialog({
  open, onOpenChange, siteId, orderId, kind, initial, onSaved,
}: Props) {
  const [form, setForm] = useState<WCAddressInput>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({
      first_name: initial?.first_name ?? "",
      last_name: initial?.last_name ?? "",
      company: initial?.company ?? "",
      address_1: initial?.address_1 ?? "",
      address_2: initial?.address_2 ?? "",
      city: initial?.city ?? "",
      state: initial?.state ?? "",
      postcode: initial?.postcode ?? "",
      country: initial?.country ?? "",
      // Billing-only fields. Hidden from the form for shipping.
      email: initial?.email ?? "",
      phone: initial?.phone ?? "",
    });
  }, [open, initial]);

  const set = (k: keyof WCAddressInput) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      // Only send the half being edited; the server keeps the other side
      // untouched. WC ignores empty strings for optional fields.
      const payload: Record<string, WCAddressInput> = {};
      const cleaned: WCAddressInput = { ...form };
      // For shipping, strip email/phone — WC doesn't store them on shipping
      // and our zod validator rejects unknown keys.
      if (kind === "shipping") {
        delete cleaned.email;
        delete cleaned.phone;
      } else if (cleaned.email === "") {
        // Empty email would fail the email() validator; drop instead of sending.
        delete cleaned.email;
      }
      payload[kind] = cleaned;

      const r = await api<{ order: unknown; notes: unknown }>(
        `/api/sites/${siteId}/orders/${orderId}/addresses`,
        { method: "PUT", body: payload },
      );
      toast.success(
        kind === "shipping"
          ? "Shipping address updated in WooCommerce"
          : "Billing address updated in WooCommerce",
      );
      onSaved(r);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Edit {kind === "shipping" ? "shipping" : "billing"} address
          </DialogTitle>
          <DialogDescription>
            Changes are pushed to WooCommerce immediately and saved on the order.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field id="ea-fn" label="First name" value={form.first_name ?? ""} onChange={set("first_name")} />
            <Field id="ea-ln" label="Last name" value={form.last_name ?? ""} onChange={set("last_name")} />
          </div>
          <Field id="ea-co" label="Company" value={form.company ?? ""} onChange={set("company")} />
          <Field id="ea-l1" label="Address line 1" value={form.address_1 ?? ""} onChange={set("address_1")} />
          <Field id="ea-l2" label="Address line 2" value={form.address_2 ?? ""} onChange={set("address_2")} />
          <div className="grid grid-cols-3 gap-3">
            <Field id="ea-city" label="City" value={form.city ?? ""} onChange={set("city")} />
            <Field id="ea-state" label="State / County" value={form.state ?? ""} onChange={set("state")} />
            <Field id="ea-pc" label="Postcode" value={form.postcode ?? ""} onChange={set("postcode")} />
          </div>
          <Field
            id="ea-country" label="Country (ISO-2, e.g. GB, NL)"
            value={form.country ?? ""} onChange={set("country")} maxLength={2}
            transform={(v) => v.toUpperCase()}
          />
          {kind === "billing" && (
            <div className="grid grid-cols-2 gap-3">
              <Field id="ea-email" type="email" label="Email" value={form.email ?? ""} onChange={set("email")} />
              <Field id="ea-phone" label="Phone" value={form.phone ?? ""} onChange={set("phone")} />
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save & push to WooCommerce
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id, label, value, onChange, type = "text", maxLength, transform,
}: {
  id: string; label: string; value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: string; maxLength?: number;
  transform?: (v: string) => string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input
        id={id} type={type} value={value} maxLength={maxLength}
        onChange={transform
          ? (e) => onChange({ ...e, target: { ...e.target, value: transform(e.target.value) } } as React.ChangeEvent<HTMLInputElement>)
          : onChange}
      />
    </div>
  );
}
