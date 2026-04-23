import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, type Site, type EbayAccount } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2, Loader2, Store, MapPin, KeyRound, Link2 } from "lucide-react";
import { toast } from "sonner";
import wooLogo from "@/assets/integrations/woocommerce.svg";
import shopifyLogo from "@/assets/integrations/shopify.svg";
import etsyLogo from "@/assets/integrations/etsy.svg";
import magentoLogo from "@/assets/integrations/magento.svg";
import ebayLogo from "@/assets/integrations/ebay.svg";

export const Route = createFileRoute("/integrations/channels")({
  component: ChannelsPage,
  head: () => ({
    meta: [
      { title: "Sales channels | Ultrax" },
      { name: "description", content: "Connect WooCommerce, eBay and other sales channels." },
    ],
  }),
});

// ---------- Form types ----------
type CredsForm = { name: string; store_url: string; consumer_key: string; consumer_secret: string };
type AddressForm = {
  return_name: string; return_company: string; return_line1: string; return_line2: string;
  return_city: string; return_postcode: string; return_country: string;
};
const emptyCreds: CredsForm = { name: "", store_url: "", consumer_key: "", consumer_secret: "" };
const emptyAddress: AddressForm = {
  return_name: "", return_company: "", return_line1: "", return_line2: "",
  return_city: "", return_postcode: "", return_country: "",
};

function ChannelsPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);

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

  const openCreate = () => {
    setCredsEditing(null);
    setCredsForm(emptyCreds);
    setCredsOpen(true);
  };
  const openEditCreds = (s: Site) => {
    setCredsEditing(s);
    setCredsForm({ name: s.name, store_url: s.store_url, consumer_key: "", consumer_secret: "" });
    setCredsOpen(true);
  };
  const saveCreds = async (e: React.FormEvent) => {
    e.preventDefault();
    setCredsSaving(true);
    try {
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
      await api(`/api/sites/${addrEditing.id}/return-address`, { method: "PATCH", body: addrForm });
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
        title="Sales channels"
        description="Connect WooCommerce stores and other sales channels."
        actions={
          <Dialog open={credsOpen} onOpenChange={setCredsOpen}>
            <DialogTrigger asChild>
              <Button onClick={openCreate}><Plus className="h-4 w-4" /> Add WooCommerce site</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>{credsEditing ? "Edit credentials" : "Add WooCommerce site"}</DialogTitle>
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

      {/* Return-address dialog */}
      <Dialog open={addrOpen} onOpenChange={setAddrOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Return address — {addrEditing?.name}</DialogTitle>
            <DialogDescription>
              Printed on the 4×6 shipping label as the sender. Required to generate
              shipping labels for this site.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveAddress} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="ra_name">Sender name</Label>
                <Input id="ra_name" value={addrForm.return_name} maxLength={100}
                  onChange={(e) => setAddrForm({ ...addrForm, return_name: e.target.value })} placeholder="Jane Doe" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ra_company">Company (optional)</Label>
                <Input id="ra_company" value={addrForm.return_company} maxLength={100}
                  onChange={(e) => setAddrForm({ ...addrForm, return_company: e.target.value })} placeholder="Ultraskins Ltd" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ra_line1">Address line 1</Label>
              <Input id="ra_line1" value={addrForm.return_line1} maxLength={150}
                onChange={(e) => setAddrForm({ ...addrForm, return_line1: e.target.value })} placeholder="Unit 4, Trade Park" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ra_line2">Address line 2 (optional)</Label>
              <Input id="ra_line2" value={addrForm.return_line2} maxLength={150}
                onChange={(e) => setAddrForm({ ...addrForm, return_line2: e.target.value })} placeholder="Industrial Estate" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2 col-span-2">
                <Label htmlFor="ra_city">City</Label>
                <Input id="ra_city" value={addrForm.return_city} maxLength={80}
                  onChange={(e) => setAddrForm({ ...addrForm, return_city: e.target.value })} placeholder="Manchester" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ra_postcode">Postcode</Label>
                <Input id="ra_postcode" value={addrForm.return_postcode} maxLength={20}
                  onChange={(e) => setAddrForm({ ...addrForm, return_postcode: e.target.value.toUpperCase() })} placeholder="M1 1AA" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ra_country">Country (optional)</Label>
              <Input id="ra_country" value={addrForm.return_country} maxLength={60}
                onChange={(e) => setAddrForm({ ...addrForm, return_country: e.target.value })} placeholder="United Kingdom" />
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

      {/* WooCommerce sites */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <img src={wooLogo} alt="WooCommerce" className="h-8 w-8" />
            <div>
              <CardTitle className="text-base">WooCommerce</CardTitle>
              <CardDescription>Connect one or more WooCommerce stores via REST API.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : sites.length === 0 ? (
            <div className="text-sm text-muted-foreground border border-dashed rounded-md p-4 text-center">
              No WooCommerce stores connected yet. Click "Add WooCommerce site" above.
            </div>
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
                          >
                            {hasReturnAddr ? "Return address ✓" : "No return address"}
                          </span>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button size="icon" variant="ghost" onClick={() => openEditAddress(s)} title="Edit return address">
                          <MapPin className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => openEditCreds(s)} title="Edit API credentials">
                          <KeyRound className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => setDeleteId(s.id)} title="Delete site">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <EbaySection />

      {/* Other channels — coming soon. */}
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
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Coming soon</div>
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

// ---------- eBay accounts (live OAuth) ----------
function EbaySection() {
  const [accounts, setAccounts] = useState<EbayAccount[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectName, setConnectName] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [cfg, list] = await Promise.all([
        api<{ configured: boolean }>("/api/ebay/config"),
        api<{ accounts: EbayAccount[] }>("/api/ebay/accounts"),
      ]);
      setConfigured(cfg.configured);
      setAccounts(list.accounts);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load eBay");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("ebay") !== "callback") return;
    const status = qs.get("status");
    if (status === "connected") {
      toast.success(`Connected eBay account: ${qs.get("name") || ""}`);
      load();
    } else if (status === "declined") {
      toast.warning("eBay connection was declined.");
    } else {
      toast.error(qs.get("error") || "eBay connection failed");
    }
    window.history.replaceState({}, "", "/integrations/channels");
  }, []);

  const startConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connectName.trim()) return;
    setConnecting(true);
    try {
      const r = await api<{ url: string }>("/api/ebay/oauth/authorize", {
        body: { name: connectName.trim() },
      });
      window.location.href = r.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start eBay OAuth");
      setConnecting(false);
    }
  };

  const remove = async () => {
    if (deleteId == null) return;
    try {
      await api(`/api/ebay/accounts/${deleteId}`, { method: "DELETE" });
      toast.success("eBay account removed");
      setDeleteId(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <img src={ebayLogo} alt="eBay" className="h-8 w-8" />
            <div>
              <CardTitle className="text-base">eBay</CardTitle>
              <CardDescription>
                Connect your eBay seller account to import orders alongside WooCommerce.
              </CardDescription>
            </div>
          </div>
          <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
            <DialogTrigger asChild>
              <Button
                size="sm"
                disabled={configured === false}
                title={configured === false
                  ? "eBay isn't configured on the server yet."
                  : "Connect a new eBay seller account"}
              >
                <Link2 className="h-4 w-4" /> Connect eBay
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Connect an eBay account</DialogTitle>
                <DialogDescription>
                  Give this connection a name, then sign in to eBay.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={startConnect} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="ebay_name">Display name</Label>
                  <Input id="ebay_name" autoFocus required maxLength={100}
                    value={connectName}
                    onChange={(e) => setConnectName(e.target.value)}
                    placeholder="Ultraskins eBay UK" />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setConnectOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={connecting || !connectName.trim()}>
                    {connecting && <Loader2 className="h-4 w-4 animate-spin" />}
                    Continue to eBay
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {configured === false && (
          <div className="text-sm text-muted-foreground border border-dashed rounded-md p-3 mb-3">
            eBay OAuth isn't configured on the server yet.
          </div>
        )}
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : accounts.length === 0 ? (
          <div className="text-sm text-muted-foreground">No eBay accounts connected yet.</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {accounts.map((a) => (
              <Card key={a.id}>
                <CardContent className="p-4 flex items-start justify-between gap-3">
                  <img src={ebayLogo} alt="eBay" className="h-8 w-8 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold truncate">{a.name}</div>
                    <div className="text-sm text-muted-foreground truncate">
                      {a.ebay_user_id ? `@${a.ebay_user_id}` : "eBay seller"}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Connected {new Date(a.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => setDeleteId(a.id)} title="Disconnect">
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </CardContent>

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this eBay account?</AlertDialogTitle>
            <AlertDialogDescription>
              Ultrax will stop fetching orders from this account. You can reconnect any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
