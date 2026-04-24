// Global background-sync context. Lets the WooCommerce sync run independently
// of any single page — the user can navigate away to /orders, /inventory,
// even sign out & back in within the same SPA session, and the sync keeps
// chugging. The current state is exposed to the topbar via a sticky pill.

import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wcApi } from "@/lib/inventory-woo-api";

export type WcSyncState = {
  siteId: number;
  siteName: string;
  page: number;
  totalPages: number | null;
  created: number;
  updated: number;
  errors: number;
  done: boolean;
  startedAt: number;
  /** True when the run is using the incremental `modified_after` filter. */
  incremental: boolean;
};

type Ctx = {
  current: WcSyncState | null;
  isRunning: boolean;
  /** Kick off a background sync. No-ops if one is already running.
   *  By default runs INCREMENTAL — only products WC has modified since the
   *  last successful sync. Pass `{ full: true }` to re-import everything. */
  startWcSync: (siteId: number, siteName: string, opts?: { full?: boolean }) => Promise<void>;
  /** Soft-cancel — finishes the in-flight page then stops. */
  cancel: () => void;
};

const SyncCtx = createContext<Ctx | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState<WcSyncState | null>(null);
  const runningRef = useRef(false);
  const cancelRef = useRef(false);

  const cancel = useCallback(() => { cancelRef.current = true; }, []);

  const startWcSync = useCallback(async (
    siteId: number,
    siteName: string,
    opts: { full?: boolean } = {},
  ) => {
    if (runningRef.current) {
      toast.info("A sync is already running. It will keep going while you browse.");
      return;
    }
    runningRef.current = true;
    cancelRef.current = false;
    const startedAt = Date.now();
    setCurrent({
      siteId, siteName, page: 0, totalPages: null,
      created: 0, updated: 0, errors: 0, done: false, startedAt,
      incremental: !opts.full,
    });

    const t = toast.loading(
      opts.full ? `Full re-sync of ${siteName}…` : `Syncing ${siteName} (changes only)…`,
      { duration: Infinity },
    );
    let page = 1;
    let since = "";
    let cursor = "";
    let incremental = !opts.full;
    let totalCreated = 0, totalUpdated = 0, totalErrors = 0;

    try {
      // Hard cap: 200 pages × 50 = 10k products.
      for (let i = 0; i < 200; i++) {
        if (cancelRef.current) break;
        const r = await wcApi.syncPage(siteId, page, 50, {
          full: opts.full,
          // Thread the cursor the server captured on page 1 across all pages.
          since: page > 1 ? since : undefined,
          cursor: page > 1 ? cursor : undefined,
        });
        if (page === 1) {
          since = r.since || "";
        }
        cursor = r.cursor || cursor || since;
        incremental = r.incremental;
        totalCreated += r.created;
        totalUpdated += r.updated;
        totalErrors += r.errors.length;
        setCurrent({
          siteId, siteName, page: r.page, totalPages: r.total_pages,
          created: totalCreated, updated: totalUpdated, errors: totalErrors,
          done: !!r.done, startedAt, incremental,
        });
        const progress = r.total_pages ? `page ${r.page}/${r.total_pages}` : `page ${r.page}`;
        const mode = incremental ? " (changes only)" : "";
        toast.loading(
          `Syncing ${siteName}${mode} — ${progress} • ${totalCreated + totalUpdated} products`,
          { id: t, duration: Infinity },
        );
        if (r.done || r.next_page == null) break;
        page = r.next_page;
      }
      const errMsg = totalErrors ? ` • ${totalErrors} warning${totalErrors === 1 ? "" : "s"}` : "";
      const cancelled = cancelRef.current;
      const noChanges = incremental && totalCreated === 0 && totalUpdated === 0 && !cancelled;
      toast[cancelled ? "info" : "success"](
        cancelled
          ? `Sync stopped: ${totalCreated} new, ${totalUpdated} updated`
          : noChanges
            ? `${siteName} is already up to date — no changes since last sync`
            : `Synced: ${totalCreated} new, ${totalUpdated} updated${errMsg}`,
        { id: t, duration: 6000 },
      );
      qc.invalidateQueries({ queryKey: ["wc-sites"] });
      qc.invalidateQueries({ queryKey: ["wc-products", siteId] });
      qc.invalidateQueries({ queryKey: ["wc-inventory", siteId] });
      qc.invalidateQueries({ queryKey: ["oms-products"] });
      qc.invalidateQueries({ queryKey: ["oms-inventory"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed", { id: t, duration: 8000 });
    } finally {
      runningRef.current = false;
      // Keep the final state visible for ~5s so the topbar pill confirms success.
      setTimeout(() => {
        setCurrent((s) => (s && s.startedAt === startedAt ? null : s));
      }, 5000);
    }
  }, [qc]);

  return (
    <SyncCtx.Provider value={{ current, isRunning: !!current && !current.done, startWcSync, cancel }}>
      {children}
    </SyncCtx.Provider>
  );
}

export function useSync(): Ctx {
  const ctx = useContext(SyncCtx);
  if (!ctx) throw new Error("useSync must be used inside <SyncProvider>");
  return ctx;
}
