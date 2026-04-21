import { useEffect, useState } from "react";
import { api, type FilterPreset } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Bookmark, Check, Loader2, Plus, Trash2, ChevronDown } from "lucide-react";
import { toast } from "sonner";

export type PresetPayload = {
  statuses: string[];
  datePreset: string;
  customFrom: string;
  customTo: string;
  search: string;
  sortOrder: string;
  highValueThreshold: number;
  computeRepeat: boolean;
};

type Props = {
  // The single site this preset list is scoped to. When activeSites > 1, the
  // component still saves against this id (the "primary" one). Disabled when null.
  siteId: number | null;
  // Snapshot of current filter state (used when saving a new preset).
  currentPayload: PresetPayload;
  // Called when the user picks a saved preset; should restore the values.
  onApply: (payload: PresetPayload) => void;
};

export function FilterPresets({ siteId, currentPayload, onApply }: Props) {
  const [presets, setPresets] = useState<FilterPreset[]>([]);
  const [loading, setLoading] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = async (sid: number) => {
    setLoading(true);
    try {
      const r = await api<{ presets: FilterPreset[] }>(`/api/sites/${sid}/presets`);
      setPresets(r.presets);
    } catch (e) {
      // Silent — feature is optional
      console.warn("Failed to load presets", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (siteId == null) { setPresets([]); return; }
    reload(siteId);
  }, [siteId]);

  const save = async () => {
    if (!siteId) return;
    const trimmed = name.trim();
    if (!trimmed) { toast.error("Name required"); return; }
    setSaving(true);
    try {
      await api("/api/presets", {
        body: { site_id: siteId, name: trimmed, payload: currentPayload },
      });
      toast.success(`Preset "${trimmed}" saved`);
      setSaveOpen(false);
      setName("");
      await reload(siteId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save preset");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number, label: string) => {
    if (!confirm(`Delete preset "${label}"?`)) return;
    try {
      await api(`/api/presets/${id}`, { method: "DELETE" });
      toast.success("Preset deleted");
      if (siteId) await reload(siteId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  const apply = (preset: FilterPreset) => {
    const p = preset.payload as Partial<PresetPayload>;
    onApply({
      statuses: Array.isArray(p.statuses) ? p.statuses : ["processing"],
      datePreset: typeof p.datePreset === "string" ? p.datePreset : "all",
      customFrom: typeof p.customFrom === "string" ? p.customFrom : "",
      customTo: typeof p.customTo === "string" ? p.customTo : "",
      search: typeof p.search === "string" ? p.search : "",
      sortOrder: typeof p.sortOrder === "string" ? p.sortOrder : "recent",
      highValueThreshold: typeof p.highValueThreshold === "number" ? p.highValueThreshold : 100,
      computeRepeat: Boolean(p.computeRepeat),
    });
    toast.success(`Applied "${preset.name}"`);
  };

  const disabled = siteId == null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={disabled}
            title={disabled ? "Select a single site to use presets" : "Saved filter presets"}>
            <Bookmark className="h-3.5 w-3.5" />
            Presets
            {presets.length > 0 && <span className="text-muted-foreground">({presets.length})</span>}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Saved filter presets</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {loading && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading...
            </div>
          )}
          {!loading && presets.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No presets yet. Save your current filters below.
            </div>
          )}
          {presets.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={(e) => { e.preventDefault(); apply(p); }}
              className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 truncate">
                <Check className="h-3 w-3 opacity-50" />
                {p.name}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); remove(p.id, p.name); }}
                className="text-muted-foreground hover:text-destructive p-0.5 rounded"
                aria-label={`Delete ${p.name}`}>
                <Trash2 className="h-3 w-3" />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setSaveOpen(true); }}>
            <Plus className="h-3.5 w-3.5" /> Save current filters...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save filter preset</DialogTitle>
            <DialogDescription>
              Saves the current filters (statuses, date range, search, sort, priority settings)
              as a named preset for this site.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="preset-name">Preset name</Label>
            <Input id="preset-name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Express only, On hold + aging"
              maxLength={60} autoFocus
              onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) save(); }} />
            <p className="text-xs text-muted-foreground">
              If a preset with the same name exists, it will be overwritten.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving || !name.trim()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save preset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
