// 30-line(ish) Express stub for the HeyShop Inventory ("OMS") API.
//
// Drop into `server/index.js` with:
//
//   import { mountOmsStub } from "./oms-stub.js";
//   mountOmsStub(app, { requireAuth });
//
// Every route returns a hard-coded fixture so the React UI can render the
// full grid, audit, and orders flows end-to-end. Replace each handler with
// real DB-backed logic from docs/heyshop-api-contract.md when ready.

export function mountOmsStub(app, { requireAuth }) {
  const r = "/api/oms";

  // --- Session -------------------------------------------------------------
  app.get(`${r}/session`, requireAuth, (req, res) => {
    res.json({ id: String(req.user.id), email: req.user.email,
      roles: [req.user.role === "admin" ? "admin" : "viewer"],
      warehouse_ids: ["wh-1", "wh-2"] });
  });

  // --- Catalog -------------------------------------------------------------
  app.get(`${r}/products`, requireAuth, (_req, res) => res.json([
    { id: "p-1", sku: "WIDGET-1", name: "Widget", source: "oms", base_price: 9.99, woo_product_id: null },
    { id: "p-2", sku: "GIZMO-2",  name: "Gizmo",  source: "woo", base_price: 19.0, woo_product_id: 1234 },
  ]));
  app.get(`${r}/warehouses`, requireAuth, (_req, res) => res.json([
    { id: "wh-1", name: "London DC", code: "LON", address: null, lat: 51.5, lng: -0.12, capacity_units: 10000, is_active: true },
    { id: "wh-2", name: "Berlin DC", code: "BER", address: null, lat: 52.5, lng: 13.4,  capacity_units: 8000,  is_active: true },
  ]));

  // --- Inventory -----------------------------------------------------------
  const inv = [
    { product_id: "p-1", warehouse_id: "wh-1", quantity: 42, reserved: 0, reorder_level: 10, version: 1 },
    { product_id: "p-1", warehouse_id: "wh-2", quantity:  5, reserved: 0, reorder_level: 10, version: 1 },
    { product_id: "p-2", warehouse_id: "wh-1", quantity: 17, reserved: 0, reorder_level:  5, version: 1 },
    { product_id: "p-2", warehouse_id: "wh-2", quantity: 30, reserved: 0, reorder_level:  5, version: 1 },
  ];
  app.get(`${r}/inventory`, requireAuth, (_req, res) => res.json(inv));
  app.post(`${r}/inventory/cell`, requireAuth, (req, res) => {
    const { product_id, warehouse_id, next_quantity, expected_version } = req.body || {};
    const row = inv.find((x) => x.product_id === product_id && x.warehouse_id === warehouse_id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.version !== expected_version) return res.status(409).json({ error: "Version conflict", code: "version_conflict" });
    row.quantity = next_quantity; row.version += 1;
    res.json(row);
  });
  app.post(`${r}/inventory/bulk`, requireAuth, (req, res) => {
    const updates = (req.body && req.body.updates) || [];
    let ok = 0; const failed = [];
    for (const u of updates) {
      const row = inv.find((x) => x.product_id === u.product_id && x.warehouse_id === u.warehouse_id);
      if (!row) { failed.push({ ...u, reason: "not_found" }); continue; }
      if (row.version !== u.expected_version) { failed.push({ ...u, reason: "version_conflict" }); continue; }
      row.quantity = u.next_quantity; row.version += 1; ok += 1;
    }
    res.json({ ok, failed });
  });

  // --- Audit + Orders (empty fixtures — UI handles empty state) ------------
  app.get(`${r}/inventory/audit`, requireAuth, (_req, res) => res.json([]));
  app.get(`${r}/orders`, requireAuth, (_req, res) => res.json([]));
  app.post(`${r}/orders`, requireAuth, (req, res) => res.status(501).json({ error: "Routing not implemented in stub" }));
  app.get(`${r}/orders/:id`, requireAuth, (_req, res) => res.status(404).json({ error: "Not found" }));
  app.patch(`${r}/shipments/:id`, requireAuth, (req, res) => res.json({ id: req.params.id, status: req.body?.status }));
}
