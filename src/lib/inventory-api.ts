// Typed REST client for the HeyShop Inventory ("OMS") backend.
//
// Endpoints live under /api/oms/* on the HeyShop Express server (see
// docs/heyshop-api-contract.md). Auth piggybacks on HeyShop's existing
// JWT (Bearer token from localStorage["ultrax_token"]) — we reuse the
// `api()` helper from src/lib/api.ts so the same auth flow applies.
//
// All shared shapes live in src/lib/api-types.ts so the Express server
// can import (or mirror) the exact same definitions.

import { api } from "./api";
import type {
  AuditRow,
  BulkUpdateInventoryInput,
  BulkUpdateInventoryResult,
  CreateOrderInput,
  InventoryRow,
  OmsSession,
  Order,
  OrderDetail,
  Product,
  ShipmentStatus,
  UpdateInventoryCellInput,
  Warehouse,
} from "./api-types";

export type * from "./api-types";

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
