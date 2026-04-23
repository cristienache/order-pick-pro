// HeyShop Inventory ("OMS") API — real implementation.
//
// Mounted from server/index.js with:
//   import { mountOms } from "./oms.js";
//   mountOms(app, { requireAuth });
//
// All endpoints live under /api/oms/* and follow docs/heyshop-api-contract.md.
// Persistence uses the existing better-sqlite3 instance from ./db.js so
// HeyShop ships a single SQLite file. Schema is created idempotently here
// (separate from server/db.js so the OMS module is self-contained).
//
// Notes for future maintainers:
//  - Primary keys are UUID strings, generated server-side via crypto.randomUUID().
//  - Optimistic concurrency: every InventoryRow has a `version` column that
//    increments on every successful update. Cell + bulk updates compare
//    `expected_version` and reject with HTTP 409 on mismatch.
//  - Routing (POST /orders) runs greedy nearest-warehouse allocation per
//    line item, identical to src/lib/routing.ts on the frontend, then writes
//    Order + OrderItems + Shipments + ShipmentItems + inventory decrements
//    + audit rows in a single transaction.
//  - WooCommerce push-back for `source = "woo"` products is left as a TODO
//    (see docs/heyshop-api-contract.md "WooCommerce bridge"). The current
//    server/woocommerce.js client is per-site/per-user; OMS products live in
//    a global namespace, so wiring requires deciding which site to push to.

import crypto from "node:crypto";
import { db } from "./db.js";

/* ---------------- Schema (idempotent) ---------------- */

db.exec(`
  CREATE TABLE IF NOT EXISTS oms_products (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'oms' CHECK (source IN ('oms','woo')),
    base_price REAL NOT NULL DEFAULT 0,
    woo_product_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS oms_warehouses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    address TEXT,
    lat REAL NOT NULL DEFAULT 0,
    lng REAL NOT NULL DEFAULT 0,
    capacity_units INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS oms_inventory (
    product_id TEXT NOT NULL REFERENCES oms_products(id) ON DELETE CASCADE,
    warehouse_id TEXT NOT NULL REFERENCES oms_warehouses(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0,
    reorder_level INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (product_id, warehouse_id)
  );

  CREATE TABLE IF NOT EXISTS oms_inventory_audit (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    warehouse_id TEXT NOT NULL,
    delta INTEGER NOT NULL,
    new_qty INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'ui',
    actor_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_oms_audit_created ON oms_inventory_audit(created_at DESC);

  CREATE TABLE IF NOT EXISTS oms_orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    customer_address TEXT,
    customer_lat REAL NOT NULL DEFAULT 0,
    customer_lng REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','allocated','partial','backorder','shipped','cancelled')),
    notes TEXT,
    woo_order_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_oms_orders_created ON oms_orders(created_at DESC);

  CREATE TABLE IF NOT EXISTS oms_order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES oms_orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_oms_order_items_order ON oms_order_items(order_id);

  CREATE TABLE IF NOT EXISTS oms_shipments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES oms_orders(id) ON DELETE CASCADE,
    warehouse_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'allocated'
      CHECK (status IN ('allocated','picked','shipped','cancelled')),
    tracking TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_oms_shipments_order ON oms_shipments(order_id);

  CREATE TABLE IF NOT EXISTS oms_shipment_items (
    id TEXT PRIMARY KEY,
    shipment_id TEXT NOT NULL REFERENCES oms_shipments(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_oms_shipment_items_ship ON oms_shipment_items(shipment_id);

  -- Per-user OMS profile: app-level role + warehouse allowlist.
  -- Distinct from the global users.role which is just 'user' | 'admin' for
  -- the rest of HeyShop. Absence of a row means "viewer of all warehouses".
  CREATE TABLE IF NOT EXISTS oms_user_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','manager','viewer')),
    -- JSON array of warehouse IDs the user may edit. Admins ignore this.
    warehouse_ids TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/* ---------------- Per-user scoping migrations (idempotent) ----------------
 * Inventory and orders are per-tenant: every warehouse and every order belongs
 * to a single HeyShop user. Existing single-tenant rows get backfilled to the
 * first admin user so we don't strand data on upgrade.
 *
 * NOTE: We deliberately don't touch oms_products — the WC bridge already
 * scopes products via the `site_id` column (sites are owned per-user), and
 * the legacy demo seed put a couple of un-scoped products in there that we
 * just leave alone (they're harmless and only visible to admins via the
 * legacy code paths; the new endpoints filter through warehouses).
 */
{
  const whCols = new Set(
    db.prepare("PRAGMA table_info(oms_warehouses)").all().map((c) => c.name),
  );
  if (!whCols.has("user_id")) {
    db.exec(`ALTER TABLE oms_warehouses ADD COLUMN user_id INTEGER`);
  }
  const orderCols = new Set(
    db.prepare("PRAGMA table_info(oms_orders)").all().map((c) => c.name),
  );
  if (!orderCols.has("user_id")) {
    db.exec(`ALTER TABLE oms_orders ADD COLUMN user_id INTEGER`);
  }

  // Backfill nulls onto the first admin user (if any). On a brand new DB
  // there is no user yet — that's fine, the seed below skips and the next
  // signup will own its own data.
  const firstAdmin = db.prepare(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1",
  ).get();
  if (firstAdmin) {
    db.prepare("UPDATE oms_warehouses SET user_id = ? WHERE user_id IS NULL").run(firstAdmin.id);
    db.prepare("UPDATE oms_orders SET user_id = ? WHERE user_id IS NULL").run(firstAdmin.id);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_oms_warehouses_user ON oms_warehouses(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_oms_orders_user ON oms_orders(user_id)`);
}

