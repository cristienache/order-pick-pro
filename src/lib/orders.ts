// Order-related types and helpers shared by the picklist UI.

export type OrderRow = {
  id: number;
  number: string;
  status: string;
  date_created: string;
  total: string;
  currency: string;
  customer: string;
  email: string;
  shipping_method: string;
  itemCount: number;
  lineCount: number;
  previous_completed: number | null;
};

export type Format =
  | "picking_a4"
  | "packing_a4"
  | "packing_4x6"
  | "shipping_4x6"
  | "shipping_a6";
export type Mode = "single" | "multi";

export type DatePreset = "all" | "today" | "24h" | "7d" | "custom";

export const ALL_STATUSES: { value: string; label: string }[] = [
  { value: "pending", label: "Pending payment" },
  { value: "processing", label: "Processing" },
  { value: "on-hold", label: "On hold" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "refunded", label: "Refunded" },
  { value: "failed", label: "Failed" },
];

const EXPRESS_KEYWORDS = [
  "express", "next day", "priority", "1st class", "first class",
  "guaranteed", "expedited", "tracked 24",
];

export function isExpedited(o: OrderRow) {
  const s = (o.shipping_method || "").toLowerCase();
  return EXPRESS_KEYWORDS.some((k) => s.includes(k));
}

export function isHighValue(o: OrderRow, threshold: number) {
  const t = parseFloat(o.total);
  return Number.isFinite(t) && t >= threshold;
}

export function isRepeat(o: OrderRow) {
  return (o.previous_completed ?? 0) > 0;
}

const AGING_HOURS = 24;
export function isAging(o: OrderRow) {
  if (o.status !== "processing") return false;
  const t = new Date(o.date_created).getTime();
  return Number.isFinite(t) && Date.now() - t > AGING_HOURS * 3600_000;
}

export function withinDateRange(
  o: OrderRow,
  preset: DatePreset,
  customFrom?: string,
  customTo?: string,
) {
  if (preset === "all") return true;
  const t = new Date(o.date_created).getTime();
  if (!Number.isFinite(t)) return false;
  const now = Date.now();
  if (preset === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return t >= start.getTime();
  }
  if (preset === "24h") return t >= now - 24 * 3600_000;
  if (preset === "7d") return t >= now - 7 * 24 * 3600_000;
  if (preset === "custom") {
    const fromT = customFrom ? new Date(customFrom).getTime() : -Infinity;
    const toT = customTo ? new Date(customTo + "T23:59:59").getTime() : Infinity;
    return t >= fromT && t <= toT;
  }
  return true;
}
