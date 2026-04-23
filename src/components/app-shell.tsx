import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useBranding, navLabel } from "@/lib/branding-context";
import { BrandedLogo } from "@/components/branded-logo";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { PageNavItem } from "@/lib/pages";
import {
  LogOut, Package, Settings, Users, Plug, Home, Palette, FileText, Boxes,
  ClipboardList, ChevronLeft, ChevronRight, Menu, Search,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  icon: ReactNode;
  exact?: boolean;
  match?: string;          // pathname prefix used to determine "active"
  adminOnly?: boolean;
  authedOnly?: boolean;    // hide when signed out
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { branding } = useBranding();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [navPages, setNavPages] = useState<PageNavItem[]>([]);
  // Persist collapsed state across visits.
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      const v = localStorage.getItem("ultrax:sidebar-collapsed");
      if (v === "1") setCollapsed(true);
    } catch { /* SSR / privacy mode */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem("ultrax:sidebar-collapsed", collapsed ? "1" : "0"); }
    catch { /* ignore */ }
  }, [collapsed]);

  // Pull published "show in nav" pages — public endpoint, no auth needed.
  useEffect(() => {
    let cancelled = false;
    api<{ pages: PageNavItem[] }>("/api/pages/nav")
      .then((r) => { if (!cancelled) setNavPages(r.pages); })
      .catch(() => { if (!cancelled) setNavPages([]); });
    return () => { cancelled = true; };
  }, []);

  // Close mobile drawer on route change.
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  const groups: NavGroup[] = useMemo(() => {
    const main: NavItem[] = [
      { to: "/", label: navLabel(branding, "home"), icon: <Home className="h-4 w-4" />, exact: true },
    ];
    const operate: NavItem[] = [
      { to: "/orders", label: navLabel(branding, "orders"), icon: <Package className="h-4 w-4" />, match: "/orders", authedOnly: true },
      { to: "/inventory", label: "Inventory", icon: <Boxes className="h-4 w-4" />, match: "/inventory", authedOnly: true },
      { to: "/purchase-orders", label: "Purchase orders", icon: <ClipboardList className="h-4 w-4" />, match: "/purchase-orders", authedOnly: true },
    ];
    const setup: NavItem[] = [
      { to: "/integrations", label: navLabel(branding, "integrations"), icon: <Plug className="h-4 w-4" />, match: "/integrations", authedOnly: true },
    ];
    const admin: NavItem[] = [
      { to: "/admin/users", label: navLabel(branding, "users"), icon: <Users className="h-4 w-4" />, match: "/admin/users", adminOnly: true },
      { to: "/admin/invites", label: navLabel(branding, "invites"), icon: <Settings className="h-4 w-4" />, match: "/admin/invites", adminOnly: true },
      { to: "/admin/pages", label: "Pages", icon: <FileText className="h-4 w-4" />, match: "/admin/pages", adminOnly: true },
      { to: "/admin/branding", label: "Branding", icon: <Palette className="h-4 w-4" />, match: "/admin/branding", adminOnly: true },
    ];
    const content: NavItem[] = navPages.map((p) => ({
      to: `/p/${p.slug}`,
      label: p.title,
      icon: <FileText className="h-4 w-4" />,
      match: `/p/${p.slug}`,
    })).concat([{ to: "/contact", label: "Contact", icon: <FileText className="h-4 w-4" />, match: "/contact" }]);

    const out: NavGroup[] = [{ label: "Overview", items: main }];
    if (user) {
      out.push({ label: "Operate", items: operate });
      out.push({ label: "Setup", items: setup });
    }
    if (content.length > 0) out.push({ label: "Content", items: content });
    if (user?.role === "admin") out.push({ label: "Administration", items: admin });
    return out;
  }, [user, branding, navPages]);

  const isActive = (item: NavItem) => {
    if (item.exact) return pathname === item.to;
    const m = item.match ?? item.to;
    return pathname === m || pathname.startsWith(`${m}/`);
  };

  const handleLogout = () => { logout(); navigate({ to: "/login" }); };

  return (
    <div className="min-h-screen bg-muted/30 text-foreground">
      {/* ---- Sidebar (desktop) ---- */}
      <aside
        className={cn(
          "hidden md:flex fixed inset-y-0 left-0 z-30 flex-col border-r border-border/60",
          "bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85 transition-[width] duration-200 ease-out",
          collapsed ? "w-[64px]" : "w-[244px]",
        )}
      >
        <SidebarBrand collapsed={collapsed} appName={branding.app_name} tagline={branding.tagline} />
        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
          {groups.map((g) => (
            <SidebarGroup key={g.label} label={g.label} collapsed={collapsed}>
              {g.items.map((item) => (
                <SidebarItem
                  key={item.to}
                  item={item}
                  active={isActive(item)}
                  collapsed={collapsed}
                />
              ))}
            </SidebarGroup>
          ))}
        </nav>
        <div className="border-t border-border/60 p-2">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className={cn(
              "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
              collapsed && "justify-center",
            )}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <><ChevronLeft className="h-4 w-4" /> <span>Collapse</span></>}
          </button>
        </div>
      </aside>

      {/* ---- Mobile drawer ---- */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm md:hidden"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-[264px] flex-col border-r border-border/60 bg-card md:hidden">
            <SidebarBrand collapsed={false} appName={branding.app_name} tagline={branding.tagline} />
            <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
              {groups.map((g) => (
                <SidebarGroup key={g.label} label={g.label} collapsed={false}>
                  {g.items.map((item) => (
                    <SidebarItem
                      key={item.to}
                      item={item}
                      active={isActive(item)}
                      collapsed={false}
                    />
                  ))}
                </SidebarGroup>
              ))}
            </nav>
          </aside>
        </>
      )}

      {/* ---- Main column (offset by sidebar width on desktop) ---- */}
      <div className={cn("flex min-h-screen flex-col transition-[padding] duration-200", collapsed ? "md:pl-[64px]" : "md:pl-[244px]")}>
        {/* Top bar */}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border/60 bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 md:px-5">
          <Button
            variant="ghost" size="icon"
            className="md:hidden h-9 w-9"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <Crumbs pathname={pathname} />
          <div className="ml-auto flex items-center gap-2">
            <div className="relative hidden lg:block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search…"
                className="h-9 w-56 rounded-md border border-border/60 bg-background pl-8 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              />
            </div>
            {user ? (
              <>
                <span className="hidden md:inline text-xs text-muted-foreground tabular-nums max-w-[180px] truncate">
                  {user.email}
                </span>
                {user.role === "admin" && (
                  <span className="hidden sm:inline text-[10px] uppercase tracking-[0.14em] bg-brand-violet-soft text-brand-violet px-2 py-1 rounded-full font-semibold">
                    Admin
                  </span>
                )}
                <Button variant="ghost" size="sm" onClick={handleLogout} className="gap-1.5">
                  <LogOut className="h-4 w-4" /><span className="hidden sm:inline">Sign out</span>
                </Button>
              </>
            ) : (
              <Button asChild variant="default" size="sm">
                <Link to="/login">Sign in</Link>
              </Button>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 px-3 py-4 md:px-6 md:py-6">{children}</main>
      </div>
    </div>
  );
}

