import { Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { useBranding, navLabel } from "@/lib/branding-context";
import { BrandedLogo } from "@/components/branded-logo";
import { Button } from "@/components/ui/button";
import {
  LogOut, Package, Settings, Users, Store, Truck, Home, Palette,
} from "lucide-react";
import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { branding } = useBranding();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate({ to: "/login" });
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Top nav — sticky, frosted, with subtle gradient under the brand. */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-7">
            <Link to="/" className="flex items-center gap-2.5 group">
              <BrandedLogo />
              <div className="leading-tight">
                <div className="font-bold text-base tracking-tight">{branding.app_name}</div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground -mt-0.5">
                  {branding.tagline}
                </div>
              </div>
            </Link>
            <nav className="flex items-center gap-0.5 text-sm">
              <NavLink to="/" icon={<Home className="h-4 w-4" />} exact>
                {navLabel(branding, "home")}
              </NavLink>
              <NavLink to="/orders" icon={<Package className="h-4 w-4" />}>
                {navLabel(branding, "orders")}
              </NavLink>
              <NavLink to="/integrations" icon={<Store className="h-4 w-4" />}>
                {navLabel(branding, "integrations")}
              </NavLink>
              <NavLink to="/royal-mail" icon={<Truck className="h-4 w-4" />}>
                {navLabel(branding, "royal_mail")}
              </NavLink>
              {user?.role === "admin" && (
                <>
                  <NavLink to="/admin/users" icon={<Users className="h-4 w-4" />}>
                    {navLabel(branding, "users")}
                  </NavLink>
                  <NavLink to="/admin/invites" icon={<Settings className="h-4 w-4" />}>
                    {navLabel(branding, "invites")}
                  </NavLink>
                  <NavLink to="/admin/branding" icon={<Palette className="h-4 w-4" />}>
                    Branding
                  </NavLink>
                </>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground hidden md:inline tabular-nums">
              {user?.email}
            </span>
            {user?.role === "admin" && (
              <span className="text-[10px] uppercase tracking-[0.14em] bg-brand-violet-soft text-brand-violet px-2 py-1 rounded-full font-semibold">
                Admin
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={handleLogout} className="gap-1.5">
              <LogOut className="h-4 w-4" /> Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto p-6 md:p-8">{children}</main>
    </div>
  );
}

function NavLink({
  to, icon, children, exact = false,
}: { to: string; icon: ReactNode; children: ReactNode; exact?: boolean }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact }}
      className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors focus-ring"
      activeProps={{
        className:
          "px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-sm font-semibold bg-accent text-foreground transition-colors focus-ring",
      }}
    >
      {icon} {children}
    </Link>
  );
}
