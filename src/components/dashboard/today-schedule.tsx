import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Pencil, Trash2, Plus, X, Check } from "lucide-react";
import { cn } from "@/lib/utils";

type Tag = "Orders" | "Shipping" | "Inventory" | "Custom";

type Task = {
  id: string;
  title: string;
  time?: string; // HH:mm
  tag: Tag;
  done: boolean;
};

const TAGS: Tag[] = ["Orders", "Shipping", "Inventory", "Custom"];

const TAG_COLORS: Record<Tag, string> = {
  Orders: "bg-brand-violet-soft text-primary",
  Shipping: "bg-brand-emerald-soft text-brand-emerald",
  Inventory: "bg-brand-amber-soft text-brand-amber",
  Custom: "bg-muted text-muted-foreground",
};

function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `ultrax_today_tasks_${yyyy}-${mm}-${dd}`;
}

const SEED: Task[] = [
  { id: "s1", title: "Process new orders", tag: "Orders", done: false, time: "09:00" },
  { id: "s2", title: "Generate Royal Mail labels", tag: "Shipping", done: false, time: "11:30" },
  { id: "s3", title: "Review low-stock SKUs", tag: "Inventory", done: false, time: "15:00" },
];

function loadTasks(): Task[] {
  if (typeof window === "undefined") return SEED;
  try {
    const raw = localStorage.getItem(todayKey());
    if (!raw) return SEED;
    return JSON.parse(raw) as Task[];
  } catch {
    return SEED;
  }
}

function saveTasks(tasks: Task[]) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(todayKey(), JSON.stringify(tasks)); } catch { /* noop */ }
}

export function TodaySchedule() {
  const [tasks, setTasks] = useState<Task[]>(SEED);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftTime, setDraftTime] = useState("");
  const [draftTag, setDraftTag] = useState<Tag>("Orders");

  // New-task inputs
  const [newTitle, setNewTitle] = useState("");
  const [newTime, setNewTime] = useState("");
  const [newTag, setNewTag] = useState<Tag>("Orders");

  useEffect(() => { setTasks(loadTasks()); }, []);
  useEffect(() => { saveTasks(tasks); }, [tasks]);

  const sorted = useMemo(() => {
    const incomplete = tasks.filter((t) => !t.done).sort((a, b) => {
      if (a.time && b.time) return a.time.localeCompare(b.time);
      if (a.time) return -1;
      if (b.time) return 1;
      return 0;
    });
    const complete = tasks.filter((t) => t.done);
    return [...incomplete, ...complete];
  }, [tasks]);

  const doneCount = tasks.filter((t) => t.done).length;
  const total = tasks.length;
  const pct = total === 0 ? 0 : Math.round((doneCount / total) * 100);

  const dateLabel = useMemo(() => {
    return new Date().toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  }, []);

  function addTask() {
    const title = newTitle.trim();
    if (!title) return;
    const t: Task = {
      id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      time: newTime || undefined,
      tag: newTag,
      done: false,
    };
    setTasks((prev) => [...prev, t]);
    setNewTitle("");
    setNewTime("");
  }

  function toggle(id: string) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  }

  function remove(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  function startEdit(t: Task) {
    setEditingId(t.id);
    setDraftTitle(t.title);
    setDraftTime(t.time || "");
    setDraftTag(t.tag);
  }

  function saveEdit() {
    if (!editingId) return;
    const title = draftTitle.trim();
    if (!title) { setEditingId(null); return; }
    setTasks((prev) => prev.map((t) => t.id === editingId
      ? { ...t, title, time: draftTime || undefined, tag: draftTag }
      : t));
    setEditingId(null);
  }

  return (
    <div className="space-y-3">
      {/* Header with progress */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">Today</div>
            <div className="text-sm font-semibold">{dateLabel}</div>
          </div>
          <div className="text-xs tabular-nums text-muted-foreground">
            {doneCount} of {total} done
          </div>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Task list */}
      <div className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
        {sorted.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-4">
            No tasks yet — add one below.
          </div>
        )}
        {sorted.map((t) => (
          <div
            key={t.id}
            className={cn(
              "group rounded-xl border border-border/70 p-2.5 transition",
              t.done ? "bg-muted/40 opacity-70" : "hover:bg-muted/30",
            )}
          >
            {editingId === t.id ? (
              <div className="space-y-2">
                <Input
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  className="h-8 text-sm"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditingId(null); }}
                />
                <div className="flex items-center gap-2">
                  <Input
                    type="time"
                    value={draftTime}
                    onChange={(e) => setDraftTime(e.target.value)}
                    className="h-8 text-xs w-28"
                  />
                  <Select value={draftTag} onValueChange={(v) => setDraftTag(v as Tag)}>
                    <SelectTrigger className="h-8 text-xs flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TAGS.map((tg) => <SelectItem key={tg} value={tg}>{tg}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={saveEdit}>
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingId(null)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2.5">
                <Checkbox
                  checked={t.done}
                  onCheckedChange={() => toggle(t.id)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold",
                      TAG_COLORS[t.tag],
                    )}>
                      {t.tag}
                    </span>
                    {t.time && (
                      <span className="text-[10px] tabular-nums text-muted-foreground font-medium">
                        {t.time}
                      </span>
                    )}
                  </div>
                  <div className={cn(
                    "mt-1 text-sm font-medium leading-snug break-words",
                    t.done && "line-through text-muted-foreground",
                  )}>
                    {t.title}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition">
                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => startEdit(t)}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-6 w-6 hover:text-destructive" onClick={() => remove(t.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add new */}
      <div className="rounded-xl border border-dashed border-border/70 p-2.5 space-y-2">
        <Input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add a task…"
          className="h-8 text-sm"
          onKeyDown={(e) => { if (e.key === "Enter") addTask(); }}
        />
        <div className="flex items-center gap-2">
          <Input
            type="time"
            value={newTime}
            onChange={(e) => setNewTime(e.target.value)}
            className="h-8 text-xs w-28"
          />
          <Select value={newTag} onValueChange={(v) => setNewTag(v as Tag)}>
            <SelectTrigger className="h-8 text-xs flex-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TAGS.map((tg) => <SelectItem key={tg} value={tg}>{tg}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" className="h-8 gap-1" onClick={addTask} disabled={!newTitle.trim()}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
      </div>
    </div>
  );
}
