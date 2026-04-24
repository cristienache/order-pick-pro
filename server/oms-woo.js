// HeyShop Inventory ↔ WooCommerce bridge.
//
// Mounted from server/index.js with:
//   import { mountOmsWoo } from "./oms-woo.js";
//   mountOmsWoo(app, { requireAuth });
//
// Endpoints (all under /api/oms/woo):
//   GET    /sites                          → list the user's WC sites with sync status
//   POST   /sync/:siteId                   → pull all WC products + stock into oms_*
//   PATCH  /products/bulk                  → save edits LOCALLY (no WC push)
//   POST   /backups                        → snapshot the current WC state of given products
//   GET    /backups                        → list snapshots for the user
//   POST   /backups/:id/restore            → re-push a snapshot to WC
//   POST   /push                           → push given product changes from oms → WC
//
// Auth is the same JWT used by every other /api endpoint. WC credentials live
// per-user in the existing `sites` table (consumer_key/secret, encrypted).

import crypto from "node:crypto";
import { db } from "./db.js";
import { decrypt } from "./crypto.js";

/* ---------------- Schema migrations (idempotent) ---------------- */

// Extra WC fields on oms_products. SQLite has no "ADD COLUMN IF NOT EXISTS",
// so introspect first.
const productCols = new Set(
  db.prepare("PRAGMA table_info(oms_products)").all().map((c) => c.name),
);
const PRODUCT_EXTRA_COLS = [
  ["site_id", "INTEGER"],
  ["description", "TEXT"],
  ["short_description", "TEXT"],
  ["regular_price", "REAL"],
  ["sale_price", "REAL"],
  ["stock_status", "TEXT"],
  ["manage_stock", "INTEGER NOT NULL DEFAULT 0"],
  ["weight", "REAL"],
  ["dirty", "INTEGER NOT NULL DEFAULT 0"],
  ["last_synced_at", "TEXT"],
  // JSON array of field names the user has changed since the last sync.
  // Drives the WC push to send ONLY user-touched fields, so we never
  // overwrite WC values we don't have locally (e.g. real sale_price).
  ["dirty_fields", "TEXT"],
  // Small thumbnail URL pulled from the WC product images[0].src — used in
  // the inventory grid so the user can recognise rows at a glance.
  ["image_url", "TEXT"],
  // Variable-product support. A "variable" parent is the umbrella row that
  // carries the catalogue copy (name, description, image). Each "variation"
  // is a sellable child with its own SKU, prices, weight and stock. The
  // parent links to its WC product id; the variation also stores the WC
  // parent product id so we can target /products/{parent}/variations/{id}
  // when pushing.
  ["wc_type", "TEXT NOT NULL DEFAULT 'simple'"],   // simple | variable | variation
  ["parent_product_id", "TEXT"],                   // oms_products.id of the variable parent
  ["wc_parent_id", "INTEGER"],                     // WC parent product id (for variations)
  ["variation_label", "TEXT"],                     // e.g. "Red / Large" — derived from attributes
  // WC creation timestamps — used to power "newest / oldest" sorts in the
  // inventory grid. Stored as ISO 8601 strings (UTC).
  ["wc_date_created", "TEXT"],
  ["wc_date_modified", "TEXT"],
];
for (const [col, type] of PRODUCT_EXTRA_COLS) {
  if (!productCols.has(col)) db.exec(`ALTER TABLE oms_products ADD COLUMN ${col} ${type}`);
}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_oms_products_site ON oms_products(site_id)`,
);
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_oms_products_woo ON oms_products(site_id, woo_product_id)`,
);

// JSON snapshots of WC product state, captured before a push so the user can
// restore. Snapshot payload mirrors the WC product object subset we care about.
db.exec(`
  CREATE TABLE IF NOT EXISTS oms_wc_backups (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    label TEXT,
    product_count INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,        -- JSON: WcProductSnapshot[]
    restored_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_oms_backups_user ON oms_wc_backups(user_id, created_at DESC);
`);

/* ---------------- Helpers ---------------- */

function authHeader(key, secret) {
  return "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
}
function normalizeUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

/** Look up a site row owned by the user. Returns the decrypted credentials or
 *  throws an Error with `.status` set so the caller can return a clean error. */
function getSiteForUser(userId, siteId) {
  const row = db.prepare(
    "SELECT * FROM sites WHERE id = ? AND user_id = ?",
  ).get(Number(siteId), userId);
  if (!row) {
    const e = new Error("Site not found"); e.status = 404; throw e;
  }
  let consumer_key, consumer_secret;
  try {
    consumer_key = decrypt(row.consumer_key_enc);
    consumer_secret = decrypt(row.consumer_secret_enc);
  } catch {
    const e = new Error("Failed to decrypt site credentials"); e.status = 500; throw e;
  }
  return { id: row.id, name: row.name, store_url: row.store_url, consumer_key, consumer_secret };
}

/** Mirror warehouse for a WC site. Auto-create on first sync. The id is
 *  deterministic per site so re-syncs reuse it. The warehouse is owned by
 *  the same user who owns the site, so per-user inventory scoping works. */
