# HeyShop Inventory ("OMS") API Contract

This document is the source of truth for the Inventory module's REST API.
The React client (`src/lib/inventory-api.ts`) calls these endpoints; the
HeyShop Express server (`/server`) must implement them.

## Conventions

- **Base path:** `/api/oms`
- **Auth:** every endpoint (except where noted) requires the same JWT bearer
  token used by the rest of HeyShop:
  `Authorization: Bearer <localStorage["ultrax_token"]>`.
  Reuse the existing `requireAuth` middleware in `server/auth.js` — `req.user`
  is `{ id, email, role }`.
- **Content-Type:** `application/json` for all requests with a body.
- **Errors:** non-2xx responses return
  `{ "error": string, "code"?: string, "details"?: unknown }`.
  401 → not signed in. 403 → signed in but not allowed. 409 → version
  conflict on optimistic update. 422 → validation error.
- **IDs:** all primary keys are server-generated UUID strings.
- **Timestamps:** ISO 8601 strings (`2026-04-23T10:15:00.000Z`).
- **Money:** plain numbers (no Decimal wrapper). Quantities are integers ≥ 0.

Shared TypeScript types live in [`src/lib/api-types.ts`](../src/lib/api-types.ts)
and are re-exported from [`src/lib/inventory-api.ts`](../src/lib/inventory-api.ts).
The full SQLite-backed implementation lives in
[`server/oms.js`](../server/oms.js) and is mounted from `server/index.js`
via `mountOms(app, { requireAuth })`.

---

## Session

### `GET /api/oms/session`

Return the OMS-specific role + warehouse assignments for the current user.

- **Auth:** required.
- **200 →** `OmsSession`:
  ```json
  {
    "id": "uuid",
    "email": "user@example.com",
    "roles": ["admin"],
    "warehouse_ids": ["uuid", "uuid"]
  }
  ```
- **401 →** treated by the client as "not signed up to OMS yet" (returns
  `null`, not an error).

`roles` is `("admin" | "manager" | "viewer")[]`. `warehouse_ids` is the set of
warehouses the user can edit. Admins can edit all warehouses regardless.

---

## Catalog

### `GET /api/oms/products`

List every product visible to the user.

- **Auth:** required.
- **200 →** `Product[]`:
  ```json
  [{ "id": "uuid", "sku": "WIDGET-1", "name": "Widget",
     "source": "woo", "base_price": 19.99, "woo_product_id": 1234 }]
  ```

`source` is `"woo"` (synced from WooCommerce) or `"oms"` (created in HeyShop).

### `GET /api/oms/warehouses?active=1`

List warehouses. `?active=1` filters to `is_active = true`.

- **Auth:** required.
- **200 →** `Warehouse[]`:
  ```json
  [{ "id": "uuid", "name": "London DC", "code": "LON",
     "address": "1 Main St", "lat": 51.5, "lng": -0.12,
     "capacity_units": 10000, "is_active": true }]
  ```

---

## Inventory

### `GET /api/oms/inventory?product_ids=a,b,c`

Return the per-warehouse stock grid. If `product_ids` is omitted, return all
products. The server MUST filter to warehouses the user is allowed to see
(`warehouse_ids` from session, or all if admin).

- **Auth:** required.
- **200 →** `InventoryRow[]`:
  ```json
  [{ "product_id": "uuid", "warehouse_id": "uuid",
     "quantity": 42, "reserved": 0,
     "reorder_level": 10, "version": 7 }]
  ```

`version` is an integer that increments on every successful update — used by
the client for optimistic concurrency.

### `POST /api/oms/inventory/cell`

Single-cell update with version check.

- **Body** (`UpdateInventoryCellInput`):
  ```json
  { "product_id": "uuid", "warehouse_id": "uuid",
    "next_quantity": 50, "expected_version": 7,
    "reason": "Manual edit" }
  ```
- **200 →** the updated `InventoryRow` (with `version` incremented by 1).
- **409 →** `{ "error": "Version conflict", "code": "version_conflict" }`
  when `expected_version` does not match the current row.
- **403 →** when the user cannot edit that warehouse.
- **422 →** when `next_quantity < 0`.

The server MUST also append an `AuditRow` (see below) inside the same
transaction with `delta = next_quantity - previous`, `source = "ui"`,
`actor_id = req.user.id`.

### `POST /api/oms/inventory/bulk`

Bulk update; partial success is allowed.

