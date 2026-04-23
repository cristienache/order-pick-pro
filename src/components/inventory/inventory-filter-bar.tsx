// Comprehensive filter & sort bar shared by the inventory grids.
//
// Renders three pieces:
//   1. A compact toolbar slot with: search, sort key+direction, "More filters"
//      popover, and a reset button.
//   2. A row of "active filter" chips (only when something non-default is set).
//   3. A presets dropdown (saved per `presetKey` in localStorage) so users can
//      snapshot and restore complex filter combinations.
//
// Parents own the state — this component is fully controlled. It intentionally
// renders only the controls relevant to the configured `availableFields` so it
// works for both the Global inventory grid (warehouse, source, low-stock) and
// the WooCommerce grid (type, edited, sale_price, weight, manage_stock).

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Search, SlidersHorizontal, X, ArrowUp, ArrowDown, RotateCcw, Bookmark,
  Plus, Trash2, Check,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/** Field families this component knows how to render. The host page passes a
 *  whitelist via `availableFields` so unrelated controls stay hidden. */
export type FilterField =
  | "search"
  | "source"      // oms / woo
  | "warehouse"   // multi-warehouse selector (host supplies options)
  | "stockState"  // any | inStock | low | out | over
  | "priceRange"
  | "salePriceRange"
  | "weightRange"
  | "wcType"      // simple / variable / variation
  | "stockStatus" // instock / outofstock / onbackorder (WC field)
  | "manageStock" // tri-state: any / managed / unmanaged
  | "edited"      // only rows with unsaved local edits
  | "hasImage"
  | "hasSale";

export type SortKey =
  | "name" | "sku" | "regular_price" | "sale_price"
  | "stock_quantity" | "weight" | "last_synced_at" | "dirty";
export type SortDir = "asc" | "desc";

export type SortOption = { value: SortKey; label: string };

export type InventoryFilters = {
  search: string;
  source: "all" | "oms" | "woo";
  warehouseIds: string[];        // [] = all
  stockState: "any" | "inStock" | "low" | "out" | "over";
  priceMin: string; priceMax: string;
  salePriceMin: string; salePriceMax: string;
  weightMin: string; weightMax: string;
  wcType: "all" | "simple" | "variable" | "variation";
  stockStatus: "any" | "instock" | "outofstock" | "onbackorder";
  manageStock: "any" | "yes" | "no";
  editedOnly: boolean;
  hasImage: "any" | "yes" | "no";
  hasSale: "any" | "yes" | "no";
  sortKey: SortKey;
  sortDir: SortDir;
};

export const DEFAULT_FILTERS: InventoryFilters = {
  search: "",
  source: "all",
  warehouseIds: [],
  stockState: "any",
  priceMin: "", priceMax: "",
  salePriceMin: "", salePriceMax: "",
  weightMin: "", weightMax: "",
  wcType: "all",
  stockStatus: "any",
  manageStock: "any",
  editedOnly: false,
  hasImage: "any",
  hasSale: "any",
  sortKey: "name",
  sortDir: "asc",
};

/** Count how many filters differ from defaults — used for the badge on the
 *  "More filters" button. Search and sort are NOT counted (they have their
 *  own visible UI). */
export function activeFilterCount(f: InventoryFilters): number {
  let n = 0;
  if (f.source !== "all") n++;
  if (f.warehouseIds.length > 0) n++;
  if (f.stockState !== "any") n++;
  if (f.priceMin || f.priceMax) n++;
  if (f.salePriceMin || f.salePriceMax) n++;
  if (f.weightMin || f.weightMax) n++;
  if (f.wcType !== "all") n++;
  if (f.stockStatus !== "any") n++;
  if (f.manageStock !== "any") n++;
  if (f.editedOnly) n++;
  if (f.hasImage !== "any") n++;
  if (f.hasSale !== "any") n++;
  return n;
}

type SavedPreset = { name: string; filters: InventoryFilters };

function loadPresets(key: string): SavedPreset[] {
  try {
    const raw = localStorage.getItem(`inv-presets:${key}`);
    return raw ? JSON.parse(raw) as SavedPreset[] : [];
  } catch { return []; }
}
function savePresets(key: string, list: SavedPreset[]) {
  try { localStorage.setItem(`inv-presets:${key}`, JSON.stringify(list)); } catch { /* quota */ }
}