/* ---------------- Demo seed ----------------
 * Disabled. Inventory is now per-user — no shared global catalog. New users
 * see an empty inventory page until they connect a WooCommerce site (which
 * auto-creates a per-user mirror warehouse + product rows) or manually
 * create their first warehouse.
 */

/* ---------------- Helpers ---------------- */

const ALLOWED_SHIPMENT_STATUSES = new Set(["allocated", "picked", "shipped", "cancelled"]);

/** Read the OMS profile for a HeyShop user, falling back to defaults.
 *  HeyShop admins are mirrored as OMS admins automatically. */
function getOmsProfile(user) {
  const row = db.prepare(
    "SELECT role, warehouse_ids FROM oms_user_profiles WHERE user_id = ?",
  ).get(user.id);
  const isHeyshopAdmin = user.role === "admin";
  if (!row) {
    return {
      role: isHeyshopAdmin ? "admin" : "viewer",
      warehouse_ids: [],
    };
  }
  let wh = [];
  try { wh = JSON.parse(row.warehouse_ids || "[]"); } catch { wh = []; }
  return {
    role: isHeyshopAdmin ? "admin" : row.role,
    warehouse_ids: Array.isArray(wh) ? wh.map(String) : [],
  };
}

/** Returns true if `profile` is allowed to edit `warehouse_id`. */
function canEditWarehouse(profile, warehouseId) {
  if (profile.role === "admin") return true;
  return profile.warehouse_ids.includes(warehouseId);
}

/** Visible warehouses for a profile. Admins see all; everyone else sees the
 *  allowlist (which may be empty → no rows). Returns Set<string>. */
function visibleWarehouseIds(profile) {
  if (profile.role === "admin") {
    const all = db.prepare("SELECT id FROM oms_warehouses").all().map((r) => r.id);
    return new Set(all);
  }
  return new Set(profile.warehouse_ids);
}

/** Manhattan distance, matching src/lib/routing.ts. */
function manhattan(a, b) {
  return Math.abs(a.lat - b.lat) + Math.abs(a.lng - b.lng);
}

