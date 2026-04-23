import { createFileRoute, Link, Outlet, useLocation, redirect } from "@tanstack/react-router";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { Store, Truck, Plug } from "lucide-react";
import type { ReactNode } from "react";

export const Route = createFileRoute("/integrations")({
  component: () => (
    <RequireAuth>
      <AppShell>
        <IntegrationsLayout />
      </AppShell>
    </RequireAuth>
  ),
  // Land users on Channels by default if they hit /integrations directly.
  beforeLoad: ({ location }) => {
    if (location.pathname === "/integrations" || location.pathname === "/integrations/") {
      throw redirect({ to: "/integrations/channels" });
    }
  },
  head: () => ({
    meta: [
      { title: "Integrations | Ultrax" },
      { name: "description", content: "Connect your sales channels and shipping carriers." },
    ],
  }),
});

function IntegrationsLayout() {
  const { pathname } = useLocation();
  const isShipping = pathname.startsWith("/integrations/shipping");
  const isChannels = pathname.startsWith("/integrations/channels");

  return (
    <div className="flex flex-col lg:flex-row gap-6">
      {/* Left sidebar */}
      <aside className="lg:w-60 lg:shrink-0 space-y-1">
        <div className="px-3 py-2 mb-1">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
            <Plug className="h-3 w-3" />
            Integrations
          </div>
        </div>

        <SidebarSection title="Sales channels">
          <SidebarLink to="/integrations/channels" active={isChannels} icon={<Store className="h-4 w-4" />}>
            All channels
          </SidebarLink>
        </SidebarSection>

        <SidebarSection title="Shipping carriers">
          <SidebarLink
            to="/integrations/shipping"
            active={pathname === "/integrations/shipping" || pathname === "/integrations/shipping/"}
            icon={<Truck className="h-4 w-4" />}
          >
            Overview
          </SidebarLink>
          <SidebarLink
            to="/integrations/shipping/royal-mail"
            active={pathname.startsWith("/integrations/shipping/royal-mail")}
            icon={<span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />}
          >
            Royal Mail
          </SidebarLink>
          <SidebarLink
            to="/integrations/shipping/packeta"
            active={pathname.startsWith("/integrations/shipping/packeta")}
            icon={<span className="inline-block h-2 w-2 rounded-full bg-rose-500" />}
          >
            Packeta
          </SidebarLink>
        </SidebarSection>

        {!isShipping && !isChannels && null}
      </aside>

      {/* Right content */}
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-semibold">
        {title}
      </div>
      {children}
    </div>
  );
}

function SidebarLink({
  to, active, icon, children,
}: { to: string; active: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <Link
      to={to}
      className={
        "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors " +
        (active
          ? "bg-accent text-foreground font-semibold"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/60")
      }
    >
      <span className="flex h-4 w-4 items-center justify-center">{icon}</span>
      {children}
    </Link>
  );
}
