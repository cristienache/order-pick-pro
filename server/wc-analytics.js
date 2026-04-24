// WooCommerce Analytics wrapper.
// Wraps the wc-analytics/reports/* namespace (WC 4.0+) with automatic
// fallback to the legacy wc/v3/reports/* namespace when wc-analytics is
// disabled or not exposed by the store.
//
// Each function takes a `site` (with store_url, consumer_key, consumer_secret)
// and returns normalized data plus a `limited: boolean` flag indicating
// whether the response came from the fallback namespace (which exposes less
// detail — no per-day series, no avg order value, etc.).

function authHeader(key, secret) {
  const token = Buffer.from(`${key}:${secret}`).toString("base64");
  return `Basic ${token}`;
}

function normalizeUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

async function wcGet(site, path, params = {}) {
  const base = normalizeUrl(site.store_url);
  const search = new URLSearchParams(params).toString();
  const url = `${base}/wp-json/${path}${search ? `?${search}` : ""}`;
  const res = await fetch(url, {
    headers: {
      Authorization: authHeader(site.consumer_key, site.consumer_secret),
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`WC ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function fmtDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString();
}

/**
 * Returns aggregated performance indicators for the date range.
 * Tries wc-analytics first; falls back to legacy reports/sales.
 */
export async function getPerformanceIndicators(site, { from, to }) {
  // wc-analytics performance-indicators returns an array of { stat, value, format, label, currency }.
  try {
    const stats = [
      "revenue/total_sales",
      "revenue/net_revenue",
      "orders/orders_count",
      "orders/avg_order_value",
      "products/items_sold",
      "customers/customers_count",
      "revenue/refunds",
    ].join(",");
    const data = await wcGet(site, "wc-analytics/reports/performance-indicators", {
      after: fmtDate(from),
      before: fmtDate(to),
      stats,
    });
    const map = {};
    for (const row of Array.isArray(data) ? data : []) {
      map[row.stat] = Number(row.value) || 0;
    }
    return {
      limited: false,
      revenue: map["revenue/net_revenue"] ?? map["revenue/total_sales"] ?? 0,
      orders: map["orders/orders_count"] ?? 0,
      avg_order_value: map["orders/avg_order_value"] ?? 0,
      items_sold: map["products/items_sold"] ?? 0,
      customers: map["customers/customers_count"] ?? 0,
      refunds: Math.abs(map["revenue/refunds"] ?? 0),
    };
  } catch (e) {
    if (e.status !== 404 && e.status !== 401 && e.status !== 403) throw e;
    // Fallback: legacy reports/sales — only gives totals, not breakdown.
    const sales = await wcGet(site, "wc/v3/reports/sales", {
      date_min: fmtDate(from)?.slice(0, 10),
      date_max: fmtDate(to)?.slice(0, 10),
    });
    const row = Array.isArray(sales) ? sales[0] || {} : {};
    const totalSales = Number(row.total_sales || 0);
    const totalOrders = Number(row.total_orders || 0);
    return {
      limited: true,
      revenue: totalSales,
      orders: totalOrders,
      avg_order_value: totalOrders ? totalSales / totalOrders : 0,
      items_sold: Number(row.total_items || 0),
      customers: Number(row.total_customers || 0),
      refunds: Math.abs(Number(row.total_refunds || 0)),
    };
  }
}

/**
 * Returns time-series revenue data.
 */
export async function getRevenueStats(site, { from, to, interval = "day" }) {
  try {
    const data = await wcGet(site, "wc-analytics/reports/revenue/stats", {
      after: fmtDate(from),
      before: fmtDate(to),
      interval,
      per_page: 100,
    });
    const intervals = Array.isArray(data?.intervals) ? data.intervals : [];
    return {
      limited: false,
      points: intervals.map((iv) => ({
        date: iv.date_start || iv.date || "",
        revenue: Number(iv?.subtotals?.net_revenue ?? iv?.subtotals?.total_sales ?? 0),
        orders: Number(iv?.subtotals?.orders_count ?? 0),
        items: Number(iv?.subtotals?.num_items_sold ?? 0),
      })),
    };
  } catch (e) {
    if (e.status !== 404 && e.status !== 401 && e.status !== 403) throw e;
    // No good legacy equivalent for series — try /reports/sales which includes a "totals" object keyed by day.
    try {
      const sales = await wcGet(site, "wc/v3/reports/sales", {
        date_min: fmtDate(from)?.slice(0, 10),
        date_max: fmtDate(to)?.slice(0, 10),
      });
      const row = Array.isArray(sales) ? sales[0] || {} : {};
      const totals = row.totals || {};
      const points = Object.entries(totals).map(([date, t]) => ({
        date,
        revenue: Number(t?.sales || 0),
        orders: Number(t?.orders || 0),
        items: Number(t?.items || 0),
      }));
      return { limited: true, points };
    } catch {
      return { limited: true, points: [] };
    }
  }
}

/**
 * Top products by items sold.
 */
export async function getTopProducts(site, { from, to, limit = 10 }) {
  try {
    const data = await wcGet(site, "wc-analytics/reports/products", {
      after: fmtDate(from),
      before: fmtDate(to),
      orderby: "items_sold",
      order: "desc",
      per_page: limit,
      extended_info: "true",
    });
    const arr = Array.isArray(data) ? data : [];
    return {
      limited: false,
      products: arr.map((p) => ({
        product_id: Number(p.product_id || 0),
        name: String(p.extended_info?.name || p.name || `#${p.product_id}`),
        items_sold: Number(p.items_sold || 0),
        net_revenue: Number(p.net_revenue || 0),
      })),
    };
  } catch (e) {
    if (e.status !== 404 && e.status !== 401 && e.status !== 403) throw e;
    try {
      const data = await wcGet(site, "wc/v3/reports/top_sellers", {
        date_min: fmtDate(from)?.slice(0, 10),
        date_max: fmtDate(to)?.slice(0, 10),
      });
      const arr = Array.isArray(data) ? data : [];
      return {
        limited: true,
        products: arr.slice(0, limit).map((p) => ({
          product_id: Number(p.product_id || p.id || 0),
          name: String(p.title || p.name || `#${p.product_id}`),
          items_sold: Number(p.quantity || p.total || 0),
          net_revenue: 0, // legacy doesn't return revenue per product
        })),
      };
    } catch {
      return { limited: true, products: [] };
    }
  }
}

