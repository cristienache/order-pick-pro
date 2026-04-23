// Typed REST client for the HeyShop Inventory ("OMS") backend.
//
// Endpoints live under /api/oms/* on the HeyShop Express server (see
// docs/heyshop-api-contract.md). Auth piggybacks on HeyShop's existing
// JWT (Bearer token from localStorage["ultrax_token"]) — we reuse the
// `api()` helper from src/lib/api.ts so the same auth flow applies.

import { api } from "./api";

/* ---------------- Shared domain types ---------------- */

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

export interface Product {
  id: string;
  sku: string;
  name: string;
  source: ProductSource;
  base_price: number;
  woo_product_id: number | null;
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
  version: number;
}

export interface AuditRow {
  id: string;
  product_id: string;
  warehouse_id: string;
  delta: number;
  new_qty: number;
  reason: string;
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
  warehouse_ids: string[];
}

/* ---------------- Request/response payloads ---------------- */

export interface UpdateInventoryCellInput {
  product_id: string;
  warehouse_id: string;
  next_quantity: number;
  expected_version: number;
  reason?: string;
}

export interface BulkUpdateInventoryInput {
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

/* ---------------- Client surface ---------------- */

const BASE = "/api/oms";

export const omsApi = {
  session: {
    me: () =>
      api<OmsSession | null>(`${BASE}/session`).catch((e: unknown) => {
        // Treat 401 as "not signed up to OMS yet" rather than a hard error.
        if (e instanceof Error && /401/.test(e.message)) return null;
        throw e;
      }),
  },
  catalog: {
    listProducts: () => api<Product[]>(`${BASE}/products`),
    listWarehouses: (opts?: { activeOnly?: boolean }) =>
      api<Warehouse[]>(`${BASE}/warehouses${opts?.activeOnly ? "?active=1" : ""}`),
  },
  inventory: {
    list: (opts?: { product_ids?: string[] }) => {
      const qs = opts?.product_ids?.length
        ? `?product_ids=${opts.product_ids.join(",")}`
        : "";
      return api<InventoryRow[]>(`${BASE}/inventory${qs}`);
    },
    updateCell: (input: UpdateInventoryCellInput) =>
      api<InventoryRow>(`${BASE}/inventory/cell`, { method: "POST", body: input }),
    bulkUpdate: (input: BulkUpdateInventoryInput) =>
      api<BulkUpdateInventoryResult>(`${BASE}/inventory/bulk`, { method: "POST", body: input }),
  },
  audit: {
    list: (opts?: { limit?: number }) =>
      api<AuditRow[]>(`${BASE}/inventory/audit?limit=${opts?.limit ?? 500}`),
  },
  orders: {
    list: (opts?: { limit?: number }) =>
      api<Array<Order & { shipment_count: number }>>(
        `${BASE}/orders?limit=${opts?.limit ?? 100}`,
      ),
    create: (input: CreateOrderInput) =>
      api<OrderDetail>(`${BASE}/orders`, { method: "POST", body: input }),
    detail: (id: string) => api<OrderDetail>(`${BASE}/orders/${id}`),
    setShipmentStatus: (shipmentId: string, status: ShipmentStatus) =>
      api<{ id: string; status: ShipmentStatus }>(
        `${BASE}/shipments/${shipmentId}`,
        { method: "PATCH", body: { status } },
      ),
  },
};