function ensureMirrorWarehouse(site, userId) {
  const code = `WC-${site.id}`;
  const row = db.prepare("SELECT id, user_id FROM oms_warehouses WHERE code = ?").get(code);
  if (row) {
    // Backfill user_id on legacy mirror warehouses created before per-user scoping.
    if (!row.user_id && userId) {
      db.prepare("UPDATE oms_warehouses SET user_id = ? WHERE id = ?").run(userId, row.id);
    }
    return row.id;
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO oms_warehouses
       (id, user_id, name, code, address, lat, lng, capacity_units, is_active)
     VALUES (?, ?, ?, ?, NULL, 0, 0, 0, 1)`,
  ).run(id, userId ?? null, `${site.name} (WC mirror)`, code);
  return id;
}

/** Trim a WC product object to the snapshot shape we restore later. */
function snapshotShape(p) {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    regular_price: p.regular_price,
    sale_price: p.sale_price,
    description: p.description,
    short_description: p.short_description,
    stock_quantity: p.stock_quantity,
    stock_status: p.stock_status,
    manage_stock: !!p.manage_stock,
    weight: p.weight,
  };
}

/** PUT one WC product (or variation). Returns the updated WC payload.
 *  When `parentId` is provided, targets /products/{parent}/variations/{wcId}
 *  instead of /products/{wcId}. */
async function pushOneToWc(site, wcId, body, parentId = null) {
  const base = `${normalizeUrl(site.store_url)}/wp-json/wc/v3/products`;
  const url = parentId ? `${base}/${parentId}/variations/${wcId}` : `${base}/${wcId}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: authHeader(site.consumer_key, site.consumer_secret),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    // WC errors look like {"code":"product_invalid_sku","message":"...","data":{...}}.
    // Surface the human message when present so the UI toast is useful.
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      if (j && (j.message || j.code)) msg = `${j.code || "wc_error"}: ${j.message || ""}`.trim();
    } catch { /* leave raw */ }
    console.error(`[oms-woo] push ${wcId} failed (${res.status}):`, msg, "body:", JSON.stringify(body));
    throw new Error(`WC ${res.status}: ${msg}`);
  }
  try { return JSON.parse(text); } catch { return null; }
}

/** GET one WC product (or variation) — used for snapshots. */
async function fetchOneFromWc(site, wcId, parentId = null) {
  const base = `${normalizeUrl(site.store_url)}/wp-json/wc/v3/products`;
  const url = parentId ? `${base}/${parentId}/variations/${wcId}` : `${base}/${wcId}`;
  const res = await fetch(url, {
    headers: {
      Authorization: authHeader(site.consumer_key, site.consumer_secret),
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`WC ${res.status}`);
  return res.json();
}

/** Fetch all variations for a variable parent (paginated). Throws on hard
 *  errors so the sync caller can surface them — silent failures here were
 *  previously hiding "not authorized" or 5xx and leaving variable parents
 *  un-editable in the grid. */
async function fetchAllVariations(site, parentId) {
  const base = `${normalizeUrl(site.store_url)}/wp-json/wc/v3/products/${parentId}/variations`;
  const perPage = 100;
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const url = `${base}?per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Authorization: authHeader(site.consumer_key, site.consumer_secret),
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      if (page === 1) {
        const text = await res.text().catch(() => "");
        throw new Error(`WC ${res.status}: ${text.slice(0, 200)}`);
      }
      break;
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < perPage) break;
  }
  return all;
}

const incrementalCandidateCache = new Map();

async function fetchWcProducts(site, query) {
  const url = `${normalizeUrl(site.store_url)}/wp-json/wc/v3/products?${query}`;
  const res = await fetch(url, {
    headers: {
      Authorization: authHeader(site.consumer_key, site.consumer_secret),
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WC ${res.status}: ${text.slice(0, 300)}`);
  }
  const items = await res.json();
  return {
    items: Array.isArray(items) ? items : [],
    total: Number(res.headers.get("x-wp-total")) || 0,
    totalPages: Number(res.headers.get("x-wp-totalpages")) || 0,
  };
}

function wcProductTimestamp(wc) {
  return wc?.date_modified_gmt || wc?.date_modified || wc?.date_created_gmt || wc?.date_created || null;
}

function wcProductCreatedTimestamp(wc) {
  return wc?.date_created_gmt || wc?.date_created || wcProductTimestamp(wc);
}

function cursorWithOverlap(ts, minutes = 2) {
  const parsed = Date.parse(ts || "");
  if (!Number.isFinite(parsed)) return new Date(Date.now() - minutes * 60 * 1000).toISOString();
  return new Date(parsed - minutes * 60 * 1000).toISOString();
}

function wcProductSortValue(wc) {
  const ts = Date.parse(wcProductTimestamp(wc) || "");
  return Number.isFinite(ts) ? ts : 0;
}

