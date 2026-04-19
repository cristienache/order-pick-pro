import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, type User } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

type UserRow = User & { created_at: string };

export const Route = createFileRoute("/admin/users")({
  component: () => <RequireAuth adminOnly><AppShell><UsersPage /></AppShell></RequireAuth>,
});

function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { users } = await api<{ users: UserRow[] }>("/api/users");
      setUsers(users);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const remove = async () => {
    if (deleteId == null) return;
    try {
      await api(`/api/users/${deleteId}`, { method: "DELETE" });
      toast.success("User deleted");
      setDeleteId(null);
      load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Users</h1>
        <p className="text-muted-foreground text-sm">All registered users. Deleting a user removes their sites permanently.</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <Card>
          <CardContent className="p-0">
            {users.map((u) => (
              <div key={u.id} className="flex items-center gap-3 p-4 border-b last:border-b-0">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{u.email}</div>
                  <div className="text-xs text-muted-foreground">
                    Joined {new Date(u.created_at).toLocaleDateString()}
                  </div>
                </div>
                <Badge variant={u.role === "admin" ? "default" : "secondary"}>{u.role}</Badge>
                <Button size="icon" variant="ghost" disabled={u.id === me?.id}
                  onClick={() => setDeleteId(u.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this user?</AlertDialogTitle>
            <AlertDialogDescription>The user and all of their saved sites/keys will be permanently removed.</AlertDialogDescription>
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
