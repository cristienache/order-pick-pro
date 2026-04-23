

## Packeta Phase 1 — Connect & Settings

Mirror the Royal Mail integration pattern, but for Packeta. Phase 1 stops at "credentials saved + test connection works". Label generation, per-order use, and bulk actions come in later phases.

### What you'll see in the app

1. A new **Packeta** link in the top nav (next to Royal Mail), with a parcel icon.
2. A new page at `/packeta` with two cards:
   - **API password** card — paste the Packeta API password, optional sandbox toggle, "Save", "Test connection", and a status chip ("Connected" / "Not configured" / "Last test failed"). Help text links to the Packeta client section where the password is generated.
   - **Sender address** card — name, company, address, city, postcode, country (default `CZ`), phone, email. This is the "from" block printed on labels in later phases.
3. A connection status indicator on the page header so the user knows at a glance whether Packeta is wired up.

### Backend (Express + SQLite)

1. **New table** `packeta_credentials` (one row per user), same shape and encryption approach as `royal_mail_credentials`:
   - `api_password_enc` (AES-GCM), `use_sandbox` flag
   - Sender fields: `sender_name`, `sender_company`, `sender_address_line1/2`, `sender_city`, `sender_postcode`, `sender_country` (default `CZ`), `sender_phone`, `sender_email`
   - `last_tested_at`, `last_test_ok`, `last_test_message`, `updated_at`
   - Idempotent migration block (same `PRAGMA table_info` pattern already used elsewhere in `db.js`)
2. **New module** `server/packeta.js` with helpers analogous to `server/royalmail.js`:
   - `packetaBaseUrl(useSandbox)` → REST v6 base URL (production vs sandbox)
   - `normalizePacketaPassword()` — strip whitespace/quotes/zero-width chars
   - `testPacketaConnection({ apiPassword, useSandbox })` — calls a lightweight authenticated endpoint to confirm the password is valid; returns `{ ok, status, message, detail }`. Never throws.
3. **New routes** in `server/index.js`, all behind `requireAuth`:
   - `GET  /api/packeta/settings` → public-safe view (no decrypted password, just `has_api_password` flag)
   - `PUT  /api/packeta/credentials` → save/replace password + sandbox flag (`__clear__` sentinel removes it, matching Royal Mail)
   - `PUT  /api/packeta/sender` → save sender address
   - `POST /api/packeta/test-connection` → decrypt password, call Packeta, persist outcome to `last_tested_*`
4. Zod schemas mirror `rmCredsSchema` / `rmSenderSchema`.

### Frontend (TanStack Start + React)

1. **New route** `src/routes/packeta.tsx` — built from the same template as `src/routes/royal-mail.tsx`:
   - `RequireAuth` + `AppShell` wrappers
   - `PageHeader` with a parcel icon, "Shipping carrier" eyebrow, "Packeta" title
   - `CredentialsCard` (password input + sandbox switch + Save / Test buttons + status badge)
   - `SenderCard` (address form)
   - `ConnectionBadge` for Connected / Saved-not-tested / Last-test-failed / Not-configured states
2. **Nav entry** in `src/components/app-shell.tsx`: a new `<NavLink to="/packeta">` rendered under the authenticated section, using `navLabel(branding, "packeta")` so it can be relabeled in Branding admin.
3. **Branding labels** (`src/lib/branding-context.tsx`): add `packeta` default label so it shows up in the Branding admin nav-labels editor.
4. **Asset**: add `src/assets/integrations/packeta.svg` (Packeta logo) so the integrations grid can render it later.
5. **Integrations page** (`src/routes/integrations.tsx`): add a Packeta tile that links to `/packeta`, matching the existing Royal Mail tile.

### Security notes
- API password stored encrypted at rest with the same `crypto.js` AES-256-GCM helper used for WooCommerce keys and the Royal Mail key.
- Password input uses `type="password"` + autofill honeypot trick (already used in Royal Mail page).
- Test endpoint persists only the boolean outcome and a short message — never the password.

### Out of scope for this phase (queued for later)
- Creating shipments / generating label PDFs
- Reading the carrier ID and pickup point ID stored on the order by the Packeta WooCommerce plugin
- "Create label" button in the order drawer with Packeta as an option for EU orders
- Bulk Packeta label creation / merged-PDF print flow
- Tracking number sync back into WooCommerce

Once you approve, I'll switch out of plan mode and implement the above as a single batch (DB migration → server module → routes → frontend page → nav link → branding label → integrations tile).

