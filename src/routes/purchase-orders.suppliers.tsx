import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { poApi, type Supplier } from "@/lib/purchase-orders-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/purchase-orders/suppliers")({
  head: () => ({ meta: [{ title: "Suppliers — HeyShop" }] }),
  component: SuppliersPage,
});

const EMPTY: Omit<Supplier, "id" | "created_at" | "updated_at"> = {
  name: "", contact_name: "", email: "", phone: "",
  address_line1: "", address_line2: "", city: "", postcode: "", country: "", notes: "",
};

function SuppliersPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["po-suppliers"], queryFn: () => poApi.suppliers.list() });
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [draft, setDraft] = useState(EMPTY);
  const [open, setOpen] = useState(false);

  const openNew = () => { setEditing(null); setDraft(EMPTY); setOpen(true); };
  const openEdit = (s: Supplier) => {
    setEditing(s);
    setDraft({
      name: s.name, contact_name: s.contact_name ?? "", email: s.email ?? "",
      phone: s.phone ?? "", address_line1: s.address_line1 ?? "",
      address_line2: s.address_line2 ?? "", city: s.city ?? "",
      postcode: s.postcode ?? "", country: s.country ?? "", notes: s.notes ?? "",
    });
    setOpen(true);
  };

  const save = async () => {
    try {
      const body = {
        ...draft,
        contact_name: draft.contact_name || null,
        email: draft.email || null,
        phone: draft.phone || null,
        address_line1: draft.address_line1 || null,
        address_line2: draft.address_line2 || null,
        city: draft.city || null,
        postcode: draft.postcode || null,
        country: draft.country || null,
        notes: draft.notes || null,
      };
      if (editing) {
        await poApi.suppliers.update(editing.id, body);
        toast.success("Supplier updated");
      } else {
        await poApi.suppliers.create(body);
        toast.success("Supplier created");
      }
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["po-suppliers"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async (s: Supplier) => {
    try {
      await poApi.suppliers.remove(s.id);
      toast.success("Supplier deleted");
      qc.invalidateQueries({ queryKey: ["po-suppliers"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const rows = list.data ?? [];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">Suppliers</h1>
          <p className="text-xs text-muted-foreground">Reusable supplier directory for purchase orders.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" onClick={openNew}><Plus className="mr-1.5 h-3.5 w-3.5" /> New supplier</Button>
          </DialogTrigger>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>{editing ? "Edit supplier" : "New supplier"}</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name *" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
              <Field label="Contact" value={draft.contact_name ?? ""} onChange={(v) => setDraft({ ...draft, contact_name: v })} />
              <Field label="Email" value={draft.email ?? ""} onChange={(v) => setDraft({ ...draft, email: v })} />
              <Field label="Phone" value={draft.phone ?? ""} onChange={(v) => setDraft({ ...draft, phone: v })} />
              <Field label="Address line 1" className="col-span-2" value={draft.address_line1 ?? ""} onChange={(v) => setDraft({ ...draft, address_line1: v })} />
              <Field label="Address line 2" className="col-span-2" value={draft.address_line2 ?? ""} onChange={(v) => setDraft({ ...draft, address_line2: v })} />
              <Field label="City" value={draft.city ?? ""} onChange={(v) => setDraft({ ...draft, city: v })} />
              <Field label="Postcode" value={draft.postcode ?? ""} onChange={(v) => setDraft({ ...draft, postcode: v })} />
              <Field label="Country" value={draft.country ?? ""} onChange={(v) => setDraft({ ...draft, country: v })} />
              <div className="col-span-2">
                <Label className="text-xs">Notes</Label>
                <Textarea
                  rows={3}
                  value={draft.notes ?? ""}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={save} disabled={!draft.name.trim()}>
                {editing ? "Save changes" : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/60 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Contact</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Location</th>
              <th className="px-3 py-2 w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {list.isLoading && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!list.isLoading && rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-12 text-center text-muted-foreground">No suppliers yet.</td></tr>
            )}
            {rows.map((s) => (
              <tr key={s.id} className="hover:bg-accent/30">
                <td className="px-3 py-2 font-medium">{s.name}</td>
                <td className="px-3 py-2 text-muted-foreground">{s.contact_name ?? "—"}</td>
                <td className="px-3 py-2 text-muted-foreground">{s.email ?? "—"}</td>
                <td className="px-3 py-2 text-muted-foreground">{s.phone ?? "—"}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {[s.city, s.country].filter(Boolean).join(", ") || "—"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(s)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="ghost">
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete supplier?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This removes <strong>{s.name}</strong>. Suppliers in use by purchase orders cannot be deleted.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => remove(s)}>Delete</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, className = "",
}: { label: string; value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <div className={className}>
      <Label className="text-xs">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
