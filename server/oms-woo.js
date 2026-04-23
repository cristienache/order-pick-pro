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
 *  deterministic per site so re-syncs reuse it. */
function ensureMirrorWarehouse(site) {
  const code = `WC-${site.id}`;
  let row = db.prepare("SELECT id FROM oms_warehouses WHERE code = ?").get(code);
  if (row) return row.id;
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO oms_warehouses
       (id, name, code, address, lat, lng, capacity_units, is_active)
     VALUES (?, ?, ?, NULL, 0, 0, 0, 1)`,
  ).run(id, `${site.name} (WC mirror)`, code);
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

/** PUT one WC product. Returns the updated WC payload. */
async function pushOneToWc(site, wcId, body) {
  const url = `${normalizeUrl(site.store_url)}/wp-json/wc/v3/products/${wcId}`;
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
  if (!res.ok) throw new Error(`WC ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return null; }
}

/** GET one WC product (used for snapshots). */
async function fetchOneFromWc(site, wcId) {
  const url = `${normalizeUrl(site.store_url)}/wp-json/wc/v3/products/${wcId}`;
  const res = await fetch(url, {
    headers: {
      Authorization: authHeader(site.consumer_key, site.consumer_secret),
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`WC ${res.status}`);
  return res.json();
}

/** Coerce a WC numeric string ("19.99") → number, blank → null. */
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
        `SELECT MAX(last_synced_at) AS ts FROM oms_products WHERE site_id = ?`,
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

  // ----- Sync a site's WC catalog into oms_products -----
  app.post(`${r}/sync/:siteId`, requireAuth, async (req, res) => {
    let site;
    try { site = getSiteForUser(req.user.id, req.params.siteId); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

    const warehouseId = ensureMirrorWarehouse(site);
    const base = normalizeUrl(site.store_url);
    const perPage = 100;
    const maxPages = 30; // hard cap → 3,000 products
    let page = 1, total = 0, created = 0, updated = 0;
    const errors = [];

    try {
      while (page <= maxPages) {
        const url = `${base}/wp-json/wc/v3/products?per_page=${perPage}&page=${page}&orderby=id&order=asc`;
        const wcRes = await fetch(url, {
          headers: {
            Authorization: authHeader(site.consumer_key, site.consumer_secret),
            Accept: "application/json",
          },
        });
        if (!wcRes.ok) {
          const text = await wcRes.text().catch(() => "");
          throw new Error(`WC ${wcRes.status}: ${text.slice(0, 300)}`);
        }
        const batch = await wcRes.json();
        if (!Array.isArray(batch) || batch.length === 0) break;

        const nowIso = new Date().toISOString();
        const upsert = db.transaction((rows) => {
          for (const wc of rows) {
            const sku = wc.sku && wc.sku.trim() ? wc.sku.trim() : `WC-${site.id}-${wc.id}`;
            const existing = db.prepare(
              `SELECT id FROM oms_products WHERE site_id = ? AND woo_product_id = ?`,
            ).get(site.id, wc.id);
            const productId = existing?.id || crypto.randomUUID();
            const stockQty = Number.isFinite(Number(wc.stock_quantity))
              ? Number(wc.stock_quantity) : 0;

            if (existing) {
              db.prepare(
                `UPDATE oms_products
                   SET sku = ?, name = ?, base_price = ?, regular_price = ?, sale_price = ?,
                       description = ?, short_description = ?, stock_status = ?,
                       manage_stock = ?, weight = ?, dirty = 0, last_synced_at = ?
                 WHERE id = ?`,
              ).run(
                sku, wc.name || sku,
                num(wc.price) ?? num(wc.regular_price) ?? 0,
                num(wc.regular_price), num(wc.sale_price),
                wc.description ?? null, wc.short_description ?? null,
                wc.stock_status ?? "instock",
                wc.manage_stock ? 1 : 0,
                num(wc.weight),
                nowIso,
                productId,
              );
              updated++;
            } else {
              // SKUs are UNIQUE in oms_products. If the same SKU is already
              // taken (e.g. it was created manually before sync), suffix it.
              let finalSku = sku;
              let i = 1;
              while (db.prepare("SELECT 1 FROM oms_products WHERE sku = ?").get(finalSku)) {
                finalSku = `${sku}-WC${site.id}-${i++}`;
                if (i > 50) break;
              }
              db.prepare(
                `INSERT INTO oms_products
                   (id, sku, name, source, base_price, woo_product_id, site_id,
                    description, short_description, regular_price, sale_price,
                    stock_status, manage_stock, weight, dirty, last_synced_at)
                 VALUES (?, ?, ?, 'woo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
              ).run(
                productId, finalSku, wc.name || finalSku,
                num(wc.price) ?? num(wc.regular_price) ?? 0,
                wc.id, site.id,
                wc.description ?? null, wc.short_description ?? null,
                num(wc.regular_price), num(wc.sale_price),
                wc.stock_status ?? "instock",
                wc.manage_stock ? 1 : 0,
                num(wc.weight),
                nowIso,
              );
              created++;
            }

            // Inventory mirror — one row per (product, mirror warehouse).
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
        });
        upsert(batch);
        total += batch.length;
        if (batch.length < perPage) break;
        page++;
      }
      res.json({ total, created, updated, warehouse_id: warehouseId, errors });
    } catch (e) {
      console.error("[oms-woo] sync failed:", e);
      res.status(502).json({ error: e.message || "Sync failed" });
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
    const warehouseId = ensureMirrorWarehouse(site);

    let ok = 0; const failed = [];
    const tx = db.transaction(() => {
      for (const edit of edits) {
        const { product_id, fields } = edit || {};
        if (!product_id || !fields || typeof fields !== "object") {
          failed.push({ product_id, reason: "validation" }); continue;
        }
        const prod = db.prepare(
          "SELECT id FROM oms_products WHERE id = ? AND site_id = ?",
        ).get(product_id, site.id);
        if (!prod) { failed.push({ product_id, reason: "not_found" }); continue; }

        const sets = []; const values = [];
        for (const [k, v] of Object.entries(fields)) {
          if (!ALLOWED_FIELDS.has(k)) continue;
          if (k === "stock_quantity") continue; // handled below
          if (k === "manage_stock") { sets.push(`manage_stock = ?`); values.push(v ? 1 : 0); continue; }
          if (k === "name" || k === "sku") sets.push(`${k} = ?`);
          else sets.push(`${k} = ?`);
          values.push(v ?? null);
        }
        if (sets.length) {
          sets.push("dirty = 1");
          db.prepare(
            `UPDATE oms_products SET ${sets.join(", ")} WHERE id = ?`,
          ).run(...values, product_id);
        }
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
          db.prepare(`UPDATE oms_products SET dirty = 1 WHERE id = ?`).run(product_id);
        }
        ok++;
      }
    });
    tx();
    res.json({ ok, failed });
  });

  // ----- Backup: snapshot current WC state of given products -----
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
    for (const row of rows) {
      if (!row.woo_product_id) continue;
      try {
        const p = await fetchOneFromWc(site, row.woo_product_id);
        snapshots.push({ oms_product_id: row.id, ...snapshotShape(p) });
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
        await pushOneToWc(site, snap.id, {
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
        });
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
    const warehouseId = ensureMirrorWarehouse(site);

    const rows = db.prepare(
      `SELECT p.id, p.sku, p.name, p.regular_price, p.sale_price, p.description,
              p.short_description, p.stock_status, p.manage_stock, p.weight,
              p.woo_product_id,
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
      const body = {
        name: row.name,
        sku: row.sku,
        regular_price: row.regular_price != null ? String(row.regular_price) : "",
        sale_price: row.sale_price != null ? String(row.sale_price) : "",
        description: row.description ?? "",
        short_description: row.short_description ?? "",
        stock_status: row.stock_status ?? "instock",
        manage_stock: !!row.manage_stock,
        weight: row.weight != null ? String(row.weight) : "",
      };
      if (row.manage_stock) {
        body.stock_quantity = Math.max(0, Math.floor(Number(row.stock_quantity) || 0));
      }
      try {
        await pushOneToWc(site, row.woo_product_id, body);
        db.prepare(
          `UPDATE oms_products SET dirty = 0, last_synced_at = ? WHERE id = ?`,
        ).run(nowIso, row.id);
        ok++;
      } catch (e) {
        failed.push({ product_id: row.id, error: e.message });
      }
    }
    res.json({ ok, failed });
  });
}
