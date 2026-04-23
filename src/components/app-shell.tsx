import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useBranding, navLabel } from "@/lib/branding-context";
import { useSync } from "@/lib/sync-context";
import { BrandedLogo } from "@/components/branded-logo";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { PageNavItem } from "@/lib/pages";
import {
  LogOut, Package, Settings, Users, Plug, Home, Palette, FileText, Boxes,
  ClipboardList, Menu, Search, Bell, MessageCircle, Loader2, X,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  icon: ReactNode;
  exact?: boolean;
  match?: string;
  adminOnly?: boolean;
  authedOnly?: boolean;
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
  const [mobileOpen, setMobileOpen] = useState(false);

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
    // Outer mint canvas — matches the Coinest mockup background.
    <div className="min-h-screen bg-background text-foreground p-3 md:p-4">
      <div className="flex min-h-[calc(100vh-1.5rem)] md:min-h-[calc(100vh-2rem)] gap-4">
        {/* ---- Sidebar (desktop) ---- */}
        <aside className="hidden md:flex w-[240px] shrink-0 flex-col bg-sidebar text-sidebar-foreground rounded-3xl overflow-hidden">
          <SidebarBrand appName={branding.app_name} tagline={branding.tagline} />
          <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
            {groups.map((g) => (
              <SidebarGroup key={g.label} label={g.label}>
                {g.items.map((item) => (
                  <SidebarItem
                    key={item.to}
                    item={item}
                    active={isActive(item)}
                  />
                ))}
              </SidebarGroup>
            ))}
          </nav>
          {/* Promo card mimicking the Coinest "Gain full access" tile. */}
          <div className="m-3 rounded-2xl bg-primary p-4 text-primary-foreground">
            <div className="h-9 w-9 rounded-xl bg-accent/30 flex items-center justify-center mb-3">
              <Boxes className="h-4 w-4 text-accent" />
            </div>
            <div className="text-sm font-semibold leading-tight">Gain full access</div>
            <div className="text-xs opacity-80 mt-1 leading-snug">
              Connect your stores and unlock bulk editing & analytics.
            </div>
          </div>
        </aside>

        {/* ---- Mobile drawer ---- */}
        {mobileOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm md:hidden"
              onClick={() => setMobileOpen(false)}
            />
            <aside className="fixed inset-y-3 left-3 z-50 flex w-[260px] flex-col rounded-3xl bg-sidebar text-sidebar-foreground md:hidden overflow-hidden">
              <SidebarBrand appName={branding.app_name} tagline={branding.tagline} />
              <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
                {groups.map((g) => (
                  <SidebarGroup key={g.label} label={g.label}>
                    {g.items.map((item) => (
                      <SidebarItem
                        key={item.to}
                        item={item}
                        active={isActive(item)}
                      />
                    ))}
                  </SidebarGroup>
                ))}
              </nav>
            </aside>
          </>
        )}

        {/* ---- Main panel (white card) ---- */}
        <div className="flex-1 min-w-0 flex flex-col bg-card rounded-3xl overflow-hidden">
          {/* Top bar */}
          <header className="flex h-16 items-center gap-3 border-b border-border/50 px-4 md:px-6">
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
              <div className="relative hidden md:block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  placeholder="Search…"
                  className="h-10 w-64 lg:w-80 rounded-full bg-muted/70 pl-10 pr-4 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>
              <SyncPill />
              <button
                type="button"
                className="hidden sm:flex h-10 w-10 items-center justify-center rounded-full bg-muted/70 hover:bg-muted text-foreground"
                aria-label="Messages"
              >
                <MessageCircle className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="hidden sm:flex h-10 w-10 items-center justify-center rounded-full bg-muted/70 hover:bg-muted text-foreground"
                aria-label="Notifications"
              >
                <Bell className="h-4 w-4" />
              </button>
              {user ? (
                <div className="flex items-center gap-3 pl-2">
                  <div className="hidden md:flex flex-col items-end leading-tight">
                    <span className="text-sm font-semibold text-foreground max-w-[180px] truncate">
                      {user.email.split("@")[0]}
                    </span>
                    <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      {user.role === "admin" ? "Admin" : "Member"}
                    </span>
                  </div>
                  <div className="h-10 w-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-semibold">
                    {user.email.slice(0, 1).toUpperCase()}
                  </div>
                  <Button variant="ghost" size="icon" onClick={handleLogout} aria-label="Sign out" className="h-9 w-9">
                    <LogOut className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <Button asChild variant="default" size="sm" className="rounded-full">
                  <Link to="/login">Sign in</Link>
                </Button>
              )}
            </div>
          </header>

          {/* Content */}
          <main className="flex-1 overflow-y-auto px-4 py-5 md:px-6 md:py-6">{children}</main>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Sidebar pieces ---------------- */

function SidebarBrand({ appName, tagline }: { appName: string; tagline: string }) {
  return (
    <Link to="/" className="flex items-center gap-3 px-5 h-16 group">
      <BrandedLogo />
      <div className="leading-tight min-w-0">
        <div className="font-bold text-base tracking-tight truncate uppercase">{appName}</div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground -mt-0.5 truncate">
          {tagline}
        </div>
      </div>
    </Link>
  );
}

function SidebarGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
        {label}
      </div>
      {children}
    </div>
  );
}

function SidebarItem({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.to}
      className={cn(
        "group relative flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-sm font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground",
      )}
    >
      <span className={cn("flex h-5 w-5 items-center justify-center", active ? "text-primary-foreground" : "text-sidebar-foreground/70")}>
        {item.icon}
      </span>
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/* ---------------- Sync indicator ---------------- */

function SyncPill() {
  // Sticky topbar pill — shows live progress of any background WC sync.
  // Stays mounted across route changes because AppShell wraps every route.
  const { current, cancel } = useSync();
  if (!current) return null;
  const label = current.totalPages
    ? `Sync ${current.page}/${current.totalPages}`
    : `Sync · page ${current.page || 1}`;
  return (
    <div className="hidden md:flex items-center gap-2 h-10 rounded-full bg-accent/30 text-accent-foreground pl-3 pr-1.5 text-xs font-medium border border-accent/40">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span className="tabular-nums">{label}</span>
      <span className="text-muted-foreground tabular-nums">· {current.created + current.updated} items</span>
      {!current.done && (
        <button
          type="button"
          onClick={cancel}
          className="ml-1 h-7 w-7 rounded-full hover:bg-background/70 flex items-center justify-center"
          aria-label="Stop sync"
          title="Stop after current page"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function Crumbs({ pathname }: { pathname: string }) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return <h1 className="text-base font-semibold text-foreground">Dashboard</h1>;
  const pretty = (s: string) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const last = pretty(parts[parts.length - 1]);
  return (
    <div className="flex flex-col leading-tight">
      <h1 className="text-base font-semibold text-foreground">{last}</h1>
      <nav className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link to="/" className="hover:text-foreground">Dashboard</Link>
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-muted-foreground/60">/</span>
            <span className={i === parts.length - 1 ? "text-foreground" : ""}>{pretty(p)}</span>
          </span>
        ))}
      </nav>
    </div>
  );
}
