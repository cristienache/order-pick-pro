import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useBranding } from "@/lib/branding-context";
import { BrandedLogo } from "@/components/branded-logo";
import { PageRenderer } from "@/components/page-renderer";
import type { Page } from "@/lib/pages";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/p/$slug")({
  component: PublicPageRoute,
  head: () => ({
    meta: [
      { title: "Page — Ultrax" },
    ],
  }),
});

function PublicPageRoute() {
  const { slug } = Route.useParams();
  const { user } = useAuth();
  const { branding } = useBranding();
  const router = useRouter();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ page: Page }>(`/api/pages/by-slug/${encodeURIComponent(slug)}`)
      .then((r) => { if (!cancelled) setPage(r.page); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug]);

  // Keep the document title aligned with the page title once it loads.
  useEffect(() => {
    if (page && typeof document !== "undefined") {
      document.title = `${page.title} — ${branding.app_name}`;
    }
  }, [page, branding.app_name]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandedLogo />
            <div className="font-bold text-base tracking-tight">{branding.app_name}</div>
          </Link>
          <div className="flex items-center gap-3 text-sm">
            {user ? (
              <Link to="/" className="text-muted-foreground hover:text-foreground transition">
                Dashboard
              </Link>
            ) : (
              <Link to="/login" className="text-muted-foreground hover:text-foreground transition">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12 md:py-16">
        {loading && (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}
        {!loading && error && (
          <div className="text-center py-20 space-y-3">
            <h1 className="text-3xl font-bold">Page not found</h1>
            <p className="text-muted-foreground">
              The page <code className="text-xs">/p/{slug}</code> doesn't exist or hasn't been published.
            </p>
            <button
              onClick={() => router.navigate({ to: "/" })}
              className="text-sm text-primary hover:underline"
            >
              Go home
            </button>
          </div>
        )}
        {!loading && !error && page && (
          <article className="space-y-8">
            {!page.published && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                Draft preview — only admins can see this page until it is published.
              </div>
            )}
            <header className="space-y-3">
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight">{page.title}</h1>
              {page.description && (
                <p className="text-lg text-muted-foreground leading-relaxed">{page.description}</p>
              )}
            </header>
            <PageRenderer blocks={page.blocks} />
          </article>
        )}
      </main>
    </div>
  );
}
