import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/ultrax.db";
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
