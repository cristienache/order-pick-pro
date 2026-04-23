import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Package, KeyRound, MapPin, CheckCircle2, AlertCircle, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/packeta")({
  component: () => (
    <RequireAuth>
      <AppShell>
        <PacketaPage />
      </AppShell>
    </RequireAuth>
  ),
  head: () => ({
    meta: [
      { title: "Packeta | Ultrax" },
      { name: "description", content: "Connect Packeta and configure your sender address for EU shipments." },
    ],
  }),
});

// Mirror of server-side packetaRowToPublic shape.
type PacketaSettings = {
  has_api_password: boolean;
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
        description="Connect your Packeta account to generate EU shipping labels from inside Ultrax."
      />

      <CredentialsCard settings={settings} onChanged={refresh} />
      <SenderCard settings={settings} onChanged={refresh} />
    </div>
  );
}

// ---------- Credentials ----------

function CredentialsCard({ settings, onChanged }: { settings: PacketaSettings; onChanged: () => Promise<void> }) {
  const [apiPassword, setApiPassword] = useState("");
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
      await api("/api/packeta/credentials", { method: "PUT", body: payload });
      setApiPassword("");
      await onChanged();
      toast.success("Credentials saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
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
    } finally {
      setTesting(false);
    }
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
                <span className="font-medium">Settings → API</span>. See the{" "}
                <a
                  href="https://docs.packeta.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground"
                >
                  Packeta API docs
                </a>{" "}
                for details.
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
                <button
                  type="button"
                  onClick={clearKey}
                  className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1"
                >
                  <Trash2 className="h-3 w-3" /> Remove
                </button>
              )}
            </Label>
            <Input
              id="packeta-api-password"
              type="password"
              value={apiPassword}
              onChange={(e) => setApiPassword(e.target.value)}
              placeholder={settings.has_api_password ? "•••••••• (saved — leave blank to keep)" : "Paste your Packeta API password"}
              autoComplete="new-password"
              data-lpignore="true"
              data-1p-ignore="true"
            />
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="packeta-sandbox" className="font-medium">Sandbox / test password</Label>
              <p className="text-xs text-muted-foreground">
                Tick this if you pasted a Packeta test-environment password rather than a live one.
              </p>
            </div>
            <Switch id="packeta-sandbox" checked={useSandbox} onCheckedChange={setUseSandbox} />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save credentials
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!settings.has_api_password || testing}
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

function ConnectionBadge({ settings }: { settings: PacketaSettings }) {
  if (!settings.has_api_password) {
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

function SenderCard({ settings, onChanged }: { settings: PacketaSettings; onChanged: () => Promise<void> }) {
  const [form, setForm] = useState({
    sender_name: settings.sender_name ?? "",
    sender_company: settings.sender_company ?? "",
    sender_address_line1: settings.sender_address_line1 ?? "",
    sender_address_line2: settings.sender_address_line2 ?? "",
    sender_city: settings.sender_city ?? "",
    sender_postcode: settings.sender_postcode ?? "",
    sender_country: settings.sender_country ?? "CZ",
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
      await api("/api/packeta/sender", { method: "PUT", body: form });
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
              Printed as the "from" block on every Packeta label you generate.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
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
