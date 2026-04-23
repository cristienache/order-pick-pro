import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { api, type PacketaCarrier, type PacketaCountryRoute } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Loader2, Package, KeyRound, MapPin, CheckCircle2, AlertCircle, Trash2, Globe, RefreshCw, Plus, Pencil,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/integrations/shipping/packeta")({
  component: PacketaPage,
  head: () => ({
    meta: [
      { title: "Packeta | Ultrax" },
      { name: "description", content: "Connect Packeta and configure country routing for EU shipments." },
    ],
  }),
});

type PacketaSettings = {
  has_api_password: boolean;
  has_widget_api_key: boolean;
  use_sandbox: boolean;
  sender_name: string | null;
  sender_company: string | null;
  sender_label: string | null;
  sender_address_line1: string | null;
  sender_address_line2: string | null;
  sender_city: string | null;
  sender_postcode: string | null;
  sender_country: string;
  sender_phone: string | null;
  sender_email: string | null;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
};

function PacketaPage() {
  const [settings, setSettings] = useState<PacketaSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = () =>
    api<{ settings: PacketaSettings }>("/api/packeta/settings").then((r) => setSettings(r.settings));

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
        icon={Package}
        accent="rose"
        eyebrow="Shipping carrier"
        title="Packeta"
        description="Connect your Packeta account, set the sender address, and choose a carrier per destination country."
      />

      <CredentialsCard settings={settings} onChanged={refresh} />
      <SenderCard settings={settings} onChanged={refresh} />
      <CountryRoutesCard hasApiPassword={settings.has_api_password && settings.has_widget_api_key} />
    </div>
  );
}

// ---------- Credentials ----------

