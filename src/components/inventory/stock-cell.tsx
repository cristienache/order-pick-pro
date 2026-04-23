import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface StockCellProps {
  value: number;
  reorder: number;
  disabled?: boolean;
  onCommit: (next: number) => Promise<void> | void;
  cellId: string;
  selected?: boolean;
  onSelect?: () => void;
}

function tone(qty: number, reorder: number) {
  if (qty <= reorder) return "text-brand-rose";
  if (qty <= reorder * 1.5) return "text-brand-amber";
  return "text-brand-emerald";
}

function dotTone(qty: number, reorder: number) {
  if (qty <= reorder) return "bg-brand-rose";
  if (qty <= reorder * 1.5) return "bg-brand-amber";
  return "bg-brand-emerald";
}

/**
 * Editable stock cell. Click to edit, Enter saves and moves down, Tab moves
 * right (Shift+Tab moves left), Esc cancels.
 */
export function StockCell({
  value, reorder, disabled, onCommit, cellId, selected, onSelect,
}: StockCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = async () => {
    const n = parseInt(draft, 10);
    if (Number.isNaN(n) || n < 0) { setDraft(String(value)); setEditing(false); return; }
    if (n === value) { setEditing(false); return; }
    setSaving(true);
    try { await onCommit(n); }
    finally { setSaving(false); setEditing(false); }
  };

  const handleKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault(); await commit();
      const next = document.querySelector<HTMLElement>(
        `[data-cell-id="${nextId(cellId, "down")}"]`,
      );
      next?.focus(); next?.click();
    } else if (e.key === "Escape") {
      setDraft(String(value)); setEditing(false);
    } else if (e.key === "Tab") {
      e.preventDefault(); await commit();
      const dir = e.shiftKey ? "left" : "right";
      const next = document.querySelector<HTMLElement>(
        `[data-cell-id="${nextId(cellId, dir)}"]`,
      );
      next?.focus(); next?.click();
    }
  };

  return (
    <button
      type="button"
      data-cell-id={cellId}
      onClick={() => { if (disabled) return; onSelect?.(); setEditing(true); }}
      disabled={disabled}
      className={cn(
        "group flex h-9 w-full items-center justify-end gap-1 px-2 font-mono text-xs tabular-nums outline-none transition-colors",
        "border-l border-border/60 hover:bg-muted/60",
        selected && "ring-1 ring-foreground ring-inset",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKey}
          inputMode="numeric"
          className="h-7 w-full rounded border border-foreground/40 bg-background px-1 text-right font-mono text-xs outline-none"
        />
      ) : (
        <>
          <span className={cn("font-medium", tone(value, reorder), saving && "opacity-50")}>
            {value}
          </span>
          <span className={cn("h-1.5 w-1.5 rounded-full", dotTone(value, reorder))} />
        </>
      )}
    </button>
  );
}

function nextId(id: string, dir: "up" | "down" | "left" | "right") {
  const m = id.match(/^r(\d+)-c(\d+)$/);
  if (!m) return id;
  let r = parseInt(m[1], 10);
  let c = parseInt(m[2], 10);
  if (dir === "down") r++;
  else if (dir === "up") r--;
  else if (dir === "right") c++;
  else c--;
  return `r${Math.max(0, r)}-c${Math.max(0, c)}`;
}
