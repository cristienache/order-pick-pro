import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, type Invite } from "@/lib/api";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Trash2, Copy, Check, Mail } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/invites")({
  component: () => <RequireAuth adminOnly><AppShell><InvitesPage /></AppShell></RequireAuth>,
  head: () => ({
    meta: [
      { title: "Invitations | Ultrax" },
      { name: "description", content: "Invite teammates to Ultrax." },
    ],
  }),
});

function InvitesPage() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [submitting, setSubmitting] = useState(false);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { invites } = await api<{ invites: Invite[] }>("/api/invites");
      setInvites(invites);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const { token } = await api<{ token: string }>("/api/invites", { body: { email, role } });
      const link = `${window.location.origin}/accept-invite?token=${token}`;
      setCreatedLink(link);
      setEmail("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create invite");
    } finally { setSubmitting(false); }
  };

  const remove = async (id: number) => {
    try {
      await api(`/api/invites/${id}`, { method: "DELETE" });
      load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  };

  const copy = async () => {
    if (!createdLink) return;
    await navigator.clipboard.writeText(createdLink);
    setCopied(true);
    toast.success("Link copied");
    setTimeout(() => setCopied(false), 2000);
  };

  const inviteLink = (token: string) => `${typeof window !== "undefined" ? window.location.origin : ""}/accept-invite?token=${token}`;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Mail}
        accent="rose"
        eyebrow="Onboarding"
        title="Invitations"
        description="Invite users by generating a link they can use to set their password."
        actions={
          <Button onClick={() => { setOpen(true); setCreatedLink(null); }}>
            <Plus className="h-4 w-4" /> New invite
          </Button>
        }
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{createdLink ? "Invite created" : "Invite a user"}</DialogTitle>
            <DialogDescription>
              {createdLink
                ? "Send this link to the user. It expires in 7 days."
                : "An invite link will be generated for you to share with the user."}
            </DialogDescription>
          </DialogHeader>
          {createdLink ? (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input readOnly value={createdLink} onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" onClick={copy}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <DialogFooter>
                <Button onClick={() => setOpen(false)}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={create} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email} required
                  onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={role} onValueChange={(v) => setRole(v as "user" | "admin")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">User</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={submitting}>
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  Generate link
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : invites.length === 0 ? (
        <Card><CardHeader className="text-center py-12">
          <CardTitle>No invitations yet</CardTitle>
          <CardDescription>Click "New invite" to get started.</CardDescription>
        </CardHeader></Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {invites.map((inv) => {
              const expired = new Date(inv.expires_at) < new Date();
              const status = inv.used_at ? "used" : expired ? "expired" : "pending";
              return (
                <div key={inv.id} className="flex items-center gap-3 p-4 border-b last:border-b-0">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{inv.email}</div>
                    <div className="text-xs text-muted-foreground">
                      Role: {inv.role} · Created {new Date(inv.created_at).toLocaleDateString()}
                      {inv.used_at && ` · Accepted ${new Date(inv.used_at).toLocaleDateString()}`}
                    </div>
                  </div>
                  <Badge variant={status === "pending" ? "default" : status === "used" ? "secondary" : "destructive"}>
                    {status}
                  </Badge>
                  {status === "pending" && (
                    <Button size="sm" variant="ghost" onClick={() => {
                      navigator.clipboard.writeText(inviteLink(inv.token));
                      toast.success("Link copied");
                    }}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  )}
                  <Button size="icon" variant="ghost" onClick={() => remove(inv.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
