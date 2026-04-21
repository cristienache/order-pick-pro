import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, type Site } from "@/lib/api";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, Loader2, Store } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/sites")({
  component: () => <RequireAuth><AppShell><SitesPage /></AppShell></RequireAuth>,
});

type FormState = {
  name: string;
  store_url: string;
  consumer_key: string;
  consumer_secret: string;
  return_name: string;
  return_company: string;
  return_line1: string;
  return_line2: string;
  return_city: string;
  return_postcode: string;
  return_country: string;
};
const empty: FormState = {
  name: "", store_url: "", consumer_key: "", consumer_secret: "",
  return_name: "", return_company: "", return_line1: "", return_line2: "",
  return_city: "", return_postcode: "", return_country: "",
};

function SitesPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Site | null>(null);
  const [form, setForm] = useState<FormState>(empty);
  const [saving, setSaving] = useState(false);
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

  const openCreate = () => { setEditing(null); setForm(empty); setOpen(true); };
  const openEdit = (s: Site) => {
    setEditing(s);
    // Consumer key/secret are write-only (encrypted at rest, never returned).
    // The user must re-enter them every time they edit a site.
    setForm({
      name: s.name,
      store_url: s.store_url,
      consumer_key: "",
      consumer_secret: "",
      return_name: s.return_name ?? "",
      return_company: s.return_company ?? "",
      return_line1: s.return_line1 ?? "",
      return_line2: s.return_line2 ?? "",
      return_city: s.return_city ?? "",
      return_postcode: s.return_postcode ?? "",
      return_country: s.return_country ?? "",
    });
    setOpen(true);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        await api(`/api/sites/${editing.id}`, { method: "PUT", body: form });
        toast.success("Site updated");
      } else {
        await api("/api/sites", { body: form });
        toast.success("Site added");
      }
      setOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally { setSaving(false); }
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
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">My WooCommerce Sites</h1>
          <p className="text-muted-foreground text-sm">
            Add stores and their REST API keys. Keys are encrypted at rest and never shown after saving.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreate}><Plus className="h-4 w-4" /> Add site</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? "Edit site" : "Add WooCommerce site"}</DialogTitle>
              <DialogDescription>
                Generate REST API keys in WooCommerce → Settings → Advanced → REST API. Permissions: Read.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={save} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Display name</Label>
                <Input id="name" value={form.name} required maxLength={100}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ultraskins UK" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="store_url">Store URL</Label>
                <Input id="store_url" type="url" value={form.store_url} required
                  onChange={(e) => setForm({ ...form, store_url: e.target.value })}
                  placeholder="https://www.example.com" />
                <p className="text-xs text-muted-foreground">Include https:// and www if applicable.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ck">Consumer key</Label>
                <Input id="ck" value={form.consumer_key} required
                  onChange={(e) => setForm({ ...form, consumer_key: e.target.value })}
                  placeholder="ck_..." />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cs">Consumer secret</Label>
                <Input id="cs" type="password" value={form.consumer_secret} required
                  onChange={(e) => setForm({ ...form, consumer_secret: e.target.value })}
                  placeholder="cs_..." />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {editing ? "Save changes" : "Add site"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : sites.length === 0 ? (
        <Card>
          <CardHeader className="text-center py-12">
            <Store className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
            <CardTitle>No sites yet</CardTitle>
            <CardDescription>Add your first WooCommerce store to start generating picklists.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {sites.map((s) => (
            <Card key={s.id}>
              <CardContent className="p-4 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate">{s.name}</div>
                  <div className="text-sm text-muted-foreground truncate">{s.store_url}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Added {new Date(s.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" onClick={() => openEdit(s)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => setDeleteId(s.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

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
