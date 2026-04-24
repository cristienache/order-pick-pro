import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Truck, KeyRound, MapPin, Globe, CheckCircle2, AlertCircle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { RmCustomsContentType } from "@/lib/api";

export const Route = createFileRoute("/integrations/shipping/royal-mail")({
  component: RoyalMailPage,
  head: () => ({
    meta: [
      { title: "Royal Mail | Ultrax" },
      { name: "description", content: "Connect Royal Mail Click & Drop and configure your sender address." },
    ],
  }),
});

import type { RmSettings } from "@/lib/api";

function RoyalMailPage() {
  const [settings, setSettings] = useState<RmSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = () =>
    api<{ settings: RmSettings }>("/api/royal-mail/settings").then((r) => setSettings(r.settings));

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  if (loading || !settings) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Truck}
        accent="emerald"
        eyebrow="Shipping carrier"
        title="Royal Mail"
        description="Connect your Click & Drop account to generate shipping labels from inside Ultrax."
      />
      <CredentialsCard settings={settings} onChanged={refresh} />
      <SenderCard settings={settings} onChanged={refresh} />
      <CustomsDefaultsCard settings={settings} onChanged={refresh} />
    </div>
  );
}

function CredentialsCard({ settings, onChanged }: { settings: RmSettings; onChanged: () => Promise<void> }) {
  const [apiKey, setApiKey] = useState("");
  const [useSandbox, setUseSandbox] = useState(settings.use_sandbox);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => { setUseSandbox(settings.use_sandbox); }, [settings.use_sandbox]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { use_sandbox: useSandbox };
      if (apiKey.trim()) payload.api_key = apiKey.trim();
      await api("/api/royal-mail/credentials", { method: "PUT", body: payload });
      setApiKey("");
      await onChanged();
      toast.success("Credentials saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally { setSaving(false); }
  };

  const clearKey = async () => {
    if (!confirm("Remove the saved API key?")) return;
    try {
      await api("/api/royal-mail/credentials", {
        method: "PUT",
        body: { api_key: "__clear__", use_sandbox: useSandbox },
      });
      await onChanged();
      toast.success("Removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Remove failed");
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const res = await api<{ ok: boolean; message?: string; status?: number }>(
        "/api/royal-mail/test-connection",
        { method: "POST" },
      );
      await onChanged();
      if (res.ok) toast.success(res.message || "Connected");
      else toast.error(res.message || `Failed (${res.status ?? "?"})`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally { setTesting(false); }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <KeyRound className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div>
              <CardTitle>API key</CardTitle>
              <CardDescription>
                Generate a key in your Click &amp; Drop account under{" "}
                <span className="font-medium">Settings → Integrations → Create new API key</span>.
              </CardDescription>
            </div>
          </div>
          <ConnectionBadge settings={settings} />
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4" autoComplete="off">
          <input type="text" name="prevent-autofill" className="hidden" tabIndex={-1} aria-hidden />
          <input type="password" name="prevent-autofill-pw" className="hidden" tabIndex={-1} aria-hidden />
          <div className="space-y-2">
            <Label htmlFor="rm-api-key" className="flex items-center justify-between">
              <span>Click &amp; Drop API key</span>
              {settings.has_api_key && (
                <button type="button" onClick={clearKey}
                  className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1">
                  <Trash2 className="h-3 w-3" /> Remove
                </button>
              )}
            </Label>
            <Input id="rm-api-key" type="password" value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings.has_api_key ? "•••••••• (saved — leave blank to keep)" : "Paste your Click & Drop API key"}
              autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="rm-sandbox" className="font-medium">Sandbox key</Label>
              <p className="text-xs text-muted-foreground">
                Tick this if you pasted a Click &amp; Drop sandbox key rather than a live one.
              </p>
            </div>
            <Switch id="rm-sandbox" checked={useSandbox} onCheckedChange={setUseSandbox} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save credentials
            </Button>
            <Button type="button" variant="secondary" disabled={!settings.has_api_key || testing} onClick={test}>
              {testing && <Loader2 className="h-4 w-4 animate-spin" />}
              Test connection
            </Button>
          </div>
          {settings.last_tested_at && (
            <p className="text-xs text-muted-foreground">
              Last tested {new Date(settings.last_tested_at).toLocaleString()}
              {settings.last_test_message ? ` — ${settings.last_test_message}` : ""}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function ConnectionBadge({ settings }: { settings: RmSettings }) {
  if (!settings.has_api_key) return <Badge variant="outline">Not configured</Badge>;
  if (settings.last_test_ok === true) {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300">
        <CheckCircle2 className="h-3 w-3" /> Connected
      </Badge>
    );
  }
  if (settings.last_test_ok === false) {
    return (
      <Badge variant="destructive">
        <AlertCircle className="h-3 w-3" /> Last test failed
      </Badge>
    );
  }
  return <Badge variant="secondary">Saved — not tested</Badge>;
}

function SenderCard({ settings, onChanged }: { settings: RmSettings; onChanged: () => Promise<void> }) {
  const [form, setForm] = useState({
    sender_name: settings.sender_name ?? "",
    sender_company: settings.sender_company ?? "",
    sender_address_line1: settings.sender_address_line1 ?? "",
    sender_address_line2: settings.sender_address_line2 ?? "",
    sender_city: settings.sender_city ?? "",
    sender_postcode: settings.sender_postcode ?? "",
    sender_country: settings.sender_country ?? "GB",
    sender_phone: settings.sender_phone ?? "",
    sender_email: settings.sender_email ?? "",
  });
  const [saving, setSaving] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/api/royal-mail/sender", { method: "PUT", body: form });
      await onChanged();
      toast.success("Sender address saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <MapPin className="h-5 w-5 text-muted-foreground mt-0.5" />
          <div>
            <CardTitle>Sender address</CardTitle>
            <CardDescription>
              Printed as the "from" block on every Royal Mail label you generate.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <Field id="s-name" label="Name" value={form.sender_name} onChange={set("sender_name")} />
            <Field id="s-company" label="Company" value={form.sender_company} onChange={set("sender_company")} />
          </div>
          <Field id="s-line1" label="Address line 1" value={form.sender_address_line1} onChange={set("sender_address_line1")} />
          <Field id="s-line2" label="Address line 2 (optional)" value={form.sender_address_line2} onChange={set("sender_address_line2")} />
          <div className="grid sm:grid-cols-3 gap-4">
            <Field id="s-city" label="City" value={form.sender_city} onChange={set("sender_city")} />
            <Field id="s-postcode" label="Postcode" value={form.sender_postcode} onChange={set("sender_postcode")} />
            <Field id="s-country" label="Country (ISO)" value={form.sender_country} onChange={set("sender_country")} maxLength={3} />
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field id="s-phone" label="Phone" value={form.sender_phone} onChange={set("sender_phone")} />
            <Field id="s-email" label="Email" value={form.sender_email} onChange={set("sender_email")} type="email" />
          </div>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save sender address
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function CustomsDefaultsCard({ settings, onChanged }: { settings: RmSettings; onChanged: () => Promise<void> }) {
  const [form, setForm] = useState({
    default_origin_country: settings.default_origin_country ?? "GB",
    eori_number: settings.eori_number ?? "",
    ioss_number: settings.ioss_number ?? "",
    default_content_type: (settings.default_content_type ?? "saleOfGoods") as RmCustomsContentType,
  });
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      // The sender PUT accepts the customs fields too, so reuse it and pass
      // the existing sender values back unchanged.
      await api("/api/royal-mail/sender", {
        method: "PUT",
        body: {
          sender_name: settings.sender_name ?? "",
          sender_company: settings.sender_company ?? "",
          sender_address_line1: settings.sender_address_line1 ?? "",
          sender_address_line2: settings.sender_address_line2 ?? "",
          sender_city: settings.sender_city ?? "",
          sender_postcode: settings.sender_postcode ?? "",
          sender_country: settings.sender_country ?? "GB",
          sender_phone: settings.sender_phone ?? "",
          sender_email: settings.sender_email ?? "",
          ...form,
        },
      });
      await onChanged();
      toast.success("Customs defaults saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <Globe className="h-5 w-5 text-muted-foreground mt-0.5" />
          <div>
            <CardTitle>Customs defaults (international)</CardTitle>
            <CardDescription>
              Used to populate the CN22/CN23 customs declaration on international Click &amp; Drop orders. EORI/IOSS are optional — when set they're attached to every non-UK shipment.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <Field
              id="c-origin"
              label="Default origin country (ISO-2)"
              value={form.default_origin_country}
              onChange={(e) => setForm((f) => ({ ...f, default_origin_country: e.target.value.toUpperCase() }))}
              maxLength={2}
            />
            <div className="space-y-2">
              <Label htmlFor="c-content">Default content type</Label>
              <Select
                value={form.default_content_type}
                onValueChange={(v) => setForm((f) => ({ ...f, default_content_type: v as RmCustomsContentType }))}
              >
                <SelectTrigger id="c-content"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="saleOfGoods">Sale of goods</SelectItem>
                  <SelectItem value="gift">Gift</SelectItem>
                  <SelectItem value="commercialSample">Commercial sample</SelectItem>
                  <SelectItem value="returnedGoods">Returned goods</SelectItem>
                  <SelectItem value="documents">Documents</SelectItem>
                  <SelectItem value="mixedContent">Mixed content</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field
              id="c-eori"
              label="EORI number (optional)"
              value={form.eori_number}
              onChange={(e) => setForm((f) => ({ ...f, eori_number: e.target.value }))}
              maxLength={40}
            />
            <Field
              id="c-ioss"
              label="IOSS number (optional)"
              value={form.ioss_number}
              onChange={(e) => setForm((f) => ({ ...f, ioss_number: e.target.value }))}
              maxLength={40}
            />
          </div>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save customs defaults
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  id, label, value, onChange, type = "text", maxLength,
}: {
  id: string; label: string; value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: string; maxLength?: number;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={onChange} maxLength={maxLength} />
    </div>
  );
}
