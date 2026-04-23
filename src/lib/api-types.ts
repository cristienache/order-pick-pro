// HeyShop Inventory ("OMS") shared types.
//
// This file is the single source of truth for the request/response shapes
// of every /api/oms/* endpoint described in docs/heyshop-api-contract.md.
//
// Both ends import from here:
//   - The React UI in this project (re-exported by src/lib/inventory-api.ts).
//   - The HeyShop Express server (`/server`) — copy this file under
//     server/oms-types.js as a JSDoc-typed mirror, or share via a workspace
//     package once one exists.

export type ProductSource = "woo" | "oms";

export type OrderStatus =
  | "pending"
  | "allocated"
  | "partial"
  | "backorder"
  | "shipped"
  | "cancelled";

export type ShipmentStatus = "allocated" | "picked" | "shipped" | "cancelled";

export type AppRole = "admin" | "manager" | "viewer";

/* ---------------- Domain entities ---------------- */

export interface Product {
  id: string;
  sku: string;
  name: string;
  source: ProductSource;
  base_price: number;
  woo_product_id: number | null;
  /** ISO timestamp the product row was first created in the OMS. */
  created_at?: string | null;
}

export interface Warehouse {
  id: string;
  name: string;
  code: string;
  address: string | null;
  lat: number;
  lng: number;
  capacity_units: number;
  is_active: boolean;
}

export interface InventoryRow {
  product_id: string;
  warehouse_id: string;
  quantity: number;
  reserved: number;
  reorder_level: number;
  /** Increments on every successful update. Used for optimistic concurrency. */
  version: number;
}

export interface AuditRow {
  id: string;
  product_id: string;
  warehouse_id: string;
  delta: number;
  new_qty: number;
  reason: string;
  /** Free-form short tag: "ui" | "woo-sync" | "order-route" | "import" | ... */
  source: string;
  actor_id: string | null;
  created_at: string;
}

export interface Order {
  id: string;
  customer_name: string;
  customer_address: string | null;
  customer_lat: number;
  customer_lng: number;
  status: OrderStatus;
  notes: string | null;
  woo_order_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  quantity: number;
}

export interface OrderShipment {
  id: string;
  order_id: string;
  warehouse_id: string;
  status: ShipmentStatus;
  tracking: string | null;
  created_at: string;
}

export interface ShipmentItem {
  id: string;
  shipment_id: string;
  product_id: string;
  quantity: number;
}

export interface OmsSession {
  id: string;
  email: string;
  roles: AppRole[];
  /** Warehouses this user can edit. Admins implicitly own all warehouses. */
  warehouse_ids: string[];
}

/* ---------------- Request payloads ---------------- */

export interface UpdateInventoryCellInput {
  product_id: string;
  warehouse_id: string;
  next_quantity: number;
  expected_version: number;
  /** Defaults to "Manual edit" on the server if omitted. */
  reason?: string;
}

export interface BulkUpdateInventoryInput {
  /** Defaults to "Bulk edit" on the server if omitted. */
  reason?: string;
  updates: Array<{
    product_id: string;
    warehouse_id: string;
    next_quantity: number;
    expected_version: number;
  }>;
}

export interface BulkUpdateInventoryResult {
  ok: number;
  failed: Array<{
    product_id: string;
    warehouse_id: string;
    reason: "version_conflict" | "forbidden" | "not_found" | "error";
    message?: string;
  }>;
}

export interface CreateOrderInput {
  customer_name: string;
  customer_address?: string | null;
  customer_lat: number;
  customer_lng: number;
  notes?: string | null;
  items: Array<{ product_id: string; quantity: number }>;
}

export interface OrderDetail {
  order: Order;
  items: OrderItem[];
  shipments: OrderShipment[];
  shipment_items: ShipmentItem[];
  shortfall: Array<{ product_id: string; quantity: number }>;
}

/* ---------------- Errors ---------------- */

export interface ApiErrorBody {
  error: string;
  code?: string;
  details?: unknown;
}