async function listIncrementalCandidates(site, since) {
  const now = Date.now();
  for (const [key, value] of incrementalCandidateCache) {
    if (!value || value.expiresAt <= now) incrementalCandidateCache.delete(key);
  }

  const cacheKey = `${site.id}:${since}`;
  const cached = incrementalCandidateCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.items;

  const merged = new Map();
  const summaryFields = encodeURIComponent("id,date_created,date_created_gmt,date_modified,date_modified_gmt");
  const sources = [
    `orderby=date&order=asc&after=${encodeURIComponent(since)}&dates_are_gmt=true`,
  ];

  for (const source of sources) {
    for (let page = 1; page <= 200; page += 1) {
      const { items } = await fetchWcProducts(
        site,
        `per_page=100&page=${page}&_fields=${summaryFields}&${source}`,
      );
      if (items.length === 0) break;
      for (const item of items) {
        const id = Number(item?.id);
        if (!Number.isFinite(id)) continue;
        const sortTs = wcProductSortValue(item);
        const prev = merged.get(id);
        if (!prev || sortTs >= prev.sortTs) merged.set(id, { id, sortTs });
      }
      if (items.length < 100) break;
    }
  }

  const ordered = [...merged.values()].sort((a, b) => a.sortTs - b.sortTs || a.id - b.id);
  incrementalCandidateCache.set(cacheKey, {
    expiresAt: now + 10 * 60 * 1000,
    items: ordered,
  });
  return ordered;
}

async function fetchProductsByIds(site, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const include = ids.map((id) => String(id)).join(",");
  const { items } = await fetchWcProducts(site, `include=${include}&per_page=${ids.length}`);
  const order = new Map(ids.map((id, index) => [Number(id), index]));
  return items.sort((a, b) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b.id)) ?? 0));
}

/** Pull a small thumbnail URL out of a WC product/variation. */
function pickThumb(wc) {
  if (Array.isArray(wc.images) && wc.images.length > 0) {
    return wc.images[0].src || null;
  }
  if (wc.image && wc.image.src) return wc.image.src;
  return null;
}

/** Build "Red / Large"-style label from variation attribute objects. */
function variationLabel(attrs) {
  if (!Array.isArray(attrs)) return null;
  return attrs.map((a) => a.option || a.value).filter(Boolean).join(" / ") || null;
}

/** Coerce a WC numeric string ("19.99") → number, blank → null. */
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Upsert a single WC product or variation into oms_products + oms_inventory.
 * Returns { id, created } where `created` is true on insert, false on update.
 * `wcType` is one of "simple" | "variable" | "variation".
 */