/* ---------------- Sidebar pieces ---------------- */

function SidebarBrand({
  collapsed, appName, tagline,
}: { collapsed: boolean; appName: string; tagline: string }) {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-3 h-14 border-b border-border/60 group">
      <BrandedLogo />
      {!collapsed && (
        <div className="leading-tight min-w-0">
          <div className="font-bold text-sm tracking-tight truncate">{appName}</div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground -mt-0.5 truncate">
            {tagline}
          </div>
        </div>
      )}
    </Link>
  );
}

function SidebarGroup({
  label, collapsed, children,
}: { label: string; collapsed: boolean; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      {!collapsed && (
        <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

function SidebarItem({
  item, active, collapsed,
}: { item: NavItem; active: boolean; collapsed: boolean }) {
  return (
    <Link
      to={item.to}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
        collapsed && "justify-center px-2",
        active
          ? "bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
      )}
      title={collapsed ? item.label : undefined}
    >
      {/* Active indicator strip on the left */}
      {active && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-primary" aria-hidden />
      )}
      <span className={cn("flex h-5 w-5 items-center justify-center", active && "text-primary")}>
        {item.icon}
      </span>
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

function Crumbs({ pathname }: { pathname: string }) {
  // Build very lightweight breadcrumbs from the URL — keeps the topbar
  // contextual without a separate crumb registry per page.
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return <h1 className="text-sm font-semibold text-foreground">Dashboard</h1>;
  const pretty = (s: string) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <nav className="flex items-center gap-1.5 text-sm" aria-label="Breadcrumb">
      <Link to="/" className="text-muted-foreground hover:text-foreground">Dashboard</Link>
      {parts.map((p, i) => {
        const isLast = i === parts.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5">
            <span className="text-muted-foreground/60">/</span>
            <span className={isLast ? "font-semibold text-foreground" : "text-muted-foreground"}>
              {pretty(p)}
            </span>
          </span>
        );
      })}
    </nav>
  );
}
