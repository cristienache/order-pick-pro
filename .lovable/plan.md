

## Page builder for Ultrax

You picked all four scopes. Before laying it out, an honest note: a true Webflow-style drag-and-drop builder is **weeks of work** and would only customise the *content pages* you create — it cannot rebuild Orders, Royal Mail, Integrations, Admin, Login, etc. Those are operational pages with bespoke logic (filters, dialogs, drawers, server calls). They will keep their current structure; what we *can* change globally is their branding (logo, name, colours) and nav titles.

So the plan delivers everything in **3 phases** — every phase is shippable on its own, so you can stop after Phase 2 if Phase 3 feels like overkill.

---

### Phase 1 — Branding + Nav titles (the high-value, fast win)

A new admin-only page **`/admin/branding`** with a live preview panel.

**Editable globals**
- App name (replaces "Ultrax" in the top nav and `<title>`)
- Tagline (replaces "Order ops" under the logo)
- Logo (upload PNG/SVG, or fall back to the current `Package` icon)
- Favicon (upload .ico/.png)
- Colour palette: `primary`, `brand-violet`, `brand-emerald`, `brand-amber`, `brand-sky`, `brand-rose` — each with a colour picker that writes to the CSS variables in `src/styles.css`
- Per-nav-item titles: rename "Orders", "Royal Mail", "Integrations", "Users", "Invites", "Home"

**How it applies**
- Settings load once at app boot via a new `/api/branding` endpoint and sit in a `BrandingProvider` (same shape as `AuthProvider`).
- A tiny inline `<style>` element in `__root.tsx` writes the colour overrides as CSS custom properties — no rebuild needed, instant theme swap.
- `app-shell.tsx` reads names/logo from the provider instead of hard-coded strings.

---

### Phase 2 — Custom content pages (Contact-style pages)

Admins can create simple new pages (e.g. *About*, *Help*, *Terms*) from **`/admin/pages`**.

**Per page**
- URL slug (e.g. `/help` — validated, can't clash with existing routes)
- Page title + meta description (for SEO/og tags)
- Hero block (optional): icon, eyebrow, title, description — reuses the existing `PageHeader` component
- **Block-based body**: ordered list of blocks the admin adds. Phase 2 ships these blocks:
  - Rich text (markdown editor → rendered with `react-markdown`)
  - Image (upload, with caption + alt)
  - Two-column text
  - Call-to-action button (label + link)
  - Spacer / divider
- Toggle: show in main nav (with custom label + position) or hide (still accessible by URL)
- Toggle: require login or public

**Routing**
- One new dynamic route `src/routes/p.$slug.tsx` (URL becomes `/p/help`) — keeps a clear namespace so user pages can never collide with `/orders`, `/admin/*`, etc. (If you'd rather they live at the root `/help` instead of `/p/help`, say so and I'll switch to a splat catch-all.)

---

### Phase 3 — Drag-and-drop block builder (the heavy lift)

Upgrade the Phase 2 page editor into a visual builder for those custom pages only:
- Left rail: block library (text, image, columns, hero, CTA, gallery, accordion, video embed, spacer)
- Centre: live preview that mirrors the published page exactly
- Right rail: properties panel for the selected block (text content, alignment, colours from the brand palette, padding)
- Drag to reorder, duplicate, delete blocks
- Undo/redo, draft vs. published states

This phase only re-skins the editor for `/admin/pages`. The rendered output is the same as Phase 2, so nothing downstream breaks.

---

### Out of scope (being explicit)

- Editing the Orders, Royal Mail, Integrations, Admin, Login pages — those stay as-is structurally; only their branding (colours, logo, name, nav label) changes via Phase 1.
- Theming the email templates / PDF picklists.
- Multi-tenant / per-user themes (you chose Global).

---

### Technical notes

**Backend** (Express + SQLite, matching the existing `server/` setup):

```text
New SQLite tables (server/db.js, idempotent ALTER pattern):
  branding            single-row k/v JSON: { app_name, tagline, logo_url,
                       favicon_url, nav_labels, colors }
  pages               id, slug UNIQUE, title, meta_description, hero JSON,
                       blocks JSON, show_in_nav, nav_label, nav_position,
                       require_auth, published, updated_at, updated_by
  uploads             id, filename, mime, size, path, uploaded_by, created_at
                       (logo/favicon/page images served from server/uploads/)

New Express routes (server/index.js):
  GET  /api/branding              public
  PUT  /api/branding              admin
  POST /api/uploads               admin (multipart, limited mime + size)
  GET  /api/pages                 public list (slug + title only)
  GET  /api/pages/:slug           public (full page, gated by require_auth)
  POST /api/pages                 admin
  PUT  /api/pages/:id             admin
  DELETE /api/pages/:id           admin
```

**Frontend**:

```text
src/lib/branding-context.tsx     BrandingProvider, applies CSS vars + <title>
src/components/branded-logo.tsx  logo image or fallback icon
src/components/page-renderer.tsx renders a blocks[] array
src/routes/admin.branding.tsx    Phase 1 settings page
src/routes/admin.pages.tsx       Phase 2 page list + editor
src/routes/p.$slug.tsx           public renderer for custom pages
```

**App-shell wiring**: `app-shell.tsx` maps over a nav array built from `branding.nav_labels` + custom pages where `show_in_nav` is true.

**Color persistence**: stored as CSS-friendly strings (`oklch(...)` or hex). Writing them as `--brand-violet: <value>` overrides the defaults from `styles.css` with no rebuild.

**Route guard**: both `admin.branding.tsx` and `admin.pages.tsx` reuse the existing `RequireAuth` + `user.role === "admin"` check pattern.

**Image uploads**: stored on disk in `server/uploads/` and served at `/uploads/*` (Phase 1 only needs logo + favicon, so this is small).

---

### Suggested order of delivery

1. **Phase 1 first** (single PR, ~1 chat turn): branding settings, immediate visual win, no routing changes.
2. **Phase 2** (next turn): pages CRUD + block-based renderer with a form-based editor.
3. **Phase 3** (final turn, only if you want it): upgrade the editor to drag-and-drop with `dnd-kit`.

Reply with **"Start Phase 1"** to kick off, or tell me to reshape any part of this (e.g. drop Phase 3, change `/p/:slug` to root URLs, add specific block types).
