import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { RequireAuth } from "@/components/require-auth";
import { Boxes, ScrollText, Truck, Store } from "lucide-react";

export const Route = createFileRoute("/inventory")({
  head: () => ({ meta: [{ title: "Inventory — HeyShop" }] }),
  component: InventoryLayout,
});

function InventoryLayout() {
  return (
    <RequireAuth>
      <AppShell>
        <div className="space-y-4">
          <div className="flex items-center gap-1 border-b border-border/60 pb-1">
            <SubLink to="/inventory" icon={<Boxes className="h-4 w-4" />} exact>Stock grid</SubLink>
            <SubLink to="/inventory/woo" icon={<Store className="h-4 w-4" />}>WooCommerce</SubLink>
            <SubLink to="/inventory/orders" icon={<Truck className="h-4 w-4" />}>Orders & routing</SubLink>
            <SubLink to="/inventory/audit" icon={<ScrollText className="h-4 w-4" />}>Audit</SubLink>
          </div>
          <Outlet />
        </div>
      </AppShell>
    </RequireAuth>
  );
}

function SubLink({
  to, icon, children, exact = false,
}: { to: string; icon: React.ReactNode; children: React.ReactNode; exact?: boolean }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact }}
      className="px-3 py-1.5 rounded-md flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
      activeProps={{
        className:
          "px-3 py-1.5 rounded-md flex items-center gap-1.5 text-sm font-semibold bg-accent text-foreground transition-colors",
      }}
    >
      {icon} {children}
    </Link>
  );
}
