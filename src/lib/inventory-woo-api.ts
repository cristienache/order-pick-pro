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
  /** Small thumbnail URL pulled from WC images[0].src — null if WC has none. */
  image_url: string | null;
  /** "simple" | "variable" | "variation". Variable parents have no editable
   *  stock/price of their own — those live on each variation row. */
  wc_type: "simple" | "variable" | "variation";
  /** oms_products.id of the variable parent, when this row is a variation. */
  parent_product_id: string | null;
  /** WC parent product id for variations (used by /push to target the right URL). */
  wc_parent_id: number | null;
  /** "Red / Large" — pre-built from the variation's attribute options. */
  variation_label: string | null;
  /** WC product creation timestamp (ISO). Drives "newest/oldest" sort. */
  wc_date_created: string | null;
  wc_date_modified: string | null;
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

  /** All WC-mirror products + variations for a site, with every field the
   *  bulk editor needs (description, sale_price, weight, image, etc.). */
  listProducts: (siteId: number) =>
    api<WcProductRow[]>(`${BASE}/products?site_id=${siteId}`),


  /** One chunk of the sync. Call repeatedly until `done` is true.
   *  Pass `since` (returned by page 1) on subsequent pages so the whole
   *  multi-page run uses the same incremental cursor. Pass `full=true`
   *  to bypass the incremental filter and re-import everything. */
  syncPage: (
    siteId: number,
    page: number,
    perPage = 50,
    opts: { since?: string; cursor?: string; full?: boolean } = {},
  ) => {
    const qs = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
    });
    if (opts.full) qs.set("full", "1");
    if (opts.since) qs.set("since", opts.since);
    if (opts.cursor) qs.set("cursor", opts.cursor);
    return api<{
      page: number; per_page: number; batch_size: number;
      created: number; updated: number;
      errors: Array<{ wc_id?: number; product_id?: string; error: string }>;
      done: boolean; next_page: number | null;
      total_products: number | null; total_pages: number | null;
      warehouse_id: string;
      incremental: boolean; since: string; cursor: string;
    }>(`${BASE}/sync/${siteId}?${qs.toString()}`, {
      method: "POST", body: {},
    });
  },

  /** Destructive: deletes every imported product (and its variations + stock)
   *  for one site. Backend requires { confirm: "DELETE" } as a safety net. */
  wipeSite: (siteId: number) =>
    api<{ ok: true; deleted: number; site_id: number }>(
      `${BASE}/wipe/${siteId}`,
      { method: "POST", body: { confirm: "DELETE" } },
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
