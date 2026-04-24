import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { PanelId } from "@/lib/dashboard-layout";

type Props = {
  id: PanelId;
  editing: boolean;
  onHide?: (id: PanelId) => void;
  className?: string;
  children: ReactNode;
};

export function SortablePanel({ id, editing, onHide, className, children }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !editing,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative",
        isDragging && "z-50 opacity-80 ring-2 ring-primary rounded-2xl",
        editing && "outline outline-2 outline-dashed outline-primary/30 rounded-2xl",
        className,
      )}
    >
      {editing && (
        <div className="absolute -top-2 right-2 z-10 flex items-center gap-1 rounded-full bg-card border border-border shadow-sm px-1.5 py-1">
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="h-6 w-6 rounded-full hover:bg-muted flex items-center justify-center cursor-grab active:cursor-grabbing"
            aria-label="Drag to reorder"
            title="Drag to reorder"
          >
            <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          {onHide && (
            <button
              type="button"
              onClick={() => onHide(id)}
              className="h-6 w-6 rounded-full hover:bg-destructive/10 hover:text-destructive flex items-center justify-center"
              aria-label="Hide panel"
              title="Hide panel"
            >
              <EyeOff className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
