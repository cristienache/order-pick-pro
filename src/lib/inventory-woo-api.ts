// HeyShop Inventory ↔ WooCommerce bridge — typed REST client.
//
// Endpoints live under /api/oms/woo/* on the HeyShop Express server. Auth
// uses the same Bearer JWT as everywhere else (handled by `api()`).

import { api } from "./api";

export type WcSiteSummary = {
  id: number;
  name: string;
  store_url: string;
  created_at: string;
  warehouse_id: string | null;
  last_synced_at: string | null;
  product_count: number;
  dirty_count: number;
};

export type WcProductRow = {
  id: string;
  sku: string;
  name: string;
  source: "oms" | "woo";
  base_price: number;
  woo_product_id: number | null;
  site_id: number | null;
  description: string | null;
  short_description: string | null;
  regular_price: number | null;
  sale_price: number | null;
  stock_status: string | null;
  manage_stock: boolean;
  weight: number | null;
  dirty: boolean;
  last_synced_at: string | null;
  /** From oms_inventory on the mirror warehouse. */
  stock_quantity: number;
  inventory_version: number;
};

export type WcEditPayload = {
  product_id: string;
  fields: Partial<{
    name: string;
    sku: string;
    regular_price: number | null;
    sale_price: number | null;
    description: string;
    short_description: string;
    stock_quantity: number;
    stock_status: string;
    manage_stock: boolean;
    weight: number | null;
  }>;
};

export type WcBackup = {
  id: string;
  site_id: number;
  site_name: string;
  label: string | null;
  product_count: number;
  restored_at: string | null;
  created_at: string;
};

export type BulkResult = {
  ok: number;
  failed: Array<{ product_id?: string; wc_id?: number; reason?: string; error?: string }>;
};

const BASE = "/api/oms/woo";

export const wcApi = {
  listSites: () => api<WcSiteSummary[]>(`${BASE}/sites`),

  sync: (siteId: number) =>
    api<{ total: number; created: number; updated: number; warehouse_id: string }>(
      `${BASE}/sync/${siteId}`, { method: "POST", body: {} },
    ),

  saveLocal: (site_id: number, edits: WcEditPayload[]) =>
    api<BulkResult>(`${BASE}/products/bulk`, {
      method: "PATCH", body: { site_id, edits },
    }),

  createBackup: (site_id: number, product_ids: string[], label?: string) =>
    api<{ id: string; count: number; errors: Array<{ oms_product_id: string; error: string }> }>(
      `${BASE}/backups`, { method: "POST", body: { site_id, product_ids, label } },
    ),

  listBackups: () => api<WcBackup[]>(`${BASE}/backups`),

  restoreBackup: (id: string) =>
    api<BulkResult>(`${BASE}/backups/${id}/restore`, { method: "POST", body: {} }),

  push: (site_id: number, product_ids: string[]) =>
    api<BulkResult>(`${BASE}/push`, { method: "POST", body: { site_id, product_ids } }),
};
