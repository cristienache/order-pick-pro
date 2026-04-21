import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Truck, KeyRound, MapPin, CheckCircle2, AlertCircle, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/royal-mail")({
  component: () => (
    <RequireAuth>
      <AppShell>
        <RoyalMailPage />
      </AppShell>
    </RequireAuth>
  ),
});

// Mirror of server-side rmRowToPublic shape.
type RmSettings = {
  has_client_id: boolean;
  has_client_secret: boolean;
  use_sandbox: boolean;
  sender_name: string | null;
  sender_company: string | null;
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
      <header className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
          <Truck className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold leading-tight">Royal Mail</h1>
          <p className="text-sm text-muted-foreground">
            Connect your OBA account to generate shipping labels from inside Ultrax.
          </p>
        </div>
      </header>

      <CredentialsCard settings={settings} onChanged={refresh} />
      <SenderCard settings={settings} onChanged={refresh} />
    </div>
  );
}

// ---------- Credentials ----------

function CredentialsCard({ settings, onChanged }: { settings: RmSettings; onChanged: () => Promise<void> }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [useSandbox, setUseSandbox] = useState(settings.use_sandbox);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Keep the sandbox toggle in sync if a Test Connection updates the settings.
  useEffect(() => { setUseSandbox(settings.use_sandbox); }, [settings.use_sandbox]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      // Send only fields the user actually typed; empty string means "leave alone".
      const payload: Record<string, unknown> = { use_sandbox: useSandbox };
      if (clientId.trim()) payload.client_id = clientId.trim();
      if (clientSecret.trim()) payload.client_secret = clientSecret.trim();
      await api("/api/royal-mail/credentials", { method: "PUT", body: payload });
      setClientId("");
      setClientSecret("");
      await onChanged();
      toast.success("Credentials saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const clearField = async (field: "client_id" | "client_secret") => {
    if (!confirm(`Remove the saved ${field === "client_id" ? "Client ID" : "Client Secret"}?`)) return;
    try {
      await api("/api/royal-mail/credentials", {
        method: "PUT",
        body: { [field]: "__clear__", use_sandbox: useSandbox },
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
    } finally {
      setTesting(false);
    }
  };

  const hasBoth = settings.has_client_id && settings.has_client_secret;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <KeyRound className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div>
              <CardTitle>API credentials</CardTitle>
              <CardDescription>
                Get these from{" "}
                <a
                  href="https://developer.royalmail.net"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground"
                >
                  developer.royalmail.net
                </a>{" "}
                after your OBA account is approved for Shipping API v3.
              </CardDescription>
            </div>
          </div>
          <ConnectionBadge settings={settings} />
        </div>
      </CardHeader>
      <CardContent>
        {/* autoComplete=off + honeypot keeps Chrome from clobbering these fields
            (same trick we use on the WooCommerce site form). */}
        <form onSubmit={save} className="space-y-4" autoComplete="off">
          <input type="text" name="prevent-autofill" className="hidden" tabIndex={-1} aria-hidden />
          <input type="password" name="prevent-autofill-pw" className="hidden" tabIndex={-1} aria-hidden />

          <div className="space-y-2">
            <Label htmlFor="rm-client-id" className="flex items-center justify-between">
              <span>Client ID</span>
              {settings.has_client_id && (
                <button
                  type="button"
                  onClick={() => clearField("client_id")}
                  className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1"
                >
                  <Trash2 className="h-3 w-3" /> Remove
                </button>
              )}
            </Label>
            <Input
              id="rm-client-id"
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={settings.has_client_id ? "•••••••• (saved — leave blank to keep)" : "Paste your X-IBM-Client-Id"}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="rm-client-secret" className="flex items-center justify-between">
              <span>Client Secret</span>
              {settings.has_client_secret && (
                <button
                  type="button"
                  onClick={() => clearField("client_secret")}
                  className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1"
                >
                  <Trash2 className="h-3 w-3" /> Remove
                </button>
              )}
            </Label>
            <Input
              id="rm-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={settings.has_client_secret ? "•••••••• (saved — leave blank to keep)" : "Paste your X-IBM-Client-Secret"}
              autoComplete="new-password"
              data-lpignore="true"
              data-1p-ignore="true"
            />
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="rm-sandbox" className="font-medium">Use sandbox endpoints</Label>
              <p className="text-xs text-muted-foreground">
                Calls go to the Royal Mail test environment instead of production.
              </p>
            </div>
            <Switch id="rm-sandbox" checked={useSandbox} onCheckedChange={setUseSandbox} />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save credentials
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!hasBoth || testing}
              onClick={test}
            >
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
  if (!settings.has_client_id || !settings.has_client_secret) {
    return <Badge variant="outline">Not configured</Badge>;
  }
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

// ---------- Sender address ----------

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
    } finally {
      setSaving(false);
    }
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
