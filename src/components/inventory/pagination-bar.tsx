// Compact pagination bar shared by the inventory grids.
//
// Lives below a table and exposes:
//   - per-page selector: 25 / 50 / 100 / 500 / 1000 / All
//   - page navigation: First, Prev, "page X of Y", Next, Last
//   - "X–Y of Z" range text
//
// "All" is represented internally as `pageSize = 0` so the parent can short-
// circuit pagination with `pageSize === 0 ? rows : rows.slice(start, end)`.

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight } from "lucide-react";

export const PAGE_SIZE_OPTIONS = [25, 50, 100, 500, 1000, 0] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export function PaginationBar({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  total: number;
  page: number;        // 1-based
  pageSize: PageSize;  // 0 = All
  onPageChange: (p: number) => void;
  onPageSizeChange: (s: PageSize) => void;
}) {
  const showingAll = pageSize === 0 || total === 0;
  const totalPages = showingAll ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = total === 0 ? 0 : showingAll ? 1 : (safePage - 1) * pageSize + 1;
  const end = showingAll ? total : Math.min(total, safePage * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-card px-4 py-1.5 text-xs">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span>Rows per page</span>
        <Select
          value={String(pageSize)}
          onValueChange={(v) => onPageSizeChange(Number(v) as PageSize)}
        >
          <SelectTrigger className="h-7 w-[88px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="25">25</SelectItem>
            <SelectItem value="50">50</SelectItem>
            <SelectItem value="100">100</SelectItem>
            <SelectItem value="500">500</SelectItem>
            <SelectItem value="1000">1000</SelectItem>
            <SelectItem value="0">All</SelectItem>
          </SelectContent>
        </Select>
        <span className="hidden font-mono text-[11px] sm:inline">
          {start}–{end} of {total}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <span className="mr-2 hidden font-mono text-[11px] text-muted-foreground sm:inline">
          Page {safePage} of {totalPages}
        </span>
        <Button
          variant="outline" size="icon" className="h-7 w-7"
          onClick={() => onPageChange(1)}
          disabled={showingAll || safePage <= 1}
          aria-label="First page"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline" size="icon" className="h-7 w-7"
          onClick={() => onPageChange(safePage - 1)}
          disabled={showingAll || safePage <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline" size="icon" className="h-7 w-7"
          onClick={() => onPageChange(safePage + 1)}
          disabled={showingAll || safePage >= totalPages}
          aria-label="Next page"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline" size="icon" className="h-7 w-7"
          onClick={() => onPageChange(totalPages)}
          disabled={showingAll || safePage >= totalPages}
          aria-label="Last page"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