- **Body** (`BulkUpdateInventoryInput`):
  ```json
  { "reason": "Bulk edit",
    "updates": [
      { "product_id": "uuid", "warehouse_id": "uuid",
        "next_quantity": 50, "expected_version": 7 }
    ] }
  ```
- **200 →** `BulkUpdateInventoryResult`:
  ```json
  { "ok": 12,
    "failed": [
      { "product_id": "uuid", "warehouse_id": "uuid",
        "reason": "version_conflict", "message": "..." }
    ] }
  ```

`failed[].reason` ∈ `"version_conflict" | "forbidden" | "not_found" | "error"`.
The endpoint MUST return 200 even if some rows failed — only return non-2xx
when the entire request is malformed.

---

## Audit

### `GET /api/oms/inventory/audit?limit=500`

Most recent stock changes (newest first). `limit` defaults to 500, max 1000.

- **Auth:** required.
- **200 →** `AuditRow[]`:
  ```json
  [{ "id": "uuid", "product_id": "uuid", "warehouse_id": "uuid",
     "delta": -3, "new_qty": 39,
     "reason": "Manual edit", "source": "ui",
     "actor_id": "uuid", "created_at": "2026-04-23T10:15:00.000Z" }]
  ```

`source` is a free-form short string (e.g. `"ui"`, `"woo-sync"`,
`"order-route"`, `"import"`).

---

## Orders & routing

### `GET /api/oms/orders?limit=100`

List recent orders (newest first), each with a precomputed `shipment_count`.

- **200 →** `Array<Order & { shipment_count: number }>`.

### `POST /api/oms/orders`

Create an order AND run the greedy nearest-warehouse allocator in a single
call. The server MUST atomically:

1. Insert the `Order` and its `OrderItem`s.
2. Run `planRouting` (see algorithm below) over current inventory.
3. Insert `OrderShipment`s (one per warehouse with allocations) and their
   `ShipmentItem`s.
4. Decrement `quantity` on the affected `InventoryRow`s and bump `version`.
5. Append matching `AuditRow`s with `source = "order-route"`.
6. Set `Order.status` to one of:
   - `"allocated"` — fully allocated, no shortfall
   - `"partial"` — some shortfall, some shipments
   - `"backorder"` — no shipments at all
7. Return the full `OrderDetail` (order + items + shipments + shipment_items + shortfall).

**Routing algorithm** (must match `src/lib/routing.ts` in the Smart Stock Sync
project):
- Sort warehouses by Manhattan distance to `(customer_lat, customer_lng)`.
- For each line, walk warehouses in that order, taking
  `min(quantity - reserved, remaining)` from each until the line is satisfied
  or warehouses are exhausted.
- Mutate a local copy of the inventory map so subsequent lines see prior
  allocations within the same request.

- **Body** (`CreateOrderInput`):
  ```json
  { "customer_name": "Acme",
    "customer_address": "Denver, CO",
    "customer_lat": 39.7392, "customer_lng": -104.9903,
    "notes": null,
    "items": [{ "product_id": "uuid", "quantity": 2 }] }
  ```
- **200 →** `OrderDetail`.

### `GET /api/oms/orders/:id`

Return the full `OrderDetail` for a single order.

- **404 →** order not found or not visible to this user.

### `PATCH /api/oms/shipments/:id`

Update a shipment's status. Only `status` is patchable for now.

- **Body:** `{ "status": "picked" }` where status ∈
  `"allocated" | "picked" | "shipped" | "cancelled"`.
- **200 →** `{ "id": "uuid", "status": "picked" }`.
- Side effect: when ALL shipments for an order are `"shipped"`, set
  `Order.status = "shipped"`. When all are `"cancelled"`, refund the reserved
  inventory and set `Order.status = "cancelled"`.

---

## WooCommerce bridge (notes for the implementer)

- Products with `source = "woo"` should be created from the existing
  WooCommerce product sync. Stock writes (`POST /inventory/cell`,
  `/inventory/bulk`) for `source = "woo"` products MUST also push the new
  total to WooCommerce via `wc/v3/products/:id` (`stock_quantity` =
  `SUM(quantity) over warehouses`). Use the existing `server/woocommerce.js`
  client.
- Audit entries for syncs should set `source = "woo-sync"` so they're
  distinguishable from manual edits.

## Out of scope (v1)

- Reservation expiry / cron sweeps
- Per-warehouse permissions beyond `warehouse_ids` allowlist
- Imports/exports
- Pickup-point routing (Packeta carriers stay in the existing Shipping module)
