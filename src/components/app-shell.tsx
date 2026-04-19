import { Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { LogOut, Package, Settings, Users, Store } from "lucide-react";
import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate({ to: "/login" });
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-6">
            <Link to="/" className="font-bold text-lg flex items-center gap-2">
              <Package className="h-5 w-5" /> Ultrax
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <NavLink to="/" icon={<Package className="h-4 w-4" />}>Picklist</NavLink>
              <NavLink to="/sites" icon={<Store className="h-4 w-4" />}>My Sites</NavLink>
              {user?.role === "admin" && (
                <>
                  <NavLink to="/admin/users" icon={<Users className="h-4 w-4" />}>Users</NavLink>
                  <NavLink to="/admin/invites" icon={<Settings className="h-4 w-4" />}>Invites</NavLink>
                </>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground hidden sm:inline">{user?.email}</span>
            {user?.role === "admin" && (
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">
                Admin
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              <LogOut className="h-4 w-4" /> Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto p-6">{children}</main>
    </div>
  );
}

function NavLink({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="px-3 py-1.5 rounded-md hover:bg-accent flex items-center gap-1.5 text-foreground/80"
      activeProps={{ className: "px-3 py-1.5 rounded-md bg-accent flex items-center gap-1.5 text-foreground font-medium" }}
    >
      {icon} {children}
    </Link>
  );
}
