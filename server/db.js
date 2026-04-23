import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPathSetting = process.env.DB_PATH || "./data/ultrax.db";
const DB_PATH = isAbsolute(dbPathSetting)
  ? dbPathSetting
  : resolve(__dirname, dbPathSetting);
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE,
    token TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    invited_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    store_url TEXT NOT NULL,
    consumer_key_enc TEXT NOT NULL,
    consumer_secret_enc TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);
  CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);

  -- Saved filter presets (per user, per site)
  CREATE TABLE IF NOT EXISTS filter_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    payload TEXT NOT NULL, -- JSON: { statuses, datePreset, customFrom, customTo, search, sortOrder, highValueThreshold, computeRepeat }
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, site_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_presets_user_site ON filter_presets(user_id, site_id);

  -- Royal Mail OBA credentials + sender address (one row per user).
  -- Credentials are encrypted at rest with the same AES-256-GCM helper used
  -- for WooCommerce keys. Sender fields are stored in plain text.
  CREATE TABLE IF NOT EXISTS royal_mail_credentials (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- Click & Drop API key (single bearer token). Encrypted at rest.
    -- The legacy client_id_enc / client_secret_enc columns from the original
    -- Shipping API v3 design remain in ALTER TABLE migrations below for
    -- backwards compatibility but are no longer read or written.
    api_key_enc TEXT,
    client_id_enc TEXT,
    client_secret_enc TEXT,
    -- Optional: flag a sandbox key vs a production key. Defaults to 0 (prod).
    use_sandbox INTEGER NOT NULL DEFAULT 0,
    -- Sender address printed on the label
    sender_name TEXT,
    sender_company TEXT,
    sender_address_line1 TEXT,
    sender_address_line2 TEXT,
    sender_city TEXT,
    sender_postcode TEXT,
    sender_country TEXT NOT NULL DEFAULT 'GB',
    sender_phone TEXT,
    sender_email TEXT,
    -- Last successful "Test Connection" result so the UI can show status
    last_tested_at TEXT,
    last_test_ok INTEGER,
    last_test_message TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 1 stub for shipments. Columns will be populated in Phase 2.
  -- Created now so foreign-key wiring and history queries don't need a
  -- second migration later.
  CREATE TABLE IF NOT EXISTS shipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    woocommerce_order_id INTEGER NOT NULL,
    woocommerce_store_url TEXT,
    royal_mail_shipment_id TEXT,
    tracking_number TEXT,
    service_code TEXT,
    label_pdf_base64 TEXT,
    manifested INTEGER NOT NULL DEFAULT 0,
    manifest_id TEXT,
    voided INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_shipments_user ON shipments(user_id);
  CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(user_id, woocommerce_order_id);
`);

// ---- Idempotent schema migrations ----
// Add return-address columns to existing `sites` rows. SQLite doesn't support
// "ADD COLUMN IF NOT EXISTS", so we introspect first and only ALTER for
// columns that are missing. Safe to run on every boot.
const sitesCols = new Set(
  db.prepare("PRAGMA table_info(sites)").all().map((c) => c.name),
);
const RETURN_COLS = [
  "return_name",
  "return_company",
  "return_line1",
  "return_line2",
  "return_city",
  "return_postcode",
  "return_country",
];
for (const col of RETURN_COLS) {
  if (!sitesCols.has(col)) {
    db.exec(`ALTER TABLE sites ADD COLUMN ${col} TEXT`);
  }
}

// Add api_key_enc to royal_mail_credentials for older databases that were
// created before the Click & Drop migration.
const rmCols = new Set(
  db.prepare("PRAGMA table_info(royal_mail_credentials)").all().map((c) => c.name),
);
if (!rmCols.has("api_key_enc")) {
  db.exec(`ALTER TABLE royal_mail_credentials ADD COLUMN api_key_enc TEXT`);
}

// Add printed_at to shipments (Phase 3 — track when a label PDF was actually
// sent to the printer, vs just generated by Click & Drop). Powers the
// "Printed" badge on the orders list and the bulk "Print unprinted" action.
const shipmentCols = new Set(
  db.prepare("PRAGMA table_info(shipments)").all().map((c) => c.name),
);
if (!shipmentCols.has("printed_at")) {
  db.exec(`ALTER TABLE shipments ADD COLUMN printed_at TEXT`);
}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_shipments_printed
   ON shipments(user_id, printed_at)`,
);

