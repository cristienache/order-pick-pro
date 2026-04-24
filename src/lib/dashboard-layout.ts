// Dashboard layout persistence — per-browser via localStorage.
// Stores which panels are visible and in what order.

export type PanelId =
  | "promo"
  | "stat-stores"
  | "stat-orders"
  | "stat-items"
  | "workspace"
  | "activity"
  | "schedule"
  | "stores-strip"
  | "all-tools";

export type DashboardLayout = {
  order: PanelId[];
  hidden: PanelId[];
};

export const DEFAULT_LAYOUT: DashboardLayout = {
  order: [
    "promo",
    "stat-stores",
    "stat-orders",
    "stat-items",
    "workspace",
    "activity",
    "schedule",
    "stores-strip",
    "all-tools",
  ],
  hidden: [],
};

export const PANEL_LABELS: Record<PanelId, string> = {
  promo: "Pro Promo",
  "stat-stores": "Connected Stores",
  "stat-orders": "Orders Today",
  "stat-items": "Total Items",
  workspace: "Workspace",
  activity: "Activity",
  schedule: "Today Schedule",
  "stores-strip": "Stores Strip",
  "all-tools": "All Tools",
};

const KEY = "ultrax_dashboard_layout_v1";

export function loadLayout(): DashboardLayout {
  if (typeof window === "undefined") return DEFAULT_LAYOUT;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<DashboardLayout>;
    const validIds = new Set<PanelId>(DEFAULT_LAYOUT.order);
    const order = (parsed.order || []).filter((id): id is PanelId => validIds.has(id as PanelId));
    const hidden = (parsed.hidden || []).filter((id): id is PanelId => validIds.has(id as PanelId));
    // Ensure every default id appears either in order or hidden.
    for (const id of DEFAULT_LAYOUT.order) {
      if (!order.includes(id) && !hidden.includes(id)) order.push(id);
    }
    return { order, hidden };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(layout: DashboardLayout) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* ignore quota / private mode */
  }
}

export function resetLayout(): DashboardLayout {
  if (typeof window !== "undefined") {
    try { localStorage.removeItem(KEY); } catch { /* noop */ }
  }
  return DEFAULT_LAYOUT;
}