/** Build the OrderDetail payload for a given order id. */
function loadOrderDetail(orderId) {
  const order = db.prepare("SELECT * FROM oms_orders WHERE id = ?").get(orderId);
  if (!order) return null;
  const items = db.prepare("SELECT * FROM oms_order_items WHERE order_id = ?").all(orderId);
  const shipments = db.prepare(
    "SELECT * FROM oms_shipments WHERE order_id = ? ORDER BY created_at ASC",
  ).all(orderId);
  const shipmentIds = shipments.map((s) => s.id);
  const shipment_items = shipmentIds.length
    ? db.prepare(
        `SELECT * FROM oms_shipment_items
         WHERE shipment_id IN (${shipmentIds.map(() => "?").join(",")})`,
      ).all(...shipmentIds)
    : [];

  // Shortfall = order quantity − allocated across shipments, per product.
  const allocatedByProduct = new Map();
  for (const si of shipment_items) {
    allocatedByProduct.set(
      si.product_id,
      (allocatedByProduct.get(si.product_id) || 0) + si.quantity,
    );
  }
  const shortfall = [];
  for (const it of items) {
    const got = allocatedByProduct.get(it.product_id) || 0;
    const missing = it.quantity - got;
    if (missing > 0) shortfall.push({ product_id: it.product_id, quantity: missing });
  }
  return { order, items, shipments, shipment_items, shortfall };
}

/* ---------------- Mount ---------------- */

