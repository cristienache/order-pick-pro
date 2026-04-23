// Three-step "Push to WooCommerce" confirmation dialog.
//
// Step 1 — Confirm: "You're about to push N products."
// Step 2 — Backup:  "Create a backup first?" (Yes / Skip)
// Step 3 — Confirm: final "Push" button (must type PUSH).
//
// Used from /inventory/woo. The dialog owns its own step state; the parent
// only provides the count, the action callbacks, and an open/close handle.

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, ShieldCheck, AlertTriangle, ArrowRight, Database, Send } from "lucide-react";

type Step = 1 | 2 | 3;

export function PushToWcDialog({
  open,
  onOpenChange,
  productCount,
  siteName,
  onBackup,
  onPush,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  productCount: number;
  siteName: string;
  /** Returns true on success so the dialog advances. */
  onBackup: () => Promise<boolean>;
  /** Final push. */
  onPush: () => Promise<void>;
}) {
  const [step, setStep] = useState<Step>(1);
  const [backupState, setBackupState] = useState<"idle" | "running" | "done" | "skipped">("idle");
  const [pushing, setPushing] = useState(false);
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    if (open) {
      setStep(1);
      setBackupState("idle");
      setPushing(false);
      setConfirm("");
    }
  }, [open]);

  const runBackup = async () => {
    setBackupState("running");
    const ok = await onBackup();
    setBackupState(ok ? "done" : "idle");
    if (ok) setStep(3);
  };

  const skipBackup = () => {
    setBackupState("skipped");
    setStep(3);
  };

  const runPush = async () => {
    setPushing(true);
    try { await onPush(); onOpenChange(false); }
    finally { setPushing(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !pushing && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        {step === 1 && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-brand-amber" />
                Push to WooCommerce?
              </DialogTitle>
              <DialogDescription>
                You're about to push <strong>{productCount}</strong> product{productCount === 1 ? "" : "s"} to{" "}
                <strong>{siteName}</strong>. This will overwrite the live data on your store.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => setStep(2)}>
                Continue <ArrowRight className="ml-1.5 h-4 w-4" />
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 2 && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Database className="h-5 w-5 text-brand-emerald" />
                Create a backup first?
              </DialogTitle>
              <DialogDescription>
                We'll snapshot the current WooCommerce state of these {productCount} product
                {productCount === 1 ? "" : "s"} so you can one-click restore if anything goes wrong.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border border-brand-amber/40 bg-brand-amber-soft p-3 text-xs text-foreground/80">
              <p className="font-semibold mb-0.5">Recommended.</p>
              <p>Skipping means there's no automatic way to undo this push.</p>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="ghost" onClick={skipBackup} disabled={backupState === "running"}>
                Skip backup
              </Button>
              <Button onClick={runBackup} disabled={backupState === "running"}>
                {backupState === "running"
                  ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Backing up…</>
                  : <><ShieldCheck className="mr-1.5 h-4 w-4" /> Create backup</>}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 3 && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Send className="h-5 w-5 text-brand-rose" />
                Final confirmation
              </DialogTitle>
              <DialogDescription>
                Type <code className="rounded bg-muted px-1 font-mono text-xs">PUSH</code> to send{" "}
                <strong>{productCount}</strong> product{productCount === 1 ? "" : "s"} to{" "}
                <strong>{siteName}</strong>.
                {backupState === "skipped" && (
                  <span className="mt-1 block text-brand-amber">Backup was skipped.</span>
                )}
                {backupState === "done" && (
                  <span className="mt-1 block text-brand-emerald">Backup saved — restore from "Backups" tab.</span>
                )}
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Type PUSH to enable"
              className="font-mono"
            />
            <DialogFooter className="gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pushing}>
                Cancel
              </Button>
              <Button
                onClick={runPush}
                disabled={confirm !== "PUSH" || pushing}
                variant="default"
              >
                {pushing
                  ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Pushing…</>
                  : <><Send className="mr-1.5 h-4 w-4" /> Push to WooCommerce</>}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