function CredentialsCard({ settings, onChanged }: { settings: PacketaSettings; onChanged: () => Promise<void> }) {
  const [apiPassword, setApiPassword] = useState("");
  const [widgetApiKey, setWidgetApiKey] = useState("");
  const [useSandbox, setUseSandbox] = useState(settings.use_sandbox);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => { setUseSandbox(settings.use_sandbox); }, [settings.use_sandbox]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { use_sandbox: useSandbox };
      if (apiPassword.trim()) payload.api_password = apiPassword.trim();
      if (widgetApiKey.trim()) payload.widget_api_key = widgetApiKey.trim();
      await api("/api/packeta/credentials", { method: "PUT", body: payload });
      setApiPassword("");
      setWidgetApiKey("");
      await onChanged();
      toast.success("Credentials saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally { setSaving(false); }
  };

  const clearKey = async () => {
    if (!confirm("Remove the saved API password?")) return;
    try {
      await api("/api/packeta/credentials", {
        method: "PUT",
        body: { api_password: "__clear__", use_sandbox: useSandbox },
      });
      await onChanged();
      toast.success("Removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Remove failed");
    }
  };

  const clearWidget = async () => {
    if (!confirm("Remove the saved Widget API key?")) return;
    try {
      await api("/api/packeta/credentials", {
        method: "PUT",
        body: { widget_api_key: "__clear__", use_sandbox: useSandbox },
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
        "/api/packeta/test-connection",
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
              <CardTitle>API password</CardTitle>
              <CardDescription>
                Sign in to your Packeta client section and copy the API password from{" "}
                <span className="font-medium">Settings → API</span>.
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
            <Label htmlFor="packeta-api-password" className="flex items-center justify-between">
              <span>Packeta API password</span>
              {settings.has_api_password && (
                <button type="button" onClick={clearKey}
                  className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1">
                  <Trash2 className="h-3 w-3" /> Remove
                </button>
              )}
            </Label>
            <Input id="packeta-api-password" type="password" value={apiPassword}
              onChange={(e) => setApiPassword(e.target.value)}
              placeholder={settings.has_api_password ? "•••••••• (saved — leave blank to keep)" : "Paste your Packeta API password"}
              autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" />
            <p className="text-xs text-muted-foreground">
              Used for the SOAP/REST API (creating packets, downloading labels).
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="packeta-widget-key" className="flex items-center justify-between">
              <span>Packeta Widget API key</span>
              {settings.has_widget_api_key && (
                <button type="button" onClick={clearWidget}
                  className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1">
                  <Trash2 className="h-3 w-3" /> Remove
                </button>
              )}
            </Label>
            <Input id="packeta-widget-key" type="password" value={widgetApiKey}
              onChange={(e) => setWidgetApiKey(e.target.value)}
              placeholder={settings.has_widget_api_key ? "•••••••• (saved — leave blank to keep)" : "Paste your Packeta Widget API key"}
              autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" />
            <p className="text-xs text-muted-foreground">
              A separate, shorter credential used for the public carrier and pickup-point feeds.
              Required to refresh the carrier list. Find it in the Packeta client section under{" "}
              <span className="font-medium">Settings → API</span> (labelled <em>API key</em>, not <em>API password</em>).
            </p>
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="packeta-sandbox" className="font-medium">Sandbox / test password</Label>
              <p className="text-xs text-muted-foreground">
                Tick this if you pasted a Packeta test-environment password.
              </p>
            </div>
            <Switch id="packeta-sandbox" checked={useSandbox} onCheckedChange={setUseSandbox} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save credentials
            </Button>
            <Button type="button" variant="secondary" disabled={!settings.has_api_password || testing} onClick={test}>
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

function ConnectionBadge({ settings }: { settings: PacketaSettings }) {
  if (!settings.has_api_password) return <Badge variant="outline">Not configured</Badge>;
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

// ---------- Sender ----------

function SenderCard({ settings, onChanged }: { settings: PacketaSettings; onChanged: () => Promise<void> }) {
  const [form, setForm] = useState({
    sender_name: settings.sender_name ?? "",
    sender_company: settings.sender_company ?? "",
    sender_label: settings.sender_label ?? "",
    sender_address_line1: settings.sender_address_line1 ?? "",
    sender_address_line2: settings.sender_address_line2 ?? "",
    sender_city: settings.sender_city ?? "",
    sender_postcode: settings.sender_postcode ?? "",
    sender_country: settings.sender_country ?? "CZ",
    sender_phone: settings.sender_phone ?? "",
    sender_email: settings.sender_email ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/api/packeta/sender", { method: "PUT", body: form });
      await onChanged();
      toast.success("Sender address saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally { setSaving(false); }
  };

  // Packeta's API has no "list senders" method — we can only validate a
  // user-supplied label via senderGetReturnRouting. This button does that
  // round-trip and surfaces whether the label is registered.
  const verify = async () => {
    const label = form.sender_label.trim();
    if (!label) {
      toast.error("Enter a Sender ID first");
      return;
    }
    setVerifying(true);
    try {
      const r = await api<{ ok: boolean; message?: string; error?: string }>(
        "/api/packeta/verify-sender",
        { method: "POST", body: { sender_label: label } },
      );
      if (r.ok) toast.success(r.message || "Sender verified");
      else toast.error(r.message || r.error || "Sender not recognised");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Verification failed");
    } finally { setVerifying(false); }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <MapPin className="h-5 w-5 text-muted-foreground mt-0.5" />
          <div>
            <CardTitle>Sender address</CardTitle>
            <CardDescription>
              Printed as the "from" block on every Packeta label you generate.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
            <Label htmlFor="ps-label" className="font-medium">
              Sender ID (eshop) <span className="text-destructive">*</span>
            </Label>
            <div className="flex gap-2">
              <Input
                id="ps-label"
                value={form.sender_label}
                onChange={set("sender_label")}
                placeholder="e.g. myshop"
                maxLength={60}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                onClick={verify}
                disabled={verifying || !form.sender_label.trim() || !settings.has_api_password}
              >
                {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Verify
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The exact sender identifier registered in your Packeta account.
              Find it in the Packeta client section under{" "}
              <span className="font-medium">Settings → Senders</span> — it's the
              short code shown next to each registered sender.
              Packeta's API doesn't expose a list of senders, but{" "}
              <span className="font-medium">Verify</span> checks whether the ID
              you entered exists. Without a valid sender, label creation fails with{" "}
              <em>"Sender is not given. Please choose a sender."</em>
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field id="ps-name" label="Name" value={form.sender_name} onChange={set("sender_name")} />
            <Field id="ps-company" label="Company" value={form.sender_company} onChange={set("sender_company")} />
          </div>
          <Field id="ps-line1" label="Address line 1" value={form.sender_address_line1} onChange={set("sender_address_line1")} />
          <Field id="ps-line2" label="Address line 2 (optional)" value={form.sender_address_line2} onChange={set("sender_address_line2")} />
          <div className="grid sm:grid-cols-3 gap-4">
            <Field id="ps-city" label="City" value={form.sender_city} onChange={set("sender_city")} />
            <Field id="ps-postcode" label="Postcode" value={form.sender_postcode} onChange={set("sender_postcode")} />
            <Field id="ps-country" label="Country (ISO)" value={form.sender_country} onChange={set("sender_country")} maxLength={3} />
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field id="ps-phone" label="Phone" value={form.sender_phone} onChange={set("sender_phone")} />
            <Field id="ps-email" label="Email" value={form.sender_email} onChange={set("sender_email")} type="email" />
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

// ---------- Country routing ----------

type CarriersResp = { carriers: PacketaCarrier[]; last_synced_at: string | null };

function CountryRoutesCard({ hasApiPassword }: { hasApiPassword: boolean }) {
  const [routes, setRoutes] = useState<PacketaCountryRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [carriersByCountry, setCarriersByCountry] = useState<Record<string, PacketaCarrier[]>>({});

  const [editing, setEditing] = useState<PacketaCountryRoute | null>(null);
  const [creating, setCreating] = useState(false);

  const loadRoutes = async () => {
    try {
      const r = await api<{ routes: PacketaCountryRoute[] }>("/api/packeta/country-routes");
      setRoutes(r.routes);
    } catch {
      setRoutes([]);
    }
  };

  const loadCarriers = async (country?: string) => {
    try {
      const qs = country ? `?country=${country}` : "";
      const r = await api<CarriersResp>(`/api/packeta/carriers${qs}`);
      setLastSynced(r.last_synced_at);
      if (country) {
        setCarriersByCountry((m) => ({ ...m, [country]: r.carriers }));
      } else {
        // Bucket the whole list by country for fast lookup
        const buckets: Record<string, PacketaCarrier[]> = {};
        for (const c of r.carriers) {
          (buckets[c.country] ||= []).push(c);
        }
        setCarriersByCountry(buckets);
      }
    } catch {
      /* silent */
    }
  };

  useEffect(() => {
    Promise.all([loadRoutes(), loadCarriers()]).finally(() => setLoading(false));
  }, []);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api<{ ok: boolean; count?: number; error?: string }>(
        "/api/packeta/carriers/sync", { method: "POST" },
      );
      if (r.ok) {
        toast.success(`Synced ${r.count} carriers`);
        await loadCarriers();
      } else {
        toast.error(r.error || "Sync failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Remove this country routing rule?")) return;
    try {
      await api(`/api/packeta/country-routes/${id}`, { method: "DELETE" });
      toast.success("Removed");
      loadRoutes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Remove failed");
    }
  };

  const lastSyncLabel = useMemo(() => {
    if (!lastSynced) return "Never synced";
    const ms = Date.now() - Date.parse(lastSynced);
    if (!Number.isFinite(ms)) return "Unknown";
    const mins = Math.floor(ms / 60_000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }, [lastSynced]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <Globe className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div>
              <CardTitle>Country routing <span className="text-xs font-normal text-muted-foreground ml-2">(fallback)</span></CardTitle>
              <CardDescription>
                When the Packeta WooCommerce plugin is installed, HeyShop reads the
                carrier the customer chose at checkout (<code className="text-xs">packetery_carrier_id</code>)
                and the saved <code className="text-xs">packetery_weight</code> directly from each order — no
                country mapping needed. Use this table only as a fallback for orders that
                don't carry that meta (e.g. sites without the plugin).
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Carrier list: {lastSyncLabel}</span>
            <Button
              type="button" size="sm" variant="outline" onClick={sync}
              disabled={!hasApiPassword || syncing}
              title={!hasApiPassword ? "Save your Packeta API password and Widget API key first" : "Refresh carrier list from Packeta"}
            >
              {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
            <Button size="sm" onClick={() => setCreating(true)} disabled={!hasApiPassword}>
              <Plus className="h-3.5 w-3.5" /> Add country
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!hasApiPassword ? (
          <div className="text-sm text-muted-foreground border border-dashed rounded-md p-4 text-center">
            Save your Packeta API password above to enable country routing.
          </div>
        ) : loading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : routes.length === 0 ? (
          <div className="text-sm text-muted-foreground border border-dashed rounded-md p-4 text-center">
            No country rules yet. Add one to start labelling orders for that destination.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Country</TableHead>
                <TableHead>Carrier</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Default weight</TableHead>
                <TableHead className="w-20"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {routes.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono uppercase">{r.country}</TableCell>
                  <TableCell>{r.carrier_name || `Carrier ${r.carrier_id}`}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {r.is_pickup_points ? "Pickup point" : "Home delivery"}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular-nums">{r.default_weight_kg} kg</TableCell>
                  <TableCell>
                    <div className="flex gap-1 justify-end">
                      <Button size="icon" variant="ghost" onClick={() => setEditing(r)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => remove(r.id)}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <RouteDialog
        open={creating || !!editing}
        editing={editing}
        existingRoutes={routes}
        carriersByCountry={carriersByCountry}
        onLoadCountryCarriers={loadCarriers}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSaved={() => { loadRoutes(); setCreating(false); setEditing(null); }}
      />
    </Card>
  );
}

function RouteDialog({
  open, editing, existingRoutes, carriersByCountry, onLoadCountryCarriers, onClose, onSaved,
}: {
  open: boolean;
  editing: PacketaCountryRoute | null;
  existingRoutes: PacketaCountryRoute[];
  carriersByCountry: Record<string, PacketaCarrier[]>;
  onLoadCountryCarriers: (country: string) => Promise<void>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [country, setCountry] = useState("");
  const [carrierId, setCarrierId] = useState<string>("");
  const [weight, setWeight] = useState("0.5");
  const [value, setValue] = useState("0");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setCountry(editing.country);
      setCarrierId(String(editing.carrier_id));
      setWeight(String(editing.default_weight_kg));
      setValue(String(editing.default_value));
    } else {
      setCountry("");
      setCarrierId("");
      setWeight("0.5");
      setValue("0");
    }
  }, [open, editing]);

  useEffect(() => {
    if (country && !carriersByCountry[country]) {
      void onLoadCountryCarriers(country);
    }
  }, [country, carriersByCountry, onLoadCountryCarriers]);

  // Carriers already routed for this country (other than the row being edited).
  // Used to disable them in the dropdown so the user can't add the exact same
  // carrier twice — but they CAN add a second, different carrier per country
  // (e.g. NL Home delivery + NL Pickup point).
  const usedCarrierIds = useMemo(() => {
    const set = new Set<number>();
    for (const r of existingRoutes) {
      if (r.country !== country) continue;
      if (editing && r.id === editing.id) continue;
      set.add(r.carrier_id);
    }
    return set;
  }, [existingRoutes, country, editing]);

  const carriers = (country ? carriersByCountry[country] : []) || [];
  const duplicateCarrier = carrierId !== "" && usedCarrierIds.has(Number(carrierId));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!country || !carrierId || duplicateCarrier) return;
    setSaving(true);
    try {
      const body = {
        country,
        carrier_id: Number(carrierId),
        default_weight_kg: Number(weight) || 0.5,
        default_value: Number(value) || 0,
      };
      if (editing) {
        await api(`/api/packeta/country-routes/${editing.id}`, { method: "PUT", body });
      } else {
        await api("/api/packeta/country-routes", { body });
      }
      toast.success("Saved");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit country routing" : "Add country routing"}</DialogTitle>
          <DialogDescription>
            Choose which Packeta carrier to use for orders shipping to this country.
            You can add multiple carriers per country (e.g. Home delivery and Pickup point) —
            the right one is picked automatically based on whether the order has a pickup
            point selected.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cr-country">Country (ISO-2)</Label>
            <Input
              id="cr-country" value={country} maxLength={2}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
              placeholder="DE, FR, CZ..."
              disabled={!!editing}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cr-carrier">Carrier</Label>
            <Select value={carrierId} onValueChange={setCarrierId} disabled={!country || carriers.length === 0}>
              <SelectTrigger id="cr-carrier">
                <SelectValue placeholder={
                  !country ? "Pick a country first"
                  : carriers.length === 0 ? "No carriers available — refresh list"
                  : "Choose carrier"
                } />
              </SelectTrigger>
              <SelectContent>
                {carriers.map((c) => {
                  const used = usedCarrierIds.has(c.id);
                  return (
                    <SelectItem key={c.id} value={String(c.id)} disabled={used}>
                      {c.name} {c.is_pickup_points ? "· Pickup point" : "· Home delivery"}
                      {used ? " (already added)" : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {duplicateCarrier && (
              <p className="text-xs text-destructive">
                This carrier is already routed for {country}. Pick a different one or edit the existing rule.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="cr-weight">Default weight (kg)</Label>
              <Input id="cr-weight" type="number" step="0.1" min="0.1" value={weight}
                onChange={(e) => setWeight(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cr-value">Default declared value</Label>
              <Input id="cr-value" type="number" step="1" min="0" value={value}
                onChange={(e) => setValue(e.target.value)} />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              disabled={saving || !country || !carrierId || duplicateCarrier}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