export function mountOms(app, { requireAuth }) {
  const r = "/api/oms";

  // ---------- Session ----------
  app.get(`${r}/session`, requireAuth, (req, res) => {
    const profile = getOmsProfile(req.user);
    const visible = profile.role === "admin"
      ? db.prepare("SELECT id FROM oms_warehouses").all().map((row) => row.id)
      : profile.warehouse_ids;
    res.json({
      id: String(req.user.id),
      email: req.user.email,
      roles: [profile.role],
      warehouse_ids: visible,
    });
  });

  // ---------- Catalog ----------
  app.get(`${r}/products`, requireAuth, (_req, res) => {
    const rows = db.prepare(
      `SELECT id, sku, name, source, base_price, woo_product_id, created_at
         FROM oms_products
        ORDER BY name ASC`,
    ).all();
    res.json(rows);
  });

  app.get(`${r}/warehouses`, requireAuth, (req, res) => {
    const activeOnly = req.query.active === "1" || req.query.active === "true";
    const rows = db.prepare(
      `SELECT id, name, code, address, lat, lng, capacity_units, is_active
         FROM oms_warehouses
         ${activeOnly ? "WHERE is_active = 1" : ""}
        ORDER BY name ASC`,
    ).all().map((w) => ({ ...w, is_active: !!w.is_active }));
    res.json(rows);
  });

  // ---------- Inventory ----------
  app.get(`${r}/inventory`, requireAuth, (req, res) => {
    const profile = getOmsProfile(req.user);
    const visible = visibleWarehouseIds(profile);
    if (visible.size === 0) return res.json([]);

    const productFilter = typeof req.query.product_ids === "string" && req.query.product_ids.length
      ? req.query.product_ids.split(",").map((s) => s.trim()).filter(Boolean)
      : null;

    const visibleArr = [...visible];
    let sql = `SELECT product_id, warehouse_id, quantity, reserved, reorder_level, version
                 FROM oms_inventory
                WHERE warehouse_id IN (${visibleArr.map(() => "?").join(",")})`;
    const params = [...visibleArr];
    if (productFilter && productFilter.length) {
      sql += ` AND product_id IN (${productFilter.map(() => "?").join(",")})`;
      params.push(...productFilter);
    }
    res.json(db.prepare(sql).all(...params));
  });

  app.post(`${r}/inventory/cell`, requireAuth, (req, res) => {
    const { product_id, warehouse_id, next_quantity, expected_version, reason } = req.body || {};
    if (!product_id || !warehouse_id || typeof next_quantity !== "number" ||
        typeof expected_version !== "number") {
      return res.status(422).json({ error: "Invalid input", code: "validation" });
    }
    if (next_quantity < 0 || !Number.isFinite(next_quantity)) {
      return res.status(422).json({ error: "Quantity must be ≥ 0", code: "validation" });
    }

    const profile = getOmsProfile(req.user);
    if (!canEditWarehouse(profile, warehouse_id)) {
      return res.status(403).json({ error: "Not allowed for this warehouse", code: "forbidden" });
    }

    try {
      const updated = db.transaction(() => {
        const row = db.prepare(
          `SELECT product_id, warehouse_id, quantity, reserved, reorder_level, version
             FROM oms_inventory
            WHERE product_id = ? AND warehouse_id = ?`,
        ).get(product_id, warehouse_id);
        if (!row) {
          const e = new Error("Not found"); e.code = "not_found"; throw e;
        }
        if (row.version !== expected_version) {
          const e = new Error("Version conflict"); e.code = "version_conflict"; throw e;
        }
        const delta = next_quantity - row.quantity;
        const newVersion = row.version + 1;
        db.prepare(
          `UPDATE oms_inventory
              SET quantity = ?, version = ?
            WHERE product_id = ? AND warehouse_id = ?`,
        ).run(next_quantity, newVersion, product_id, warehouse_id);
        db.prepare(
          `INSERT INTO oms_inventory_audit
             (id, product_id, warehouse_id, delta, new_qty, reason, source, actor_id)
           VALUES (?, ?, ?, ?, ?, ?, 'ui', ?)`,
        ).run(
          crypto.randomUUID(), product_id, warehouse_id,
          delta, next_quantity, reason || "Manual edit", String(req.user.id),
        );
        return { ...row, quantity: next_quantity, version: newVersion };
      })();
      res.json(updated);
    } catch (e) {
      if (e.code === "not_found") return res.status(404).json({ error: "Not found", code: "not_found" });
      if (e.code === "version_conflict") {
        return res.status(409).json({ error: "Version conflict", code: "version_conflict" });
      }
      console.error("[oms] cell update failed:", e);
      res.status(500).json({ error: "Update failed" });
    }
  });

  app.post(`${r}/inventory/bulk`, requireAuth, (req, res) => {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : null;
    if (!updates) return res.status(422).json({ error: "updates[] required" });
    const reason = req.body?.reason || "Bulk edit";
    const profile = getOmsProfile(req.user);

    let ok = 0;
    const failed = [];
    // Per-row transactions so one bad row doesn't roll back the whole batch.
    for (const u of updates) {
      const { product_id, warehouse_id, next_quantity, expected_version } = u || {};
      if (!product_id || !warehouse_id || typeof next_quantity !== "number" ||
          typeof expected_version !== "number" || next_quantity < 0) {
        failed.push({ product_id, warehouse_id, reason: "error", message: "Invalid input" });
        continue;
      }
      if (!canEditWarehouse(profile, warehouse_id)) {
        failed.push({ product_id, warehouse_id, reason: "forbidden" });
        continue;
      }
      try {
        db.transaction(() => {
          const row = db.prepare(
            `SELECT quantity, version FROM oms_inventory
              WHERE product_id = ? AND warehouse_id = ?`,
          ).get(product_id, warehouse_id);
          if (!row) { const e = new Error("nf"); e.code = "not_found"; throw e; }
          if (row.version !== expected_version) {
            const e = new Error("vc"); e.code = "version_conflict"; throw e;
          }
          const delta = next_quantity - row.quantity;
          const newVersion = row.version + 1;
          db.prepare(
            `UPDATE oms_inventory SET quantity = ?, version = ?
              WHERE product_id = ? AND warehouse_id = ?`,
          ).run(next_quantity, newVersion, product_id, warehouse_id);
          db.prepare(
            `INSERT INTO oms_inventory_audit
               (id, product_id, warehouse_id, delta, new_qty, reason, source, actor_id)
             VALUES (?, ?, ?, ?, ?, ?, 'ui', ?)`,
          ).run(
            crypto.randomUUID(), product_id, warehouse_id,
            delta, next_quantity, reason, String(req.user.id),
          );
        })();
        ok += 1;
      } catch (e) {
        if (e.code === "not_found") failed.push({ product_id, warehouse_id, reason: "not_found" });
        else if (e.code === "version_conflict") failed.push({ product_id, warehouse_id, reason: "version_conflict" });
        else { console.error("[oms] bulk row failed:", e); failed.push({ product_id, warehouse_id, reason: "error" }); }
      }
    }
    res.json({ ok, failed });
  });

  // ---------- Audit ----------
  app.get(`${r}/inventory/audit`, requireAuth, (req, res) => {
    const limitRaw = Number(req.query.limit);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 500, 1), 1000);
    const rows = db.prepare(
      `SELECT id, product_id, warehouse_id, delta, new_qty, reason, source, actor_id, created_at
         FROM oms_inventory_audit
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).all(limit);
    res.json(rows);
  });

  // ---------- Orders ----------
  app.get(`${r}/orders`, requireAuth, (req, res) => {
    const limitRaw = Number(req.query.limit);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);
    const rows = db.prepare(
      `SELECT o.*,
              (SELECT COUNT(*) FROM oms_shipments s WHERE s.order_id = o.id) AS shipment_count
         FROM oms_orders o
        ORDER BY o.created_at DESC
        LIMIT ?`,
    ).all(limit);
    res.json(rows);
  });

  app.get(`${r}/orders/:id`, requireAuth, (req, res) => {
    const detail = loadOrderDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: "Not found" });
    res.json(detail);
  });

  app.post(`${r}/orders`, requireAuth, (req, res) => {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!body.customer_name || typeof body.customer_lat !== "number" ||
        typeof body.customer_lng !== "number" || items.length === 0) {
      return res.status(422).json({ error: "customer_name, customer_lat, customer_lng, items[] required" });
    }
    for (const it of items) {
      if (!it?.product_id || !Number.isInteger(it.quantity) || it.quantity <= 0) {
        return res.status(422).json({ error: "Each item needs product_id and positive integer quantity" });
      }
    }

    try {
      const orderId = db.transaction(() => {
        const oid = crypto.randomUUID();
        db.prepare(
          `INSERT INTO oms_orders
             (id, customer_name, customer_address, customer_lat, customer_lng, status, notes)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        ).run(
          oid, body.customer_name, body.customer_address ?? null,
          body.customer_lat, body.customer_lng, body.notes ?? null,
        );
        for (const it of items) {
          db.prepare(
            `INSERT INTO oms_order_items (id, order_id, product_id, quantity)
             VALUES (?, ?, ?, ?)`,
          ).run(crypto.randomUUID(), oid, it.product_id, it.quantity);
        }

        // ---- Greedy nearest-warehouse routing ----
        const customer = { lat: body.customer_lat, lng: body.customer_lng };
        const warehouses = db.prepare(
          `SELECT id, lat, lng FROM oms_warehouses WHERE is_active = 1`,
        ).all().sort((a, b) => manhattan(a, customer) - manhattan(b, customer));

        // Local working copy of inventory so allocations within the same
        // request consume from the shared pool.
        const invMap = new Map(); // key = `${product}|${warehouse}` → row
        const loadInv = (productId, warehouseId) => {
          const key = `${productId}|${warehouseId}`;
          if (!invMap.has(key)) {
            const row = db.prepare(
              `SELECT product_id, warehouse_id, quantity, reserved, version
                 FROM oms_inventory WHERE product_id = ? AND warehouse_id = ?`,
            ).get(productId, warehouseId);
            invMap.set(key, row || null);
          }
          return invMap.get(key);
        };

        // shipmentId per warehouse — created lazily on first allocation.
        const shipmentByWh = new Map();
        const ensureShipment = (warehouseId) => {
          if (shipmentByWh.has(warehouseId)) return shipmentByWh.get(warehouseId);
          const sid = crypto.randomUUID();
          db.prepare(
            `INSERT INTO oms_shipments (id, order_id, warehouse_id, status, tracking)
             VALUES (?, ?, ?, 'allocated', NULL)`,
          ).run(sid, oid, warehouseId);
          shipmentByWh.set(warehouseId, sid);
          return sid;
        };

        let shortfallSeen = false;
        for (const it of items) {
          let remaining = it.quantity;
          for (const wh of warehouses) {
            if (remaining <= 0) break;
            const inv = loadInv(it.product_id, wh.id);
            if (!inv) continue;
            const available = Math.max(0, inv.quantity - inv.reserved);
            if (available <= 0) continue;
            const take = Math.min(available, remaining);
            const newQty = inv.quantity - take;
            const newVersion = inv.version + 1;

            db.prepare(
              `UPDATE oms_inventory
                  SET quantity = ?, version = ?
                WHERE product_id = ? AND warehouse_id = ?`,
            ).run(newQty, newVersion, it.product_id, wh.id);
            db.prepare(
              `INSERT INTO oms_inventory_audit
                 (id, product_id, warehouse_id, delta, new_qty, reason, source, actor_id)
               VALUES (?, ?, ?, ?, ?, ?, 'order-route', ?)`,
            ).run(
              crypto.randomUUID(), it.product_id, wh.id,
              -take, newQty, `Order ${oid}`, String(req.user.id),
            );
            invMap.set(`${it.product_id}|${wh.id}`, { ...inv, quantity: newQty, version: newVersion });

            const sid = ensureShipment(wh.id);
            db.prepare(
              `INSERT INTO oms_shipment_items (id, shipment_id, product_id, quantity)
               VALUES (?, ?, ?, ?)`,
            ).run(crypto.randomUUID(), sid, it.product_id, take);
            remaining -= take;
          }
          if (remaining > 0) shortfallSeen = true;
        }

        const status = shipmentByWh.size === 0
          ? "backorder"
          : shortfallSeen ? "partial" : "allocated";
        db.prepare(
          `UPDATE oms_orders SET status = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(status, oid);
        return oid;
      })();

      res.json(loadOrderDetail(orderId));
    } catch (e) {
      console.error("[oms] order create failed:", e);
      res.status(500).json({ error: "Order creation failed" });
    }
  });

  app.patch(`${r}/shipments/:id`, requireAuth, (req, res) => {
    const status = req.body?.status;
    if (!ALLOWED_SHIPMENT_STATUSES.has(status)) {
      return res.status(422).json({ error: "Invalid status" });
    }

    try {
      const result = db.transaction(() => {
        const ship = db.prepare("SELECT * FROM oms_shipments WHERE id = ?").get(req.params.id);
        if (!ship) { const e = new Error("nf"); e.code = "not_found"; throw e; }
        const previousStatus = ship.status;
        db.prepare("UPDATE oms_shipments SET status = ? WHERE id = ?").run(status, ship.id);

        // Cancel → refund inventory (only if it wasn't already cancelled).
        if (status === "cancelled" && previousStatus !== "cancelled") {
          const items = db.prepare(
            "SELECT product_id, quantity FROM oms_shipment_items WHERE shipment_id = ?",
          ).all(ship.id);
          for (const si of items) {
            const inv = db.prepare(
              `SELECT quantity, version FROM oms_inventory
                WHERE product_id = ? AND warehouse_id = ?`,
            ).get(si.product_id, ship.warehouse_id);
            if (!inv) continue;
            const newQty = inv.quantity + si.quantity;
            db.prepare(
              `UPDATE oms_inventory SET quantity = ?, version = ?
                WHERE product_id = ? AND warehouse_id = ?`,
            ).run(newQty, inv.version + 1, si.product_id, ship.warehouse_id);
            db.prepare(
              `INSERT INTO oms_inventory_audit
                 (id, product_id, warehouse_id, delta, new_qty, reason, source, actor_id)
               VALUES (?, ?, ?, ?, ?, ?, 'order-route', ?)`,
            ).run(
              crypto.randomUUID(), si.product_id, ship.warehouse_id,
              si.quantity, newQty, `Cancelled shipment ${ship.id}`, String(req.user.id),
            );
          }
        }

        // Roll order status up: all shipped → shipped; all cancelled → cancelled.
        const sibs = db.prepare(
          "SELECT status FROM oms_shipments WHERE order_id = ?",
        ).all(ship.order_id);
        if (sibs.length > 0) {
          if (sibs.every((s) => s.status === "shipped")) {
            db.prepare(
              "UPDATE oms_orders SET status = 'shipped', updated_at = datetime('now') WHERE id = ?",
            ).run(ship.order_id);
          } else if (sibs.every((s) => s.status === "cancelled")) {
            db.prepare(
              "UPDATE oms_orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?",
            ).run(ship.order_id);
          }
        }
        return { id: ship.id, status };
      })();
      res.json(result);
    } catch (e) {
      if (e.code === "not_found") return res.status(404).json({ error: "Not found" });
      console.error("[oms] shipment patch failed:", e);
      res.status(500).json({ error: "Update failed" });
    }
  });
}
