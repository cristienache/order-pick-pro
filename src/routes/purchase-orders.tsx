import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { RequireAuth } from "@/components/require-auth";
import { ClipboardList, Truck, Users } from "lucide-react";

export const Route = createFileRoute("/purchase-orders")({
  head: () => ({ meta: [{ title: "Purchase Orders — HeyShop" }] }),
  component: PoLayout,
});

function PoLayout() {
  return (
    <RequireAuth>
      <AppShell>
        <div className="space-y-4">
          <div className="flex items-center gap-1 border-b border-border/60 pb-1">
            <SubLink to="/purchase-orders" icon={<ClipboardList className="h-4 w-4" />} exact>
              Purchase orders
            </SubLink>
            <SubLink to="/purchase-orders/suppliers" icon={<Users className="h-4 w-4" />}>
              Suppliers
            </SubLink>
            <SubLink to="/purchase-orders/new" icon={<Truck className="h-4 w-4" />}>
              New PO
            </SubLink>
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
