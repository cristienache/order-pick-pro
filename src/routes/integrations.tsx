import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, type Site, type EbayAccount } from "@/lib/api";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Plus, Trash2, Loader2, Store, MapPin, KeyRound, Link2 } from "lucide-react";
import { toast } from "sonner";
import wooLogo from "@/assets/integrations/woocommerce.svg";
import shopifyLogo from "@/assets/integrations/shopify.svg";
import etsyLogo from "@/assets/integrations/etsy.svg";
import magentoLogo from "@/assets/integrations/magento.svg";
import ebayLogo from "@/assets/integrations/ebay.svg";

export const Route = createFileRoute("/integrations")({
  component: () => <RequireAuth><AppShell><SitesPage /></AppShell></RequireAuth>,
  head: () => ({
    meta: [
      { title: "Integrations | Ultrax" },
      { name: "description", content: "Connect WooCommerce stores and other sales channels." },
    ],
  }),
});

// ---------- Form types — split so the two dialogs can never share state ----------
type CredsForm = {
  name: string;
  store_url: string;
  consumer_key: string;
  consumer_secret: string;
};
type AddressForm = {
  return_name: string;
  return_company: string;
  return_line1: string;
  return_line2: string;
  return_city: string;
  return_postcode: string;
  return_country: string;
};
const emptyCreds: CredsForm = { name: "", store_url: "", consumer_key: "", consumer_secret: "" };
const emptyAddress: AddressForm = {
  return_name: "", return_company: "", return_line1: "", return_line2: "",
  return_city: "", return_postcode: "", return_country: "",
};

function SitesPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);

  // Two completely independent dialogs.
  const [credsOpen, setCredsOpen] = useState(false);
  const [credsEditing, setCredsEditing] = useState<Site | null>(null);
  const [credsForm, setCredsForm] = useState<CredsForm>(emptyCreds);
  const [credsSaving, setCredsSaving] = useState(false);

  const [addrOpen, setAddrOpen] = useState(false);
  const [addrEditing, setAddrEditing] = useState<Site | null>(null);
  const [addrForm, setAddrForm] = useState<AddressForm>(emptyAddress);
  const [addrSaving, setAddrSaving] = useState(false);

  const [deleteId, setDeleteId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { sites } = await api<{ sites: Site[] }>("/api/sites");
      setSites(sites);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // ---------- Credentials dialog ----------
  const openCreate = () => {
    setCredsEditing(null);
    setCredsForm(emptyCreds);
    setCredsOpen(true);
  };
  const openEditCreds = (s: Site) => {
    setCredsEditing(s);
    // Keys are write-only — never returned. The user must re-enter them.
    setCredsForm({
      name: s.name,
      store_url: s.store_url,
      consumer_key: "",
      consumer_secret: "",
    });
    setCredsOpen(true);
  };
  const saveCreds = async (e: React.FormEvent) => {
    e.preventDefault();
    setCredsSaving(true);
    try {
      // The credentials endpoint still uses the full siteSchema (keeps the
      // existing return-address fields untouched on the server side because
      // we re-send them from the existing Site object).
      const payload = {
        ...credsForm,
        return_name: credsEditing?.return_name ?? "",
        return_company: credsEditing?.return_company ?? "",
        return_line1: credsEditing?.return_line1 ?? "",
        return_line2: credsEditing?.return_line2 ?? "",
        return_city: credsEditing?.return_city ?? "",
        return_postcode: credsEditing?.return_postcode ?? "",
        return_country: credsEditing?.return_country ?? "",
      };
      if (credsEditing) {
        await api(`/api/sites/${credsEditing.id}`, { method: "PUT", body: payload });
        toast.success("Credentials updated");
      } else {
        await api("/api/sites", { body: payload });
        toast.success("Site added");
      }
      setCredsOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally { setCredsSaving(false); }
  };

  // ---------- Return-address dialog ----------
  const openEditAddress = (s: Site) => {
    setAddrEditing(s);
    setAddrForm({
      return_name: s.return_name ?? "",
      return_company: s.return_company ?? "",
      return_line1: s.return_line1 ?? "",
      return_line2: s.return_line2 ?? "",
      return_city: s.return_city ?? "",
      return_postcode: s.return_postcode ?? "",
      return_country: s.return_country ?? "",
    });
    setAddrOpen(true);
  };
  const saveAddress = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addrEditing) return;
    setAddrSaving(true);
    try {
      // Dedicated endpoint — never sees consumer_key / consumer_secret.
      await api(`/api/sites/${addrEditing.id}/return-address`, {
        method: "PATCH",
        body: addrForm,
      });
      toast.success("Return address saved");
      setAddrOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save address");
    } finally { setAddrSaving(false); }
  };

  const remove = async () => {
    if (deleteId == null) return;
    try {
      await api(`/api/sites/${deleteId}`, { method: "DELETE" });
      toast.success("Site removed");
      setDeleteId(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Store}
        accent="amber"
        eyebrow="Connections"
        title="Integrations"
        description="Connect your sales channels. WooCommerce stores can be added today — more platforms coming soon."
        actions={
          <Dialog open={credsOpen} onOpenChange={setCredsOpen}>
            <DialogTrigger asChild>
              <Button onClick={openCreate}><Plus className="h-4 w-4" /> Add site</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>
                  {credsEditing ? "Edit credentials" : "Add WooCommerce site"}
                </DialogTitle>
                <DialogDescription>
                  Generate REST API keys in WooCommerce → Settings → Advanced → REST API. Permissions: Read/Write.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={saveCreds} className="space-y-4" autoComplete="off">
                <input type="text" name="prevent-autofill" autoComplete="off" style={{ display: "none" }} />
                <input type="password" name="prevent-password-autofill" autoComplete="new-password" style={{ display: "none" }} />

                <div className="space-y-2">
                  <Label htmlFor="name">Display name</Label>
                  <Input id="name" name="display-name" value={credsForm.name} required maxLength={100}
                    autoComplete="off"
                    onChange={(e) => setCredsForm({ ...credsForm, name: e.target.value })}
                    placeholder="Ultraskins UK" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="store_url">Store URL</Label>
                  <Input id="store_url" name="store-url" type="url" value={credsForm.store_url} required
                    autoComplete="off"
                    onChange={(e) => setCredsForm({ ...credsForm, store_url: e.target.value })}
                    placeholder="https://www.example.com" />
                  <p className="text-xs text-muted-foreground">Include https:// and www if applicable.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ck">Consumer key</Label>
                  <Input id="ck" name="wc-consumer-key" value={credsForm.consumer_key} required
                    autoComplete="off" data-lpignore="true" data-1p-ignore="true"
                    onChange={(e) => setCredsForm({ ...credsForm, consumer_key: e.target.value })}
                    placeholder="ck_..." />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cs">Consumer secret</Label>
                  <Input id="cs" name="wc-consumer-secret" type="password" value={credsForm.consumer_secret} required
                    autoComplete="new-password" data-lpignore="true" data-1p-ignore="true"
                    onChange={(e) => setCredsForm({ ...credsForm, consumer_secret: e.target.value })}
                    placeholder="cs_..." />
                </div>

                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setCredsOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={credsSaving}>
                    {credsSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                    {credsEditing ? "Save credentials" : "Add site"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        }
      />

      {/* ---------- Return-address dialog (separate, no key fields exist) ---------- */}
      <Dialog open={addrOpen} onOpenChange={setAddrOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Return address — {addrEditing?.name}</DialogTitle>
            <DialogDescription>
              Printed on the 4×6 shipping label as the sender. Required to generate
              shipping labels for this site. Saving here does NOT touch your API keys.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveAddress} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="ra_name">Sender name</Label>
                <Input id="ra_name" name="name" autoComplete="name"
                  value={addrForm.return_name} maxLength={100}
                  onChange={(e) => setAddrForm({ ...addrForm, return_name: e.target.value })}
                  placeholder="Jane Doe" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ra_company">Company (optional)</Label>
                <Input id="ra_company" name="organization" autoComplete="organization"
                  value={addrForm.return_company} maxLength={100}
                  onChange={(e) => setAddrForm({ ...addrForm, return_company: e.target.value })}
                  placeholder="Ultraskins Ltd" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ra_line1">Address line 1</Label>
              <Input id="ra_line1" name="address-line1" autoComplete="address-line1"
                value={addrForm.return_line1} maxLength={150}
                onChange={(e) => setAddrForm({ ...addrForm, return_line1: e.target.value })}
                placeholder="Unit 4, Trade Park" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ra_line2">Address line 2 (optional)</Label>
              <Input id="ra_line2" name="address-line2" autoComplete="address-line2"
                value={addrForm.return_line2} maxLength={150}
                onChange={(e) => setAddrForm({ ...addrForm, return_line2: e.target.value })}
                placeholder="Industrial Estate" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2 col-span-2">
                <Label htmlFor="ra_city">City</Label>
                <Input id="ra_city" name="address-level2" autoComplete="address-level2"
                  value={addrForm.return_city} maxLength={80}
                  onChange={(e) => setAddrForm({ ...addrForm, return_city: e.target.value })}
                  placeholder="Manchester" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ra_postcode">Postcode</Label>
                <Input id="ra_postcode" name="postal-code" autoComplete="postal-code"
                  value={addrForm.return_postcode} maxLength={20}
                  onChange={(e) => setAddrForm({ ...addrForm, return_postcode: e.target.value.toUpperCase() })}
                  placeholder="M1 1AA" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ra_country">Country (optional)</Label>
              <Input id="ra_country" name="country-name" autoComplete="country-name"
                value={addrForm.return_country} maxLength={60}
                onChange={(e) => setAddrForm({ ...addrForm, return_country: e.target.value })}
                placeholder="United Kingdom" />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddrOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={addrSaving}>
                {addrSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                Save return address
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : sites.length === 0 ? (
        <Card>
          <CardHeader className="text-center py-12">
            <img src={wooLogo} alt="WooCommerce logo" className="h-10 w-10 mx-auto mb-2" />
            <CardTitle>No WooCommerce sites yet</CardTitle>
            <CardDescription>Add your first WooCommerce store to start generating picklists.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {sites.map((s) => {
            const hasReturnAddr = Boolean(
              (s.return_name || s.return_company) &&
              s.return_line1 && s.return_city && s.return_postcode,
            );
            return (
              <Card key={s.id}>
                <CardContent className="p-4 flex items-start justify-between gap-3">
                  <img src={wooLogo} alt="WooCommerce" className="h-8 w-8 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold truncate">{s.name}</div>
                    <div className="text-sm text-muted-foreground truncate">{s.store_url}</div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-xs text-muted-foreground">
                        Added {new Date(s.created_at).toLocaleDateString()}
                      </span>
                      <span
                        className={
                          "text-[10px] px-1.5 py-0.5 rounded-md border " +
                          (hasReturnAddr
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400")
                        }
                        title={
                          hasReturnAddr
                            ? "Return address set — 4×6 shipping labels available"
                            : "Add a return address to enable 4×6 shipping labels"
                        }
                      >
                        {hasReturnAddr ? "Return address ✓" : "No return address"}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" onClick={() => openEditAddress(s)}
                      title="Edit return address">
                      <MapPin className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => openEditCreds(s)}
                      title="Edit API credentials">
                      <KeyRound className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => setDeleteId(s.id)}
                      title="Delete site">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* eBay accounts (live OAuth) */}
      <EbaySection />

      {/* Other channels — visible so users know they're planned, but not yet
          wired to a backend connector. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Other channels</CardTitle>
          <CardDescription>
            We're building connectors for these platforms. Let us know which one you need next.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { name: "Shopify", logo: shopifyLogo },
              { name: "Etsy", logo: etsyLogo },
              { name: "Magento", logo: magentoLogo },
            ].map((c) => (
              <div
                key={c.name}
                className="flex items-center gap-3 rounded-lg border border-dashed p-3 opacity-80"
                title={`${c.name} integration coming soon`}
              >
                <img src={c.logo} alt={`${c.name} logo`} className="h-8 w-8 object-contain" />
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{c.name}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Coming soon
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this site?</AlertDialogTitle>
            <AlertDialogDescription>The site and its API keys will be permanently removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
