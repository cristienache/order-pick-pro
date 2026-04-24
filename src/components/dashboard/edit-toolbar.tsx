import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { LayoutGrid, Plus, RotateCcw, Check } from "lucide-react";
import { PANEL_LABELS, type PanelId } from "@/lib/dashboard-layout";

type Props = {
  editing: boolean;
  hidden: PanelId[];
  onToggle: () => void;
  onAdd: (id: PanelId) => void;
  onReset: () => void;
};

export function EditToolbar({ editing, hidden, onToggle, onAdd, onReset }: Props) {
  if (!editing) {
    return (
      <Button variant="outline" size="sm" className="h-10 rounded-xl gap-2" onClick={onToggle}>
        <LayoutGrid className="h-4 w-4" /> Edit dashboard
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-10 rounded-xl gap-2" disabled={hidden.length === 0}>
            <Plus className="h-4 w-4" /> Add panel
            {hidden.length > 0 && (
              <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] px-1">
                {hidden.length}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Hidden panels</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {hidden.length === 0 ? (
            <DropdownMenuItem disabled>None — all visible</DropdownMenuItem>
          ) : (
            hidden.map((id) => (
              <DropdownMenuItem key={id} onSelect={() => onAdd(id)}>
                <Plus className="h-3.5 w-3.5 mr-2" /> {PANEL_LABELS[id]}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="sm" className="h-10 rounded-xl gap-2" onClick={onReset}>
        <RotateCcw className="h-4 w-4" /> Reset
      </Button>
      <Button size="sm" className="h-10 rounded-xl gap-2" onClick={onToggle}>
        <Check className="h-4 w-4" /> Done
      </Button>
    </div>
  );
}
