// Analytics API client — wraps /api/analytics/* endpoints.

import { api } from "./api";

export type AnalyticsWarning = { site_id: number; site_name?: string; error: string };

export type Overview = {
  totals: {
    revenue_gbp: number;
    orders: number;
    items_sold: number;
    avg_order_value_gbp: number;
    new_customers: number;
    returning_customers: number;
    refunds_gbp: number;
    refund_count: number;
  };
  previous?: Overview["totals"];
  per_site: Array<{
    site_id: number;
    site_name: string;
    currency: string;
    revenue: number;
    revenue_gbp: number;
    orders: number;
    items_sold: number;
    refunds: number;
  }>;
  warnings: AnalyticsWarning[];
  fx_source?: string;
};

export type RevenuePoint = {
  date: string;
  revenue: number;
  orders: number;
  items: number;
};

export type RevenueResponse = {
  interval: "day" | "week" | "month";
  combined: RevenuePoint[];
  per_site: Array<{
    site_id: number;
    site_name: string;
    points: RevenuePoint[];
  }>;
  warnings: AnalyticsWarning[];
};

export type TopProduct = {
  product_id: number;
  name: string;
  items_sold: number;
  net_revenue_gbp: number;
  site_id: number;
  site_name: string;
};

export type OrdersStats = {
  by_status: Record<string, number>;
  total_orders: number;
  warnings: AnalyticsWarning[];
};

export type CustomersStats = {
  total_customers: number;
  new_customers: number;
  returning_customers: number;
  by_period: Array<{ date: string; new: number; returning: number }>;
  warnings: AnalyticsWarning[];
};

export type CouponItem = {
  coupon_id: number;
  code: string;
  orders_count: number;
  amount_gbp: number;
  site_name: string;
};

type CommonParams = {
  from: string; // YYYY-MM-DD
  to: string;
  site_ids?: number[];
};

function qs(params: Record<string, string | number | undefined | string[]>) {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length) out.push(`${k}=${encodeURIComponent(v.join(","))}`);
    } else {
      out.push(`${k}=${encodeURIComponent(String(v))}`);
    }
  }
  return out.length ? `?${out.join("&")}` : "";
}

export function getOverview(p: CommonParams & { compare?: "previous_period" | "previous_year" }) {
  return api<Overview>(`/api/analytics/overview${qs({ ...p, site_ids: p.site_ids?.map(String) })}`);
}

export function getRevenue(p: CommonParams & { interval?: "day" | "week" | "month" }) {
  return api<RevenueResponse>(`/api/analytics/revenue${qs({ ...p, site_ids: p.site_ids?.map(String) })}`);
}

export function getTopProducts(p: CommonParams & { limit?: number }) {
  return api<{ products: TopProduct[]; warnings: AnalyticsWarning[] }>(
    `/api/analytics/top-products${qs({ ...p, site_ids: p.site_ids?.map(String) })}`,
  );
}

export function getOrdersStats(p: CommonParams) {
  return api<OrdersStats>(`/api/analytics/orders-stats${qs({ ...p, site_ids: p.site_ids?.map(String) })}`);
}

export function getCustomers(p: CommonParams) {
  return api<CustomersStats>(`/api/analytics/customers${qs({ ...p, site_ids: p.site_ids?.map(String) })}`);
}

export function getCoupons(p: CommonParams & { limit?: number }) {
  return api<{ coupons: CouponItem[]; warnings: AnalyticsWarning[] }>(
    `/api/analytics/coupons${qs({ ...p, site_ids: p.site_ids?.map(String) })}`,
  );
}