/**
 * Orders breakdown by status.
 */
export async function getOrdersStats(site, { from, to }) {
  try {
    const data = await wcGet(site, "wc-analytics/reports/orders/stats", {
      after: fmtDate(from),
      before: fmtDate(to),
      interval: "day",
      per_page: 100,
    });
    // Totals don't break down by status — we have to fetch the orders endpoint for that.
    // Use /wc-analytics/reports/orders with status filter chunks.
    const totals = data?.totals || {};
    return {
      limited: false,
      total_orders: Number(totals.orders_count || 0),
      by_status: await fetchStatusCounts(site, { from, to }),
    };
  } catch (e) {
    if (e.status !== 404 && e.status !== 401 && e.status !== 403) throw e;
    return {
      limited: true,
      total_orders: 0,
      by_status: await fetchStatusCounts(site, { from, to }).catch(() => ({})),
    };
  }
}

async function fetchStatusCounts(site, { from, to }) {
  // Use wc/v3/orders with status filter — small per_page, count only via X-WP-Total header.
  const statuses = ["processing", "completed", "on-hold", "refunded", "cancelled", "failed"];
  const base = normalizeUrl(site.store_url);
  const out = {};
  await Promise.all(statuses.map(async (status) => {
    try {
      const url = `${base}/wp-json/wc/v3/orders?status=${status}&per_page=1&after=${encodeURIComponent(fmtDate(from))}&before=${encodeURIComponent(fmtDate(to))}`;
      const res = await fetch(url, {
        headers: {
          Authorization: authHeader(site.consumer_key, site.consumer_secret),
          Accept: "application/json",
        },
      });
      if (!res.ok) { out[status] = 0; return; }
      const total = res.headers.get("x-wp-total");
      out[status] = total ? Number(total) : 0;
    } catch {
      out[status] = 0;
    }
  }));
  return out;
}

/**
 * Customers stats.
 */
export async function getCustomersStats(site, { from, to }) {
  try {
    const data = await wcGet(site, "wc-analytics/reports/customers/stats", {
      after: fmtDate(from),
      before: fmtDate(to),
    });
    const totals = data?.totals || {};
    // wc-analytics doesn't directly split new/returning here; use /reports/orders/stats segmented by customer_type.
    const ordersStats = await wcGet(site, "wc-analytics/reports/orders/stats", {
      after: fmtDate(from),
      before: fmtDate(to),
      segmentby: "customer_type",
    }).catch(() => null);
    let newOrders = 0; let returningOrders = 0;
    if (ordersStats?.totals?.segments) {
      for (const seg of ordersStats.totals.segments) {
        const type = seg?.segment_label || seg?.segment_id;
        const c = Number(seg?.subtotals?.orders_count || 0);
        if (type === "new") newOrders += c;
        else if (type === "returning") returningOrders += c;
      }
    }
    return {
      limited: false,
      total_customers: Number(totals.customers_count || 0),
      new_customers: newOrders,
      returning_customers: returningOrders,
    };
  } catch (e) {
    if (e.status !== 404 && e.status !== 401 && e.status !== 403) throw e;
    return { limited: true, total_customers: 0, new_customers: 0, returning_customers: 0 };
  }
}

/**
 * Top coupons.
 */
export async function getTopCoupons(site, { from, to, limit = 10 }) {
  try {
    const data = await wcGet(site, "wc-analytics/reports/coupons", {
      after: fmtDate(from),
      before: fmtDate(to),
      orderby: "orders_count",
      order: "desc",
      per_page: limit,
      extended_info: "true",
    });
    const arr = Array.isArray(data) ? data : [];
    return {
      limited: false,
      coupons: arr.map((c) => ({
        coupon_id: Number(c.coupon_id || 0),
        code: String(c.extended_info?.code || c.code || `#${c.coupon_id}`),
        orders_count: Number(c.orders_count || 0),
        amount: Number(c.amount || 0),
      })),
    };
  } catch (e) {
    if (e.status !== 404 && e.status !== 401 && e.status !== 403) throw e;
    return { limited: true, coupons: [] };
  }
}

/**
 * Get the store currency (from /wc/v3/system_status or settings).
 * Cached implicitly per process via the caller.
 */
export async function getStoreCurrency(site) {
  try {
    const data = await wcGet(site, "wc/v3/data/currencies/current");
    return String(data?.code || "GBP").toUpperCase();
  } catch {
    return "GBP";
  }
}
