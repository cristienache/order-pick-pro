// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Self-hosting as a static SPA: prerender root so dist/client/index.html exists,
    // and let nginx's SPA fallback (try_files ... /index.html) handle every other route
    // client-side. No SSR runtime needed.
    prerender: {
      enabled: true,
      crawlLinks: false,
      filter: (page: { path: string }) => page.path === "/",
    },
    pages: [{ path: "/" }],
    spa: { enabled: true },
  },
});
