import { Badge } from "@/components/ui/badge";
import { Truck, Coins, RefreshCw, AlertTriangle } from "lucide-react";
import {
  isAging, isExpedited, isHighValue, isRepeat, type OrderRow,
} from "@/lib/orders";

export function PriorityBadges({
  order, highValueThreshold,
}: { order: OrderRow; highValueThreshold: number }) {
  const flags: { key: string; label: string; icon: React.ReactNode; cls: string }[] = [];
  if (isExpedited(order)) flags.push({
    key: "exp", label: "Express", icon: <Truck className="h-3 w-3" />,
    cls: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  });
  if (isHighValue(order, highValueThreshold)) flags.push({
    key: "hv", label: "High value", icon: <Coins className="h-3 w-3" />,
    cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  });
  if (isRepeat(order)) flags.push({
    key: "rp", label: "Repeat", icon: <RefreshCw className="h-3 w-3" />,
    cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  });
  if (isAging(order)) flags.push({
    key: "ag", label: "Aging", icon: <AlertTriangle className="h-3 w-3" />,
    cls: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  });
  if (flags.length === 0) return null;
  return (
    <div className="flex gap-1 flex-wrap">
      {flags.map((f) => (
        <Badge key={f.key} variant="outline" className={`gap-1 px-1.5 py-0 text-[10px] ${f.cls}`}>
          {f.icon} {f.label}
        </Badge>
      ))}
    </div>
  );
}
