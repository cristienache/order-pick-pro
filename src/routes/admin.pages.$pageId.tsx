import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { PageRenderer } from "@/components/page-renderer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft, ArrowDown, ArrowUp, ExternalLink, Eye, FileText,
  Loader2, Plus, Save, Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  BLOCK_CATALOGUE, makeBlock, slugify, type Block, type BlockType, type Page,
} from "@/lib/pages";

export const Route = createFileRoute("/admin/pages/$pageId")({
  component: () => (
    <RequireAuth adminOnly>
      <AppShell>
        <PageEditor />
      </AppShell>
    </RequireAuth>
  ),
});

type Draft = {
  slug: string;
  title: string;
  description: string;
  blocks: Block[];
  published: boolean;
  show_in_nav: boolean;
};

const EMPTY_DRAFT: Draft = {
  slug: "",
  title: "",
  description: "",
  blocks: [],
  published: false,
  show_in_nav: false,
};

function PageEditor() {
  const { pageId } = Route.useParams();
  const navigate = useNavigate();
  const isNew = pageId === "new";
  const numericId = isNew ? null : Number(pageId);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [original, setOriginal] = useState<Draft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [slugTouched, setSlugTouched] = useState(!isNew);

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    setLoading(true);
    api<{ page: Page }>(`/api/pages/${numericId}`)
      .then((r) => {
        if (cancelled) return;
        const d: Draft = {
          slug: r.page.slug,
          title: r.page.title,
          description: r.page.description || "",
          blocks: r.page.blocks,
          published: r.page.published,
          show_in_nav: r.page.show_in_nav,
        };
        setDraft(d);
        setOriginal(d);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load page"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [isNew, numericId]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(original),
    [draft, original],
  );

  const setTitle = (text: string) => {
    setDraft((d) => ({
      ...d,
      title: text,
      slug: slugTouched ? d.slug : slugify(text),
    }));
  };

  const setSlug = (text: string) => {
    setSlugTouched(true);
    setDraft((d) => ({ ...d, slug: text }));
  };

  const addBlock = (type: BlockType) => {
    setDraft((d) => ({ ...d, blocks: [...d.blocks, makeBlock(type)] }));
  };

  const updateBlock = (id: string, props: Record<string, unknown>) => {
    setDraft((d) => ({
      ...d,
      blocks: d.blocks.map((b) => (b.id === id ? { ...b, props } : b)),
    }));
  };

  const removeBlock = (id: string) => {
    setDraft((d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== id) }));
  };

  const moveBlock = (id: string, dir: -1 | 1) => {
    setDraft((d) => {
      const idx = d.blocks.findIndex((b) => b.id === id);
      if (idx === -1) return d;
      const target = idx + dir;
      if (target < 0 || target >= d.blocks.length) return d;
      const next = d.blocks.slice();
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return { ...d, blocks: next };
    });
  };

  const save = async () => {
    if (!draft.title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(draft.slug)) {
      toast.error("Slug must be lowercase letters, digits or hyphens");
      return;
    }
    setSaving(true);
    try {
      const body = {
        slug: draft.slug,
        title: draft.title,
        description: draft.description,
        blocks: draft.blocks,
        published: draft.published,
        show_in_nav: draft.show_in_nav,
      };
      const res = isNew
        ? await api<{ page: Page }>("/api/pages", { method: "POST", body })
        : await api<{ page: Page }>(`/api/pages/${numericId}`, { method: "PUT", body });
      toast.success(isNew ? "Page created" : "Page saved");
      if (isNew) {
        navigate({ to: "/admin/pages/$pageId", params: { pageId: String(res.page.id) } });
      } else {
        setOriginal(draft);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FileText}
        accent="sky"
        eyebrow={isNew ? "New page" : "Edit page"}
        title={isNew ? "Create a page" : draft.title || "Untitled page"}
        description="Compose a page from blocks. Publish to make it visible at /p/<slug>."
        actions={
          <>
            <Button asChild variant="ghost" className="gap-1.5">
              <Link to="/admin/pages">
                <ArrowLeft className="h-4 w-4" /> Back
              </Link>
            </Button>
            {!isNew && (
              <Button asChild variant="outline" className="gap-1.5">
                <Link to="/p/$slug" params={{ slug: draft.slug }} target="_blank">
                  <ExternalLink className="h-4 w-4" /> View
                </Link>
              </Button>
            )}
            <Button onClick={save} disabled={saving || (!isNew && !dirty)} className="gap-1.5">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {isNew ? "Create" : "Save"}
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6 min-w-0">
          <Card>
            <CardHeader>
              <CardTitle>Page details</CardTitle>
              <CardDescription>Title, URL slug and short description for SEO and previews.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={draft.title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="About us"
                  maxLength={120}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="slug">URL slug</Label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground font-mono">/p/</span>
                  <Input
                    id="slug"
                    value={draft.slug}
                    onChange={(e) => setSlug(e.target.value.toLowerCase())}
                    placeholder="about-us"
                    maxLength={60}
                    className="font-mono"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Lowercase letters, digits and hyphens only.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="A short summary shown under the title and in social previews."
                  maxLength={300}
                  rows={2}
                />
              </div>
            </CardContent>
          </Card>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Content blocks</h2>
              <AddBlockMenu onAdd={addBlock} />
            </div>

            {draft.blocks.length === 0 ? (
              <Card className="p-10 border-dashed text-center space-y-3">
                <p className="text-sm text-muted-foreground">
                  This page is empty. Add your first block to get started.
                </p>
                <AddBlockMenu onAdd={addBlock} />
              </Card>
            ) : (
              <div className="space-y-3">
                {draft.blocks.map((b, i) => (
                  <BlockEditor
                    key={b.id}
                    block={b}
                    index={i}
                    total={draft.blocks.length}
                    onChange={(props) => updateBlock(b.id, props)}
                    onMoveUp={() => moveBlock(b.id, -1)}
                    onMoveDown={() => moveBlock(b.id, 1)}
                    onRemove={() => removeBlock(b.id)}
                  />
                ))}
                <div className="pt-2">
                  <AddBlockMenu onAdd={addBlock} />
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Visibility</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Label htmlFor="published" className="text-sm font-medium">Published</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Draft pages are visible only to admins.
                  </p>
                </div>
                <Switch
                  id="published"
                  checked={draft.published}
                  onCheckedChange={(v) => setDraft({ ...draft, published: v })}
                />
              </div>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Label htmlFor="show_in_nav" className="text-sm font-medium">Show in top nav</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Adds a link in the header for signed-in users.
                  </p>
                </div>
                <Switch
                  id="show_in_nav"
                  checked={draft.show_in_nav}
                  onCheckedChange={(v) => setDraft({ ...draft, show_in_nav: v })}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base flex items-center gap-2">
                <Eye className="h-4 w-4" /> Live preview
              </CardTitle>
            </CardHeader>
            <CardContent>
              {draft.blocks.length === 0 ? (
                <p className="text-xs text-muted-foreground">Add blocks to see the preview.</p>
              ) : (
                <div className="rounded-lg border border-border/60 bg-background p-4 max-h-[600px] overflow-auto">
                  <PageRenderer blocks={draft.blocks} />
                </div>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function AddBlockMenu({ onAdd }: { onAdd: (type: BlockType) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Plus className="h-4 w-4" /> Add block
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {BLOCK_CATALOGUE.map((b) => (
          <DropdownMenuItem
            key={b.type}
            onClick={() => onAdd(b.type)}
            className="flex flex-col items-start gap-0.5 py-2"
          >
            <span className="font-medium">{b.label}</span>
            <span className="text-xs text-muted-foreground">{b.description}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BlockEditor({
  block, index, total, onChange, onMoveUp, onMoveDown, onRemove,
}: {
  block: Block;
  index: number;
  total: number;
  onChange: (props: Record<string, unknown>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const meta = BLOCK_CATALOGUE.find((b) => b.type === block.type);
  const setProp = (key: string, value: unknown) => onChange({ ...block.props, [key]: value });

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
            {meta?.label || block.type}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" onClick={onMoveUp} disabled={index === 0} title="Move up">
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={onMoveDown} disabled={index === total - 1} title="Move down">
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={onRemove} title="Remove" className="text-destructive hover:text-destructive">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <BlockPropsForm block={block} setProp={setProp} />
    </Card>
  );
}

function asString(v: unknown, fb = ""): string { return typeof v === "string" ? v : fb; }
function asBool(v: unknown, fb = false): boolean { return typeof v === "boolean" ? v : fb; }
function asNumber(v: unknown, fb = 0): number { return typeof v === "number" ? v : fb; }

function BlockPropsForm({
  block, setProp,
}: { block: Block; setProp: (key: string, value: unknown) => void }) {
  const p = block.props || {};
  switch (block.type) {
    case "heading":
      return (
        <div className="grid gap-3 sm:grid-cols-[1fr_120px_120px]">
          <Input
            value={asString(p.text)}
            onChange={(e) => setProp("text", e.target.value)}
            placeholder="Heading text"
          />
          <Select value={String(asNumber(p.level, 2))} onValueChange={(v) => setProp("level", Number(v))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">H1</SelectItem>
              <SelectItem value="2">H2</SelectItem>
              <SelectItem value="3">H3</SelectItem>
            </SelectContent>
          </Select>
          <Select value={asString(p.align, "left")} onValueChange={(v) => setProp("align", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="left">Left</SelectItem>
              <SelectItem value="center">Center</SelectItem>
              <SelectItem value="right">Right</SelectItem>
            </SelectContent>
          </Select>
        </div>
      );
    case "paragraph":
      return (
        <div className="space-y-3">
          <Textarea
            value={asString(p.text)}
            onChange={(e) => setProp("text", e.target.value)}
            rows={4}
            placeholder="Paragraph text"
          />
          <Select value={asString(p.align, "left")} onValueChange={(v) => setProp("align", v)}>
            <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="left">Align left</SelectItem>
              <SelectItem value="center">Align center</SelectItem>
              <SelectItem value="right">Align right</SelectItem>
            </SelectContent>
          </Select>
        </div>
      );
    case "image":
      return (
        <div className="grid gap-3">
          <Input
            value={asString(p.src)}
            onChange={(e) => setProp("src", e.target.value)}
            placeholder="https://example.com/image.jpg"
          />
          <Input
            value={asString(p.alt)}
            onChange={(e) => setProp("alt", e.target.value)}
            placeholder="Alt text (for screen readers)"
          />
          <Input
            value={asString(p.caption)}
            onChange={(e) => setProp("caption", e.target.value)}
            placeholder="Optional caption"
          />
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={asBool(p.rounded, true)} onCheckedChange={(v) => setProp("rounded", v)} />
            Rounded corners
          </label>
        </div>
      );
    case "button":
      return (
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_140px]">
          <Input
            value={asString(p.label)}
            onChange={(e) => setProp("label", e.target.value)}
            placeholder="Button label"
          />
          <Input
            value={asString(p.href)}
            onChange={(e) => setProp("href", e.target.value)}
            placeholder="https://… or /path"
          />
          <Select value={asString(p.variant, "default")} onValueChange={(v) => setProp("variant", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Solid</SelectItem>
              <SelectItem value="outline">Outline</SelectItem>
              <SelectItem value="secondary">Secondary</SelectItem>
              <SelectItem value="ghost">Ghost</SelectItem>
            </SelectContent>
          </Select>
        </div>
      );
    case "card":
      return (
        <div className="grid gap-3">
          <Input
            value={asString(p.title)}
            onChange={(e) => setProp("title", e.target.value)}
            placeholder="Card title"
          />
          <Textarea
            value={asString(p.body)}
            onChange={(e) => setProp("body", e.target.value)}
            rows={3}
            placeholder="Card body"
          />
        </div>
      );
    case "spacer":
      return (
        <Select value={asString(p.size, "md")} onValueChange={(v) => setProp("size", v)}>
          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="sm">Small (16px)</SelectItem>
            <SelectItem value="md">Medium (32px)</SelectItem>
            <SelectItem value="lg">Large (64px)</SelectItem>
            <SelectItem value="xl">Extra large (96px)</SelectItem>
          </SelectContent>
        </Select>
      );
    case "divider":
      return <p className="text-xs text-muted-foreground">A horizontal divider line. No options.</p>;
    case "html":
      return (
        <div className="space-y-2">
          <Textarea
            value={asString(p.html)}
            onChange={(e) => setProp("html", e.target.value)}
            rows={6}
            className="font-mono text-xs"
            placeholder="<p>Hello</p>"
          />
          <p className="text-xs text-muted-foreground">
            Scripts, event-handler attributes and <code>javascript:</code> URLs are stripped on render.
          </p>
        </div>
      );
    default:
      return <p className="text-xs text-muted-foreground">Unknown block type.</p>;
  }
}