function upsertWcProduct({
  site, warehouseId, wc, nowIso, wcType,
  parentOmsId = null, wcParentId = null, fallbackName = null,
}) {
  const isVariation = wcType === "variation";
  const baseSku = wc.sku && wc.sku.trim() ? wc.sku.trim() : `WC-${site.id}-${wc.id}`;
  const stockQty = Number.isFinite(Number(wc.stock_quantity))
    ? Number(wc.stock_quantity) : 0;
  const thumb = pickThumb(wc);
  const label = isVariation ? variationLabel(wc.attributes) : null;
  const displayName = isVariation
    ? `${fallbackName || baseSku}${label ? ` — ${label}` : ""}`
    : (wc.name || baseSku);

  // Match on (site, woo_product_id, wc_type, wc_parent_id) so a variation
  // and its parent (which can share a WC id space across product types) are
  // treated as distinct rows.
  const existing = db.prepare(
    `SELECT id FROM oms_products
       WHERE site_id = ? AND woo_product_id = ?
         AND COALESCE(wc_type,'simple') = ?
         AND COALESCE(wc_parent_id, 0) = COALESCE(?, 0)`,
  ).get(site.id, wc.id, wcType, wcParentId);

  let productId = existing?.id || crypto.randomUUID();
  let created = false;

  // SKUs are UNIQUE in oms_products across the whole table. WC sites can
  // legitimately reuse the same SKU on different stores (or a manual OMS
  // product can collide with a freshly-imported WC SKU), so on every
  // upsert we resolve `baseSku` to a unique value, EXCLUDING the row we're
  // about to update. This prevents "UNIQUE constraint failed: oms_products.sku"
  // on both INSERT and UPDATE paths.
  const skuTaken = db.prepare(
    "SELECT 1 FROM oms_products WHERE sku = ? AND id != ?",
  );
  let finalSku = baseSku;
  if (skuTaken.get(finalSku, productId)) {
    let i = 1;
    finalSku = `${baseSku}-WC${site.id}-${i}`;
    while (skuTaken.get(finalSku, productId)) {
      i++;
      finalSku = `${baseSku}-WC${site.id}-${i}`;
      if (i > 50) {
        // Final fallback: append the WC product id (always unique per site).
        finalSku = `${baseSku}-WC${site.id}-${wc.id}`;
        break;
      }
    }
  }

  if (existing) {
    db.prepare(
      `UPDATE oms_products
         SET sku = ?, name = ?, base_price = ?, regular_price = ?, sale_price = ?,
             description = ?, short_description = ?, stock_status = ?,
             manage_stock = ?, weight = ?, image_url = ?, wc_type = ?,
             parent_product_id = ?, wc_parent_id = ?, variation_label = ?,
             wc_date_created = ?, wc_date_modified = ?,
             dirty = 0, dirty_fields = NULL, last_synced_at = ?
       WHERE id = ?`,
    ).run(
      finalSku, displayName,
      num(wc.price) ?? num(wc.regular_price) ?? 0,
      num(wc.regular_price), num(wc.sale_price),
      wc.description ?? null, wc.short_description ?? null,
      wc.stock_status ?? "instock",
      wc.manage_stock ? 1 : 0,
      num(wc.weight),
      thumb, wcType, parentOmsId, wcParentId, label,
      wc.date_created_gmt || wc.date_created || null,
      wc.date_modified_gmt || wc.date_modified || null,
      nowIso,
      productId,
    );
  } else {
    db.prepare(
      `INSERT INTO oms_products
         (id, sku, name, source, base_price, woo_product_id, site_id,
          description, short_description, regular_price, sale_price,
          stock_status, manage_stock, weight, image_url, wc_type,
          parent_product_id, wc_parent_id, variation_label,
          wc_date_created, wc_date_modified,
          dirty, last_synced_at)
       VALUES (?, ?, ?, 'woo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      productId, finalSku, displayName,
      num(wc.price) ?? num(wc.regular_price) ?? 0,
      wc.id, site.id,
      wc.description ?? null, wc.short_description ?? null,
      num(wc.regular_price), num(wc.sale_price),
      wc.stock_status ?? "instock",
      wc.manage_stock ? 1 : 0,
      num(wc.weight),
      thumb, wcType, parentOmsId, wcParentId, label,
      wc.date_created_gmt || wc.date_created || null,
      wc.date_modified_gmt || wc.date_modified || null,
      nowIso,
    );
    created = true;
  }

  // Inventory mirror — variable parents themselves don't carry stock, only
  // their variations do. Skip inventory for variable parents so totals
  // aren't double-counted.
  if (wcType !== "variable") {
    const invRow = db.prepare(
      `SELECT version FROM oms_inventory WHERE product_id = ? AND warehouse_id = ?`,
    ).get(productId, warehouseId);
    if (invRow) {
      db.prepare(
        `UPDATE oms_inventory SET quantity = ?, version = version + 1
          WHERE product_id = ? AND warehouse_id = ?`,
      ).run(stockQty, productId, warehouseId);
    } else {
      db.prepare(
        `INSERT INTO oms_inventory
           (product_id, warehouse_id, quantity, reserved, reorder_level, version)
         VALUES (?, ?, ?, 0, 0, 1)`,
      ).run(productId, warehouseId, stockQty);
    }
  }

  return { id: productId, created };
}

/* ---------------- Mount ---------------- */

export function mountOmsWoo(app, { requireAuth }) {
  const r = "/api/oms/woo";

  // ----- List user's sites + last sync info -----
  app.get(`${r}/sites`, requireAuth, (req, res) => {
    const sites = db.prepare(
      `SELECT id, name, store_url, created_at FROM sites WHERE user_id = ? ORDER BY name`,
    ).all(req.user.id);
    const stats = sites.map((s) => {
      const code = `WC-${s.id}`;
      const wh = db.prepare("SELECT id FROM oms_warehouses WHERE code = ?").get(code);
      const lastSync = db.prepare(
        `SELECT COALESCE(wc_sync_cursor, wc_full_sync_cursor) AS ts FROM sites WHERE id = ?`,
      ).get(s.id);
      const dirty = db.prepare(
        `SELECT COUNT(*) AS c FROM oms_products WHERE site_id = ? AND dirty = 1`,
      ).get(s.id);
      const total = db.prepare(
        `SELECT COUNT(*) AS c FROM oms_products WHERE site_id = ?`,
      ).get(s.id);
      return {
        ...s,
        warehouse_id: wh?.id ?? null,
        last_synced_at: lastSync?.ts ?? null,
        product_count: total?.c ?? 0,
        dirty_count: dirty?.c ?? 0,
      };
    });
    res.json(stats);
  });

  // ----- List WC products for a site (with all extra columns the editor needs) -----
  // Returns parents + variations sorted so variations come right after their
  // parent. Excludes variable PARENTS' stock (parents have no stock of their
  // own; only variations carry quantity).
  app.get(`${r}/products`, requireAuth, (req, res) => {
    const siteId = Number(req.query.site_id);
    if (!Number.isInteger(siteId)) {
      return res.status(422).json({ error: "site_id required" });
    }
    let site;
    try { site = getSiteForUser(req.user.id, siteId); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    const warehouseId = ensureMirrorWarehouse(site, req.user.id);
    const rows = db.prepare(
      `SELECT p.id, p.sku, p.name, p.source, p.base_price, p.woo_product_id,
              p.site_id, p.description, p.short_description, p.regular_price,
              p.sale_price, p.stock_status, p.manage_stock, p.weight,
              p.image_url, p.wc_type, p.parent_product_id, p.wc_parent_id,
              p.variation_label, p.wc_date_created, p.wc_date_modified,
              p.dirty, p.dirty_fields, p.last_synced_at,
              COALESCE((SELECT quantity FROM oms_inventory
                          WHERE product_id = p.id AND warehouse_id = ?), 0) AS stock_quantity,
              COALESCE((SELECT version FROM oms_inventory
                          WHERE product_id = p.id AND warehouse_id = ?), 1) AS inventory_version
         FROM oms_products p
        WHERE p.site_id = ?
        ORDER BY COALESCE(p.parent_product_id, p.id), p.wc_type DESC, p.name ASC`,
    ).all(warehouseId, warehouseId, site.id);
    res.json(rows.map((r) => ({
      ...r,
      manage_stock: !!r.manage_stock,
      dirty: !!r.dirty,
    })));
  });

  // ----- Sync a site's WC catalog into oms_products -----
  // Incremental by default: only fetches products CREATED since the last full
  // sync. This keeps the default button cheap and predictable for large stores:
  // if 10 new products were added since the last full baseline, only those 10
  // are imported instead of walking the whole catalog again.
  //
  // Force a full re-import with `?full=1` (used after a wipe, or for
  // recovery if the local mirror is suspected stale).
  //
  // The "since" cursor is captured on page 1 and threaded through the
  // multi-page client loop via `?since=<iso>` so all pages of one logical
  // sync see the same window — even if products are modified mid-sync.
  app.post(`${r}/sync/:siteId`, requireAuth, async (req, res) => {
    let site;
    try { site = getSiteForUser(req.user.id, req.params.siteId); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

    const warehouseId = ensureMirrorWarehouse(site, req.user.id);
    const base = normalizeUrl(site.store_url);
    const page = Math.max(1, Number(req.query.page) || Number(req.body?.page) || 1);
    const perPage = Math.min(100, Math.max(10, Number(req.query.per_page) || 50));
    const forceFull = req.query.full === "1" || req.body?.full === true;
    let created = 0, updated = 0;
    const errors = [];

    // Resolve the sync cursor.
    //  - Incremental runs use the last SUCCESSFUL FULL sync as their baseline.
    //  - Full runs clear the baseline for this request and replace it on finish.
    //  - Page > 1 trusts the carried `since` / `cursor` values for stability.
    let since = "";
    let cursor = String(req.query.cursor || req.body?.cursor || "");
    if (page > 1) {
      since = String(req.query.since || req.body?.since || "");
    } else if (!forceFull) {
      const prev = db.prepare(
        `SELECT COALESCE(wc_sync_cursor, wc_full_sync_cursor) AS ts FROM sites WHERE id = ?`,
      ).get(site.id);
      if (prev?.ts) {
        since = String(prev.ts);
      }
      cursor = prev?.ts ? String(prev.ts) : "";
    }

    try {
      let batch = [];
      let totalProducts = null;
      let totalPages = null;

      if (since) {
        const candidates = await listIncrementalCandidates(site, since);
        const unseenIds = new Set(
          db.prepare(
            `SELECT woo_product_id
               FROM oms_products
              WHERE site_id = ?
                AND woo_product_id IS NOT NULL
                AND COALESCE(wc_parent_id, 0) = 0`,
          ).all(site.id).map((row) => Number(row.woo_product_id)),
        );
        const newCandidates = candidates.filter((item) => !unseenIds.has(Number(item.id)));
        totalProducts = newCandidates.length;
        totalPages = newCandidates.length ? Math.ceil(newCandidates.length / perPage) : 0;
        const slice = newCandidates.slice((page - 1) * perPage, page * perPage).map((item) => item.id);
        batch = await fetchProductsByIds(site, slice);
      } else {
        const full = await fetchWcProducts(site, `per_page=${perPage}&page=${page}&orderby=id&order=asc`);
        batch = full.items;
        totalProducts = full.total || null;
        totalPages = full.totalPages || null;
      }
      const nowIso = new Date().toISOString();

      const cursorSource = batch.reduce((latest, item) => {
        const ts = forceFull ? wcProductTimestamp(item) : wcProductCreatedTimestamp(item);
        if (!ts) return latest;
        if (!latest) return ts;
        return Date.parse(ts) > Date.parse(latest) ? ts : latest;
      }, cursor || since || "");
      const nextCursor = cursorSource || cursor || since;
      const completedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const done = totalPages != null ? page >= totalPages : batch.length < perPage;

      if (!Array.isArray(batch) || batch.length === 0) {
        if (done) {
          if (forceFull) {
            db.prepare(`UPDATE sites SET wc_sync_cursor = ?, wc_full_sync_cursor = ? WHERE id = ?`).run(completedAt, completedAt, site.id);
          } else {
            db.prepare(`UPDATE sites SET wc_sync_cursor = ? WHERE id = ?`).run(completedAt, site.id);
          }
          incrementalCandidateCache.delete(`${site.id}:${since}`);
        }
        return res.json({
          page, per_page: perPage, batch_size: 0,
          created, updated, errors,
          done, next_page: done ? null : page + 1,
          total_products: totalProducts, total_pages: totalPages,
          warehouse_id: warehouseId,
          incremental: !!since, since, cursor: nextCursor,
        });
      }

      // Upsert this page of parents/simples in one transaction.
      const variableParents = [];
      const upsert = db.transaction((rows) => {
        for (const wc of rows) {
          const productId = upsertWcProduct({
            site, warehouseId, wc, nowIso,
            wcType: wc.type === "variable" ? "variable" : "simple",
          });
          if (productId.created) created++; else updated++;
          if (wc.type === "variable") {
            variableParents.push({ wcId: wc.id, omsId: productId.id, name: wc.name });
          }
        }
      });
      upsert(batch);

      // Fetch variations for ALL variable parents in this page in PARALLEL
      // (concurrency 4 — gentle on the WC server, ~4× faster than serial).
      const CONCURRENCY = 4;
      for (let i = 0; i < variableParents.length; i += CONCURRENCY) {
        const slice = variableParents.slice(i, i + CONCURRENCY);
        const results = await Promise.all(slice.map(async (parent) => {
          try {
            const variations = await fetchAllVariations(site, parent.wcId);
            return { parent, variations, error: null };
          } catch (e) {
            return { parent, variations: [], error: e.message };
          }
        }));
        for (const { parent, variations, error } of results) {
          if (error) {
            errors.push({ wc_id: parent.wcId, error: `variations: ${error}` });
            continue;
          }
          if (variations.length === 0) {
            // A variable parent with ZERO variations is a WC config bug —
            // surface it so the user knows why the row isn't editable.
            errors.push({
              wc_id: parent.wcId,
              error: `Variable product "${parent.name}" has no variations published in WooCommerce`,
            });
            continue;
          }
          const upsertVars = db.transaction((vars) => {
            for (const v of vars) {
              const r2 = upsertWcProduct({
                site, warehouseId, wc: v, nowIso,
                wcType: "variation",
                parentOmsId: parent.omsId,
                wcParentId: parent.wcId,
                fallbackName: parent.name,
              });
              if (r2.created) created++; else updated++;
            }
          });
          upsertVars(variations);
        }
      }

      if (done) {
        if (forceFull) {
          db.prepare(`UPDATE sites SET wc_sync_cursor = ?, wc_full_sync_cursor = ? WHERE id = ?`).run(completedAt, completedAt, site.id);
        } else {
          db.prepare(`UPDATE sites SET wc_sync_cursor = ? WHERE id = ?`).run(completedAt, site.id);
        }
        incrementalCandidateCache.delete(`${site.id}:${since}`);
      }
      res.json({
        page, per_page: perPage, batch_size: batch.length,
        created, updated, errors,
        done,
        next_page: done ? null : page + 1,
        total_products: totalProducts,
        total_pages: totalPages,
        warehouse_id: warehouseId,
        incremental: !!since, since, cursor: nextCursor,
      });
    } catch (e) {
      console.error("[oms-woo] sync failed:", e);
      res.status(502).json({ error: e.message || "Sync failed", page });
    }
  });

  // ----- Local edits (no WC push) -----
  // Body: { site_id, edits: [{ product_id, fields: {...} }] }
  // Allowed fields: name, sku, regular_price, sale_price, description,
  // short_description, stock_quantity, stock_status, manage_stock, weight.
  // Each touched product gets `dirty = 1` so the UI can highlight unpushed.
  const ALLOWED_FIELDS = new Set([
    "name", "sku", "regular_price", "sale_price", "description",
    "short_description", "stock_quantity", "stock_status", "manage_stock", "weight",
  ]);
  app.patch(`${r}/products/bulk`, requireAuth, (req, res) => {
    const { site_id, edits } = req.body || {};
    if (!Number.isInteger(site_id) || !Array.isArray(edits)) {
      return res.status(422).json({ error: "site_id + edits[] required" });
    }
    let site;
    try { site = getSiteForUser(req.user.id, site_id); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    const warehouseId = ensureMirrorWarehouse(site, req.user.id);

    let ok = 0; const failed = [];
    const tx = db.transaction(() => {
      for (const edit of edits) {
        const { product_id, fields } = edit || {};
        if (!product_id || !fields || typeof fields !== "object") {
          failed.push({ product_id, reason: "validation" }); continue;
        }
        const prod = db.prepare(
          "SELECT id, dirty_fields FROM oms_products WHERE id = ? AND site_id = ?",
        ).get(product_id, site.id);
        if (!prod) { failed.push({ product_id, reason: "not_found" }); continue; }

        // Track which columns the user has touched since last sync. We OR
        // into any existing set so multiple saves accumulate.
        let touched;
        try { touched = new Set(JSON.parse(prod.dirty_fields || "[]")); }
        catch { touched = new Set(); }

        const sets = []; const values = [];
        for (const [k, v] of Object.entries(fields)) {
          if (!ALLOWED_FIELDS.has(k)) continue;
          if (k === "stock_quantity") continue; // handled below
          touched.add(k);
          if (k === "manage_stock") { sets.push(`manage_stock = ?`); values.push(v ? 1 : 0); continue; }
          sets.push(`${k} = ?`);
          values.push(v ?? null);
        }
        if (Object.prototype.hasOwnProperty.call(fields, "stock_quantity")) {
          touched.add("stock_quantity");
        }
        sets.push("dirty = 1", "dirty_fields = ?");
        values.push(JSON.stringify([...touched]));
        db.prepare(
          `UPDATE oms_products SET ${sets.join(", ")} WHERE id = ?`,
        ).run(...values, product_id);

        if (Object.prototype.hasOwnProperty.call(fields, "stock_quantity")) {
          const qty = Math.max(0, Math.floor(Number(fields.stock_quantity) || 0));
          const inv = db.prepare(
            `SELECT version FROM oms_inventory
              WHERE product_id = ? AND warehouse_id = ?`,
          ).get(product_id, warehouseId);
          if (inv) {
            db.prepare(
              `UPDATE oms_inventory SET quantity = ?, version = version + 1
                WHERE product_id = ? AND warehouse_id = ?`,
            ).run(qty, product_id, warehouseId);
          } else {
            db.prepare(
              `INSERT INTO oms_inventory
                 (product_id, warehouse_id, quantity, reserved, reorder_level, version)
               VALUES (?, ?, ?, 0, 0, 1)`,
            ).run(product_id, warehouseId, qty);
          }
        }
        ok++;
      }
    });
    tx();
    res.json({ ok, failed });
  });

  // ----- Wipe all imported products for a site (destructive) -----
  // Deletes every oms_products row scoped to the given site, plus their
  // oms_inventory rows. Requires { confirm: "DELETE" } in the body so it
  // can't fire accidentally. Other sites are untouched. The mirror
  // warehouse stays so re-syncing keeps the same warehouse_id.
  app.post(`${r}/wipe/:siteId`, requireAuth, (req, res) => {
    let site;
    try { site = getSiteForUser(req.user.id, req.params.siteId); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    if ((req.body?.confirm || "") !== "DELETE") {
      return res.status(422).json({ error: "confirm must be 'DELETE'" });
    }
    const tx = db.transaction(() => {
      const ids = db.prepare(
        `SELECT id FROM oms_products WHERE site_id = ?`,
      ).all(site.id).map((r) => r.id);
      if (ids.length === 0) return { deleted: 0 };
      const placeholders = ids.map(() => "?").join(",");
      // Inventory + audit rows that reference these products.
      db.prepare(`DELETE FROM oms_inventory WHERE product_id IN (${placeholders})`).run(...ids);
      try { db.prepare(`DELETE FROM oms_audit WHERE product_id IN (${placeholders})`).run(...ids); }
      catch { /* table may not exist in older installs */ }
      // Detach variations from their parents first to dodge FK checks, then
      // wipe the lot in one go.
      db.prepare(`UPDATE oms_products SET parent_product_id = NULL WHERE site_id = ?`).run(site.id);
      const r = db.prepare(`DELETE FROM oms_products WHERE site_id = ?`).run(site.id);
      return { deleted: r.changes };
    });
    const result = tx();
    res.json({ ok: true, ...result, site_id: site.id });
  });


  // Body: { site_id, product_ids: string[] (oms ids), label?: string }
  app.post(`${r}/backups`, requireAuth, async (req, res) => {
    const { site_id, product_ids, label } = req.body || {};
    if (!Number.isInteger(site_id) || !Array.isArray(product_ids) || product_ids.length === 0) {
      return res.status(422).json({ error: "site_id + product_ids[] required" });
    }
    let site;
    try { site = getSiteForUser(req.user.id, site_id); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

    const rows = db.prepare(
      `SELECT id, woo_product_id FROM oms_products
        WHERE site_id = ? AND id IN (${product_ids.map(() => "?").join(",")})`,
    ).all(site.id, ...product_ids);

    const snapshots = [];
    const errors = [];
    // Sequential to keep WC happy. Most pushes are <50 products.
    const fullRows = db.prepare(
      `SELECT id, woo_product_id, wc_type, wc_parent_id FROM oms_products
        WHERE site_id = ? AND id IN (${product_ids.map(() => "?").join(",")})`,
    ).all(site.id, ...product_ids);
    for (const row of fullRows) {
      if (!row.woo_product_id) continue;
      try {
        const p = await fetchOneFromWc(
          site, row.woo_product_id,
          row.wc_type === "variation" ? row.wc_parent_id : null,
        );
        snapshots.push({
          oms_product_id: row.id,
          wc_type: row.wc_type || "simple",
          wc_parent_id: row.wc_parent_id || null,
          ...snapshotShape(p),
        });
      } catch (e) {
        errors.push({ oms_product_id: row.id, error: e.message });
      }
    }

    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO oms_wc_backups (id, user_id, site_id, label, product_count, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id, req.user.id, site.id,
      label || `Pre-push snapshot — ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
      snapshots.length, JSON.stringify(snapshots),
    );
    res.json({ id, count: snapshots.length, errors });
  });

  app.get(`${r}/backups`, requireAuth, (req, res) => {
    const rows = db.prepare(
      `SELECT b.id, b.site_id, s.name AS site_name, b.label, b.product_count,
              b.restored_at, b.created_at
         FROM oms_wc_backups b
         JOIN sites s ON s.id = b.site_id
        WHERE b.user_id = ?
        ORDER BY b.created_at DESC
        LIMIT 100`,
    ).all(req.user.id);
    res.json(rows);
  });

  app.post(`${r}/backups/:id/restore`, requireAuth, async (req, res) => {
    const row = db.prepare(
      `SELECT * FROM oms_wc_backups WHERE id = ? AND user_id = ?`,
    ).get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: "Backup not found" });
    let site;
    try { site = getSiteForUser(req.user.id, row.site_id); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

    let payload;
    try { payload = JSON.parse(row.payload); } catch { payload = []; }
    let ok = 0; const failed = [];
    for (const snap of payload) {
      try {
        const body = {
          name: snap.name,
          sku: snap.sku,
          regular_price: snap.regular_price ?? "",
          sale_price: snap.sale_price ?? "",
          description: snap.description ?? "",
          short_description: snap.short_description ?? "",
          stock_quantity: snap.stock_quantity,
          stock_status: snap.stock_status,
          manage_stock: snap.manage_stock,
          weight: snap.weight ?? "",
        };
        if (snap.wc_type === "variation") {
          delete body.name;
          delete body.short_description;
        }
        await pushOneToWc(
          site, snap.id, body,
          snap.wc_type === "variation" ? snap.wc_parent_id : null,
        );
        ok++;
      } catch (e) {
        failed.push({ wc_id: snap.id, error: e.message });
      }
    }
    db.prepare(
      `UPDATE oms_wc_backups SET restored_at = datetime('now') WHERE id = ?`,
    ).run(row.id);
    res.json({ ok, failed });
  });

  // ----- Push local edits to WooCommerce -----
  // Body: { site_id, product_ids: string[] }
  // Pushes everything currently in oms_products for those ids; clears `dirty`.
  app.post(`${r}/push`, requireAuth, async (req, res) => {
    const { site_id, product_ids } = req.body || {};
    if (!Number.isInteger(site_id) || !Array.isArray(product_ids) || product_ids.length === 0) {
      return res.status(422).json({ error: "site_id + product_ids[] required" });
    }
    let site;
    try { site = getSiteForUser(req.user.id, site_id); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    const warehouseId = ensureMirrorWarehouse(site, req.user.id);

    const rows = db.prepare(
      `SELECT p.id, p.sku, p.name, p.regular_price, p.sale_price, p.description,
              p.short_description, p.stock_status, p.manage_stock, p.weight,
              p.woo_product_id, p.dirty_fields, p.wc_type, p.wc_parent_id,
              (SELECT quantity FROM oms_inventory
                WHERE product_id = p.id AND warehouse_id = ?) AS stock_quantity
         FROM oms_products p
        WHERE p.site_id = ? AND p.id IN (${product_ids.map(() => "?").join(",")})`,
    ).all(warehouseId, site.id, ...product_ids);

    let ok = 0; const failed = [];
    const nowIso = new Date().toISOString();
    for (const row of rows) {
      if (!row.woo_product_id) {
        failed.push({ product_id: row.id, error: "Not linked to WC" });
        continue;
      }
      if (row.wc_type === "variable") {
        // The variable parent has no editable price/stock of its own — those
        // live on its variations. Just clear the dirty flag and move on.
        db.prepare(`UPDATE oms_products SET dirty = 0, dirty_fields = NULL WHERE id = ?`)
          .run(row.id);
        ok++;
        continue;
      }
      let touched;
      try { touched = new Set(JSON.parse(row.dirty_fields || "[]")); }
      catch { touched = new Set(); }
      if (touched.size === 0) {
        // No tracked field changes — report as skipped so the UI can tell
        // the user nothing was pushed (instead of a misleading "ok").
        db.prepare(`UPDATE oms_products SET dirty = 0 WHERE id = ?`).run(row.id);
        failed.push({ product_id: row.id, error: "No changes to push (already in sync)" });
        continue;
      }

      // Build the WC payload from ONLY the fields the user touched.
      const body = {};
      // Variations don't accept `name` — their display name is derived from
      // the parent + attributes. Drop it to avoid 400s.
      if (touched.has("name") && row.wc_type !== "variation") body.name = row.name;
      if (touched.has("sku")) body.sku = row.sku;
      if (touched.has("regular_price")) {
        body.regular_price = row.regular_price != null ? String(row.regular_price) : "";
      }
      if (touched.has("sale_price")) {
        body.sale_price = row.sale_price != null ? String(row.sale_price) : "";
      }
      // Variations only have a single `description` field; short_description
      // is parent-only.
      if (touched.has("description")) body.description = row.description ?? "";
      if (touched.has("short_description") && row.wc_type !== "variation") {
        body.short_description = row.short_description ?? "";
      }
      if (touched.has("weight")) body.weight = row.weight != null ? String(row.weight) : "";
      if (touched.has("manage_stock")) body.manage_stock = !!row.manage_stock;
      if (touched.has("stock_status")) body.stock_status = row.stock_status ?? "instock";
      if (touched.has("stock_quantity")) {
        body.stock_quantity = Math.max(0, Math.floor(Number(row.stock_quantity) || 0));
        // WC ignores stock_quantity unless manage_stock is true; force it on.
        body.manage_stock = true;
      }
      if (Object.keys(body).length === 0) {
        // All touched fields were dropped (e.g. variation-only "name").
        db.prepare(`UPDATE oms_products SET dirty = 0, dirty_fields = NULL WHERE id = ?`)
          .run(row.id);
        failed.push({ product_id: row.id, error: "All edited fields are not pushable for this product type" });
        continue;
      }

      try {
        await pushOneToWc(
          site, row.woo_product_id, body,
          row.wc_type === "variation" ? row.wc_parent_id : null,
        );
        db.prepare(
          `UPDATE oms_products
              SET dirty = 0, dirty_fields = NULL, last_synced_at = ?
            WHERE id = ?`,
        ).run(nowIso, row.id);
        ok++;
      } catch (e) {
        failed.push({ product_id: row.id, error: e.message });
      }
    }
    res.json({ ok, failed });
  });
}