type Props = {
  /** localStorage namespace for saved presets. Use a unique value per page. */
  presetKey: string;
  value: InventoryFilters;
  onChange: (next: InventoryFilters) => void;
  availableFields: FilterField[];
  sortOptions: SortOption[];
  /** Required only when `availableFields` includes "warehouse". */
  warehouseOptions?: Array<{ id: string; label: string }>;
  /** Counts shown next to filters (e.g. "Edited (3)") — all optional. */
  counts?: { total?: number; visible?: number; edited?: number };
};

export function InventoryFilterBar({
  presetKey, value, onChange, availableFields, sortOptions,
  warehouseOptions = [], counts,
}: Props) {
  const has = (f: FilterField) => availableFields.includes(f);
  const set = <K extends keyof InventoryFilters>(k: K, v: InventoryFilters[K]) =>
    onChange({ ...value, [k]: v });

  const [presets, setPresets] = useState<SavedPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);

  useEffect(() => { setPresets(loadPresets(presetKey)); }, [presetKey]);

  const activeCount = activeFilterCount(value);

  const saveCurrentPreset = () => {
    const name = presetName.trim();
    if (!name) { toast.error("Name required"); return; }
    const next = [...presets.filter((p) => p.name !== name), { name, filters: value }];
    setPresets(next); savePresets(presetKey, next);
    setPresetName(""); setSavingPreset(false);
    toast.success(`Preset "${name}" saved`);
  };
  const deletePreset = (name: string) => {
    const next = presets.filter((p) => p.name !== name);
    setPresets(next); savePresets(presetKey, next);
    toast.success("Preset deleted");
  };
  const applyPreset = (p: SavedPreset) => { onChange(p.filters); toast.success(`Applied "${p.name}"`); };

  const reset = () => { onChange({ ...DEFAULT_FILTERS, sortKey: value.sortKey, sortDir: value.sortDir }); };

  /* ---------- Active chips ---------- */
  const chips = useMemo(() => {
    const c: Array<{ key: string; label: string; clear: () => void }> = [];
    if (value.source !== "all") c.push({ key: "source", label: `Source: ${value.source.toUpperCase()}`, clear: () => set("source", "all") });
    if (value.warehouseIds.length > 0) {
      const labels = value.warehouseIds
        .map((id) => warehouseOptions.find((w) => w.id === id)?.label ?? id)
        .join(", ");
      c.push({ key: "wh", label: `Warehouses: ${labels}`, clear: () => set("warehouseIds", []) });
    }
    if (value.stockState !== "any") {
      const map: Record<string, string> = { inStock: "In stock", low: "Low stock", out: "Out of stock", over: "Overstocked" };
      c.push({ key: "ss", label: map[value.stockState] ?? value.stockState, clear: () => set("stockState", "any") });
    }
    if (value.priceMin || value.priceMax) {
      c.push({ key: "price", label: `Price ${value.priceMin || "0"}–${value.priceMax || "∞"}`,
        clear: () => onChange({ ...value, priceMin: "", priceMax: "" }) });
    }
    if (value.salePriceMin || value.salePriceMax) {
      c.push({ key: "sale", label: `Sale ${value.salePriceMin || "0"}–${value.salePriceMax || "∞"}`,
        clear: () => onChange({ ...value, salePriceMin: "", salePriceMax: "" }) });
    }
    if (value.weightMin || value.weightMax) {
      c.push({ key: "wt", label: `Weight ${value.weightMin || "0"}–${value.weightMax || "∞"}`,
        clear: () => onChange({ ...value, weightMin: "", weightMax: "" }) });
    }
    if (value.wcType !== "all") c.push({ key: "type", label: `Type: ${value.wcType}`, clear: () => set("wcType", "all") });
    if (value.stockStatus !== "any") c.push({ key: "wcst", label: `WC status: ${value.stockStatus}`, clear: () => set("stockStatus", "any") });
    if (value.manageStock !== "any") c.push({ key: "ms", label: `Managed: ${value.manageStock}`, clear: () => set("manageStock", "any") });
    if (value.editedOnly) c.push({ key: "edit", label: "Edited only", clear: () => set("editedOnly", false) });
    if (value.hasImage !== "any") c.push({ key: "img", label: `Image: ${value.hasImage}`, clear: () => set("hasImage", "any") });
    if (value.hasSale !== "any") c.push({ key: "hs", label: `On sale: ${value.hasSale}`, clear: () => set("hasSale", "any") });
    return c;
  }, [value, warehouseOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-1.5">
      {/* Toolbar row */}
      <div className="flex flex-wrap items-center gap-2">
        {has("search") && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={value.search}
              onChange={(e) => set("search", e.target.value)}
              placeholder="SKU or name…"
              className="h-8 w-56 pl-7 text-xs"
            />
          </div>
        )}

        {/* Sort */}
        <div className="flex items-center gap-1 rounded-md border bg-background">
          <Select value={value.sortKey} onValueChange={(v) => set("sortKey", v as SortKey)}>
            <SelectTrigger className="h-8 w-[140px] rounded-r-none border-0 text-xs">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              {sortOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost" size="icon" className="h-8 w-8 rounded-l-none"
            onClick={() => set("sortDir", value.sortDir === "asc" ? "desc" : "asc")}
            title={value.sortDir === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
          >
            {value.sortDir === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
          </Button>
        </div>

        {/* Filters popover */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Filters
              {activeCount > 0 && (
                <Badge className="ml-0.5 h-4 min-w-4 px-1 text-[10px]">{activeCount}</Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[420px] p-3">
            <div className="space-y-3">
              {has("source") && (
                <FilterSelect label="Source" value={value.source}
                  onValueChange={(v) => set("source", v as InventoryFilters["source"])}
                  options={[
                    { value: "all", label: "All sources" },
                    { value: "oms", label: "OMS" },
                    { value: "woo", label: "WooCommerce" },
                  ]}
                />
              )}

              {has("warehouse") && warehouseOptions.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Warehouses</Label>
                  <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-auto rounded border p-2">
                    {warehouseOptions.map((w) => {
                      const checked = value.warehouseIds.includes(w.id);
                      return (
                        <label key={w.id} className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <Checkbox checked={checked} onCheckedChange={(v) => {
                            const next = v
                              ? [...value.warehouseIds, w.id]
                              : value.warehouseIds.filter((x) => x !== w.id);
                            set("warehouseIds", next);
                          }} />
                          <span className="truncate">{w.label}</span>
                        </label>
                      );
                    })}
                  </div>
                  {value.warehouseIds.length > 0 && (
                    <button onClick={() => set("warehouseIds", [])}
                      className="text-[10px] text-muted-foreground hover:text-foreground">
                      Clear warehouses
                    </button>
                  )}
                </div>
              )}

              {has("stockState") && (
                <FilterSelect label="Stock state" value={value.stockState}
                  onValueChange={(v) => set("stockState", v as InventoryFilters["stockState"])}
                  options={[
                    { value: "any", label: "Any" },
                    { value: "inStock", label: "In stock (>0)" },
                    { value: "low", label: "Low (≤ reorder / 5)" },
                    { value: "out", label: "Out of stock" },
                    { value: "over", label: "Overstocked (> 100)" },
                  ]}
                />
              )}

              {has("wcType") && (
                <FilterSelect label="Product type" value={value.wcType}
                  onValueChange={(v) => set("wcType", v as InventoryFilters["wcType"])}
                  options={[
                    { value: "all", label: "All types" },
                    { value: "simple", label: "Simple" },
                    { value: "variable", label: "Variable parents" },
                    { value: "variation", label: "Variations" },
                  ]}
                />
              )}

              {has("stockStatus") && (
                <FilterSelect label="WC stock status" value={value.stockStatus}
                  onValueChange={(v) => set("stockStatus", v as InventoryFilters["stockStatus"])}
                  options={[
                    { value: "any", label: "Any" },
                    { value: "instock", label: "In stock" },
                    { value: "outofstock", label: "Out of stock" },
                    { value: "onbackorder", label: "On backorder" },
                  ]}
                />
              )}

              {has("priceRange") && (
                <RangeInputs label="Regular price"
                  min={value.priceMin} max={value.priceMax}
                  onMin={(v) => set("priceMin", v)} onMax={(v) => set("priceMax", v)}
                />
              )}

              {has("salePriceRange") && (
                <RangeInputs label="Sale price"
                  min={value.salePriceMin} max={value.salePriceMax}
                  onMin={(v) => set("salePriceMin", v)} onMax={(v) => set("salePriceMax", v)}
                />
              )}

              {has("weightRange") && (
                <RangeInputs label="Weight (kg)"
                  min={value.weightMin} max={value.weightMax}
                  onMin={(v) => set("weightMin", v)} onMax={(v) => set("weightMax", v)}
                />
              )}

              {(has("manageStock") || has("hasImage") || has("hasSale") || has("edited")) && (
                <div className="grid grid-cols-2 gap-2 pt-1">
                  {has("manageStock") && (
                    <FilterSelect label="Manage stock" value={value.manageStock}
                      onValueChange={(v) => set("manageStock", v as InventoryFilters["manageStock"])}
                      options={[
                        { value: "any", label: "Any" },
                        { value: "yes", label: "Yes" },
                        { value: "no", label: "No" },
                      ]}
                    />
                  )}
                  {has("hasImage") && (
                    <FilterSelect label="Image" value={value.hasImage}
                      onValueChange={(v) => set("hasImage", v as InventoryFilters["hasImage"])}
                      options={[
                        { value: "any", label: "Any" },
                        { value: "yes", label: "Has image" },
                        { value: "no", label: "Missing" },
                      ]}
                    />
                  )}
                  {has("hasSale") && (
                    <FilterSelect label="On sale" value={value.hasSale}
                      onValueChange={(v) => set("hasSale", v as InventoryFilters["hasSale"])}
                      options={[
                        { value: "any", label: "Any" },
                        { value: "yes", label: "On sale" },
                        { value: "no", label: "Not on sale" },
                      ]}
                    />
                  )}
                  {has("edited") && (
                    <label className="flex items-end gap-1.5 text-xs cursor-pointer pb-1.5">
                      <Checkbox checked={value.editedOnly}
                        onCheckedChange={(v) => set("editedOnly", !!v)} />
                      <span>Edited only{counts?.edited != null ? ` (${counts.edited})` : ""}</span>
                    </label>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between pt-2 border-t">
                <span className="text-[11px] text-muted-foreground">
                  {counts?.visible != null && counts?.total != null
                    ? `${counts.visible} of ${counts.total} match`
                    : ""}
                </span>
                <Button variant="ghost" size="sm" onClick={reset} className="h-7 gap-1.5">
                  <RotateCcw className="h-3 w-3" /> Reset
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>

        {/* Presets */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <Bookmark className="h-3.5 w-3.5" />
              Presets
              {presets.length > 0 && (
                <span className="text-muted-foreground">({presets.length})</span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Saved filter presets</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {presets.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No presets yet. Configure filters and save.
              </div>
            )}
            {presets.map((p) => (
              <DropdownMenuItem key={p.name}
                onSelect={(e) => { e.preventDefault(); applyPreset(p); }}
                className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 truncate">
                  <Check className="h-3 w-3 opacity-50" />
                  {p.name}
                </span>
                <button onClick={(e) => { e.stopPropagation(); deletePreset(p.name); }}
                  className="text-muted-foreground hover:text-destructive p-0.5 rounded"
                  aria-label={`Delete ${p.name}`}>
                  <Trash2 className="h-3 w-3" />
                </button>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {savingPreset ? (
              <div className="p-2 space-y-1.5">
                <Input value={presetName} onChange={(e) => setPresetName(e.target.value)}
                  placeholder="Preset name…" maxLength={40} autoFocus
                  className="h-7 text-xs"
                  onKeyDown={(e) => { if (e.key === "Enter") saveCurrentPreset(); }} />
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" size="sm" className="h-6 text-[11px]"
                    onClick={() => { setSavingPreset(false); setPresetName(""); }}>Cancel</Button>
                  <Button size="sm" className="h-6 text-[11px]" onClick={saveCurrentPreset}>Save</Button>
                </div>
              </div>
            ) : (
              <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setSavingPreset(true); }}>
                <Plus className="h-3.5 w-3.5" /> Save current filters…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {activeCount > 0 && (
          <Button variant="ghost" size="sm" onClick={reset} className="h-8 gap-1.5 text-muted-foreground">
            <RotateCcw className="h-3 w-3" /> Reset all
          </Button>
        )}
      </div>

      {/* Active chips */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <Badge key={c.key} variant="secondary"
              className={cn("h-6 gap-1 pr-1 text-[11px] font-normal")}>
              {c.label}
              <button onClick={c.clear}
                className="rounded-full p-0.5 hover:bg-background/80"
                aria-label={`Clear ${c.label}`}>
                <X className="h-2.5 w-2.5" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Small internal helpers ---------- */
function FilterSelect({ label, value, onValueChange, options }: {
  label: string; value: string; onValueChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function RangeInputs({ label, min, max, onMin, onMax }: {
  label: string; min: string; max: string;
  onMin: (v: string) => void; onMax: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-1.5">
        <Input value={min} onChange={(e) => onMin(e.target.value)}
          placeholder="Min" inputMode="decimal"
          className="h-8 text-xs font-mono" />
        <span className="text-muted-foreground text-xs">–</span>
        <Input value={max} onChange={(e) => onMax(e.target.value)}
          placeholder="Max" inputMode="decimal"
          className="h-8 text-xs font-mono" />
      </div>
    </div>
  );
}
