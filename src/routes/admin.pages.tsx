import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ExternalLink, FileText, Loader2, Pencil, Plus, Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { Page } from "@/lib/pages";

export const Route = createFileRoute("/admin/pages")({
  component: () => (
    <RequireAuth adminOnly>
      <AppShell>
        <AdminPagesList />
      </AppShell>
    </RequireAuth>
  ),
  head: () => ({
    meta: [
      { title: "Pages | Ultrax" },
      { name: "description", content: "Create and manage custom content pages." },
    ],
  }),
});

function AdminPagesList() {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api<{ pages: Page[] }>("/api/pages");
      setPages(r.pages);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load pages");
      setPages([]);
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await api(`/api/pages/${confirmDelete.id}`, { method: "DELETE" });
      toast.success("Page deleted");
      setConfirmDelete(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FileText}
        accent="sky"
        eyebrow="Page builder"
        title="Pages"
        description="Build custom content pages with reusable blocks. Published pages live at /p/<slug> and can be linked from the top nav."
        actions={
          <Button asChild className="gap-1.5">
            <Link to="/admin/pages/$pageId" params={{ pageId: "new" }}>
              <Plus className="h-4 w-4" /> New page
            </Link>
          </Button>
        }
      />

      {pages === null ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : pages.length === 0 ? (
        <Card className="p-12 text-center space-y-3 border-dashed">
          <FileText className="h-10 w-10 mx-auto text-muted-foreground" />
          <h3 className="text-lg font-semibold">No pages yet</h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            Build a landing page, an About page, a help article — anything composed of headings, paragraphs, images and buttons.
          </p>
          <Button asChild className="gap-1.5 mt-2">
            <Link to="/admin/pages/$pageId" params={{ pageId: "new" }}>
              <Plus className="h-4 w-4" /> Create your first page
            </Link>
          </Button>
        </Card>
      ) : (
        <div className="grid gap-3">
          {pages.map((p) => (
            <Card key={p.id} className="p-4 flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold truncate">{p.title}</span>
                  {p.published ? (
                    <Badge variant="secondary" className="bg-brand-emerald/15 text-brand-emerald border-0">
                      Published
                    </Badge>
                  ) : (
                    <Badge variant="outline">Draft</Badge>
                  )}
                  {p.show_in_nav && (
                    <Badge variant="outline" className="text-xs">In nav</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1 font-mono">
                  /p/{p.slug}
                </div>
                {p.description && (
                  <div className="text-xs text-muted-foreground mt-1 line-clamp-1">
                    {p.description}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button asChild variant="ghost" size="sm" className="gap-1.5">
                  <Link to="/p/$slug" params={{ slug: p.slug }} target="_blank">
                    <ExternalLink className="h-4 w-4" /> View
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm" className="gap-1.5">
                  <Link to="/admin/pages/$pageId" params={{ pageId: String(p.id) }}>
                    <Pencil className="h-4 w-4" /> Edit
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-destructive hover:text-destructive"
                  onClick={() => setConfirmDelete(p)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this page?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{confirmDelete?.title}</strong> will be permanently removed.
              The URL <code className="text-xs">/p/{confirmDelete?.slug}</code> will return 404.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); remove(); }}
              disabled={busy}
              className="bg-destructive hover:bg-destructive/90"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