// ---- eBay accounts (per user, OAuth 2.0) ----
// Each row is one connected eBay seller account. Tokens are encrypted at rest
// with the same AES-256-GCM helper used for WooCommerce keys.
//   - refresh_token_enc: long-lived (~18 months), used to mint access tokens.
//   - access_token_enc + access_token_expires_at: short-lived (~2 hours),
//     refreshed lazily by server/ebay.js whenever they're within 60s of expiry.
//   - ebay_user_id: the seller's eBay username, captured during OAuth so the
//     user can tell two connected accounts apart.
//   - return_*: same shape as sites.return_* — used when generating shipping
//     labels for an eBay order. Optional at save time.
db.exec(`
  CREATE TABLE IF NOT EXISTS ebay_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    ebay_user_id TEXT,
    refresh_token_enc TEXT NOT NULL,
    refresh_token_expires_at TEXT,
    access_token_enc TEXT,
    access_token_expires_at TEXT,
    scopes TEXT,
    return_name TEXT,
    return_company TEXT,
    return_line1 TEXT,
    return_line2 TEXT,
    return_city TEXT,
    return_postcode TEXT,
    return_country TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ebay_accounts_user ON ebay_accounts(user_id);

  -- Short-lived OAuth state tokens. The state value is signed into the
  -- redirect URL when we send the user to eBay; eBay echoes it back on the
  -- callback so we can prove the response is for *this* user's flow and pick
  -- the right account name to save.
  CREATE TABLE IF NOT EXISTS ebay_oauth_states (
    state TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ebay_states_user ON ebay_oauth_states(user_id);

  -- Global app branding. Single row (id=1). Stores app name, tagline, logo
  -- and favicon as data URLs (kept small enough to live in SQLite — admin
  -- form enforces ~256KB ceiling), per-nav-item label overrides as JSON,
  -- and a colour palette as JSON (CSS variable name -> string value).
  CREATE TABLE IF NOT EXISTS branding (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    app_name TEXT NOT NULL DEFAULT 'Ultrax',
    tagline TEXT NOT NULL DEFAULT 'Order ops',
    logo_data_url TEXT,
    favicon_data_url TEXT,
    nav_labels TEXT NOT NULL DEFAULT '{}',
    colors TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  INSERT OR IGNORE INTO branding (id) VALUES (1);

  -- Phase 2 of the page builder. Custom content pages, addressed by slug at
  -- /p/<slug>. The blocks column is a JSON array; each block has
  -- { id, type, props }. The renderer in src/components/page-renderer.tsx
  -- whitelists which type values it knows how to render, so unknown blocks
  -- are dropped silently. Pages are admin-managed only; published gates
  -- whether non-admins can view the page (admins can always preview drafts).
  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
    title TEXT NOT NULL,
    description TEXT,
    blocks TEXT NOT NULL DEFAULT '[]',
    published INTEGER NOT NULL DEFAULT 0,
    show_in_nav INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pages_published ON pages(published);

  -- Packeta credentials + sender address (one row per user). Mirrors the
  -- royal_mail_credentials shape. The API password is encrypted at rest with
  -- the same AES-256-GCM helper used for WooCommerce keys. Sender fields
  -- are stored in plain text so the UI can display them.
  CREATE TABLE IF NOT EXISTS packeta_credentials (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    api_password_enc TEXT,
    use_sandbox INTEGER NOT NULL DEFAULT 0,
    -- Sender block printed on labels (Phase 2+).
    sender_name TEXT,
    sender_company TEXT,
    sender_address_line1 TEXT,
    sender_address_line2 TEXT,
    sender_city TEXT,
    sender_postcode TEXT,
    sender_country TEXT NOT NULL DEFAULT 'CZ',
    sender_phone TEXT,
    sender_email TEXT,
    -- Last "Test connection" outcome so the UI can show a status chip.
    last_tested_at TEXT,
    last_test_ok INTEGER,
    last_test_message TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
