// WooCommerce Analytics wrapper.
// Wraps the wc-analytics/reports/* namespace (WC 4.0+) with automatic
// fallback to the legacy wc/v3/reports/* namespace (and ultimately to a
// brute-force scan of wc/v3/orders) when wc-analytics is disabled or not
// exposed by the store.
//
// Each function takes a `site` (with store_url, consumer_key, consumer_secret)
// and returns normalized data plus a `limited: boolean` flag indicating
// whether the response came from a fallback path.

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

async function wcGetWithHeaders(site, path, params = {}) {
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
  const totalHeader = res.headers.get("x-wp-total");
  const totalPagesHeader = res.headers.get("x-wp-totalpages");
  return {
    data: await res.json(),
    total: totalHeader ? Number(totalHeader) : 0,
    totalPages: totalPagesHeader ? Number(totalPagesHeader) : 0,
  };
}

function fmtIsoDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString();
}

function fmtDay(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

// ---- Order scan fallback ----
// When wc-analytics is unavailable, we paginate wc/v3/orders to compute
// revenue, item counts, and customer counts ourselves. We cap at MAX_ORDERS
// to avoid runaway requests on huge stores.
const MAX_ORDER_SCAN = 1000;
const PER_PAGE = 100;

// WooCommerce Analytics' "Revenue" report counts only these statuses by default
// (the `actionable_statuses` setting). Matches the headline numbers in
// /wp-admin/admin.php?page=wc-admin&path=/analytics/revenue.
const REVENUE_STATUSES = ["processing", "completed"];

async function scanOrders(site, { from, to, statuses }) {
  const after = fmtIsoDate(from);
  const before = fmtIsoDate(to);
  const statusParam = (statuses && statuses.length > 0 ? statuses : ["any"]).join(",");
  const orders = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && orders.length < MAX_ORDER_SCAN) {
    const { data, totalPages: tp } = await wcGetWithHeaders(site, "wc/v3/orders", {
      after,
      before,
      status: statusParam,
      per_page: String(PER_PAGE),
      page: String(page),
      orderby: "date",
      order: "asc",
    });
    if (!Array.isArray(data) || data.length === 0) break;
    for (const o of data) orders.push(o);
    totalPages = tp || 1;
    page += 1;
    if (page > 50) break; // hard safety cap (5000 orders)
  }
  return orders;
}

// Per-order refunds cache keyed by `${siteUrl}:${orderId}` so re-fetches across
// quick page reloads don't re-hit WooCommerce. Refund totals are immutable once
// posted, so caching aggressively is safe.
const refundsCache = new Map();

async function fetchOrderRefundTotal(site, orderId) {
  const cacheKey = `${normalizeUrl(site.store_url)}:${orderId}`;
  const hit = refundsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  try {
    const data = await wcGet(site, `wc/v3/orders/${orderId}/refunds`, { per_page: "100" });
    let lineRefunds = 0;
    let shippingRefunds = 0;
    let taxRefunds = 0;
    let total = 0;
    if (Array.isArray(data)) {
      for (const r of data) {
        // r.amount is the absolute refund amount (positive in WC API).
        total += Math.abs(Number(r.amount || 0));
        if (Array.isArray(r.line_items)) {
          for (const li of r.line_items) {
            // Refund line totals come back negative; take absolute.
            lineRefunds += Math.abs(Number(li.subtotal ?? li.total ?? 0));
          }
        }
        if (Array.isArray(r.shipping_lines)) {
          for (const sl of r.shipping_lines) {
            shippingRefunds += Math.abs(Number(sl.total || 0));
          }
        }
        if (Array.isArray(r.tax_lines)) {
          for (const tl of r.tax_lines) {
            taxRefunds += Math.abs(Number(tl.tax_total || 0));
          }
        }
      }
    }
    const value = { total, lineRefunds, shippingRefunds, taxRefunds };
    refundsCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    return { total: 0, lineRefunds: 0, shippingRefunds: 0, taxRefunds: 0 };
  }
}

/**
 * Build a Woo-Analytics-equivalent breakdown from a list of orders.
 * Mirrors the formulas used by /wp-admin > Analytics > Revenue:
 *   Gross sales  = Σ line_item.subtotal
 *   Coupons      = Σ coupon_lines.discount
 *   Refunds      = Σ refunded line-item amounts (from /orders/:id/refunds)
 *   Net sales    = Gross − Coupons − Refunds
 *   Shipping     = Σ shipping_lines.total
 *   Taxes        = Σ tax_lines.tax_total + shipping_tax_total
 *   Total sales  = Net + Shipping + Taxes + Fees
 */
async function summarizeOrdersForRevenue(site, orders) {
  let gross = 0;
  let coupons = 0;
  let shipping = 0;
  let taxes = 0;
  let fees = 0;
  let items = 0;
  let refunds = 0;
  const customerIds = new Set();
  const guestEmails = new Set();

  // Fetch refunds in parallel for orders that have them.
  const ordersWithRefunds = orders.filter(
    (o) => Array.isArray(o.refunds) && o.refunds.length > 0,
  );
  const refundResults = await Promise.all(
    ordersWithRefunds.map((o) => fetchOrderRefundTotal(site, o.id).then((r) => [o.id, r])),
  );
  const refundsByOrder = new Map(refundResults);

  for (const o of orders) {
    // Line items: Σ subtotal (pre-discount, ex tax, ex shipping)
    if (Array.isArray(o.line_items)) {
      for (const li of o.line_items) {
        gross += Number(li.subtotal || 0);
        items += Number(li.quantity || 0);
      }
    }
    // Coupons applied
    if (Array.isArray(o.coupon_lines)) {
      for (const cl of o.coupon_lines) {
        coupons += Number(cl.discount || 0);
      }
    }
    // Shipping
    if (Array.isArray(o.shipping_lines)) {
      for (const sl of o.shipping_lines) {
        shipping += Number(sl.total || 0);
      }
    }
    // Taxes (both order taxes and shipping taxes)
    if (Array.isArray(o.tax_lines)) {
      for (const tl of o.tax_lines) {
        taxes += Number(tl.tax_total || 0) + Number(tl.shipping_tax_total || 0);
      }
    }
    // Fees
    if (Array.isArray(o.fee_lines)) {
      for (const fl of o.fee_lines) {
        fees += Number(fl.total || 0);
      }
    }
    // Refunds for this order
    const refund = refundsByOrder.get(o.id);
    if (refund) refunds += refund.lineRefunds;

    // Customer
    if (o.customer_id && Number(o.customer_id) > 0) {
      customerIds.add(Number(o.customer_id));
    } else if (o.billing?.email) {
      guestEmails.add(String(o.billing.email).toLowerCase());
    }
  }

  const net = gross - coupons - refunds;
  const total = net + shipping + taxes + fees;
  return {
    gross,
    coupons,
    refunds,
    net,
    shipping,
    taxes,
    fees,
    total,
    items,
    orders: orders.length,
    customers: customerIds.size + guestEmails.size,
  };
}

/**
 * Returns aggregated performance indicators for the date range, with a
 * Woo-Analytics-equivalent revenue breakdown:
 *   { gross, coupons, refunds, net, shipping, taxes, fees, total }
 *
 * Strategy:
 *   1. Try `wc-analytics/reports/revenue/stats` and read `totals.*` directly —
 *      these match the WooCommerce > Analytics > Revenue UI exactly.
 *   2. Fall back to scanning `wc/v3/orders` (statuses processing+completed
 *      only) and computing the breakdown from line items + per-order refunds.
 *   3. Last resort: legacy `wc/v3/reports/sales` (no breakdown — net only).
 *
 * Returns `revenue` = net sales (the headline figure WooCommerce displays).
 */
export async function getPerformanceIndicators(site, { from, to }) {
  // Step 1: try wc-analytics revenue/stats — has the full breakdown built in.
  try {
    const data = await wcGet(site, "wc-analytics/reports/revenue/stats", {
      after: fmtIsoDate(from),
      before: fmtIsoDate(to),
      interval: "day",
      per_page: 100,
    });
    const t = data?.totals || {};
    const orders = Number(t.orders_count || 0);
    const gross = Number(t.gross_sales || 0);
    const net = Number(t.net_revenue ?? t.net_sales ?? 0);
    if (orders === 0 && gross === 0 && net === 0) {
      throw Object.assign(new Error("wc-analytics revenue/stats empty"), { status: 404 });
    }
    // Pull customers from a separate cheap call; non-fatal if it fails.
    let customers = 0;
    let itemsSold = Number(t.num_items_sold || 0);
    try {
      const c = await wcGet(site, "wc-analytics/reports/performance-indicators", {
        after: fmtIsoDate(from),
        before: fmtIsoDate(to),
        stats: "customers/customers_count,products/items_sold",
      });
      for (const row of Array.isArray(c) ? c : []) {
        if (row.stat === "customers/customers_count") customers = Number(row.value) || 0;
        if (row.stat === "products/items_sold" && !itemsSold) itemsSold = Number(row.value) || 0;
      }
    } catch { /* non-fatal */ }

    return {
      limited: false,
      revenue: net, // headline = Net sales (matches Woo UI)
      orders,
      avg_order_value: orders > 0 ? net / orders : 0,
      items_sold: itemsSold,
      customers,
      refunds: Math.abs(Number(t.refunds || 0)),
      breakdown: {
        gross_sales: gross,
        coupons: Number(t.coupons || 0),
        refunds: Math.abs(Number(t.refunds || 0)),
        net_sales: net,
        shipping: Number(t.shipping || 0),
        taxes: Number(t.taxes || 0),
        fees: Number(t.fees || 0),
        total_sales: Number(t.total_sales || 0),
      },
    };
  } catch (e) {
    if (e.status !== 404 && e.status !== 401 && e.status !== 403 && e.status !== 400) throw e;

    // Step 2: scan wc/v3/orders and compute the breakdown ourselves.
    try {
      const orders = await scanOrders(site, {
        from, to,
        statuses: REVENUE_STATUSES, // processing + completed only — matches Woo's actionable_statuses
      });
      const sum = await summarizeOrdersForRevenue(site, orders);
      return {
        limited: true,
        revenue: sum.net,
        orders: sum.orders,
        avg_order_value: sum.orders > 0 ? sum.net / sum.orders : 0,
        items_sold: sum.items,
        customers: sum.customers,
        refunds: sum.refunds,
        breakdown: {
          gross_sales: sum.gross,
          coupons: sum.coupons,
          refunds: sum.refunds,
          net_sales: sum.net,
          shipping: sum.shipping,
          taxes: sum.taxes,
          fees: sum.fees,
          total_sales: sum.total,
        },
      };
    } catch (e2) {
      // Step 3: last-resort legacy /wc/v3/reports/sales (no breakdown).
      try {
        const sales = await wcGet(site, "wc/v3/reports/sales", {
          date_min: fmtDay(from),
          date_max: fmtDay(to),
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
          breakdown: null,
        };
      } catch {
        throw e2;
      }
    }
  }
}

/**
 * Returns time-series revenue data.
 */
export async function getRevenueStats(site, { from, to, interval = "day" }) {
  try {
    const data = await wcGet(site, "wc-analytics/reports/revenue/stats", {
      after: fmtIsoDate(from),
      before: fmtIsoDate(to),
      interval,
      per_page: 100,
    });
    const intervals = Array.isArray(data?.intervals) ? data.intervals : [];
    const points = intervals.map((iv) => ({
      date: iv.date_start || iv.date || "",
      revenue: Number(iv?.subtotals?.net_revenue ?? iv?.subtotals?.total_sales ?? 0),
      orders: Number(iv?.subtotals?.orders_count ?? 0),
      items: Number(iv?.subtotals?.num_items_sold ?? 0),
    }));
    const totalRevenue = points.reduce((a, p) => a + p.revenue, 0);
    if (totalRevenue === 0 && points.every((p) => p.orders === 0)) {
      // Empty wc-analytics — fall through to scan.
      throw Object.assign(new Error("wc-analytics empty"), { status: 404 });
    }
    return { limited: false, points };
  } catch (e) {
    if (e.status !== 404 && e.status !== 401 && e.status !== 403 && e.status !== 400) throw e;
    // Fallback: scan wc/v3/orders and bucket by interval. Use Net sales
    // (line-item subtotals minus coupons & refunds) so the chart matches Woo.
    try {
      const orders = await scanOrders(site, {
        from, to,
        statuses: REVENUE_STATUSES,
      });
      // Pre-fetch refunds for orders that have them.
      const ordersWithRefunds = orders.filter((o) => Array.isArray(o.refunds) && o.refunds.length > 0);
      const refundPairs = await Promise.all(
        ordersWithRefunds.map((o) => fetchOrderRefundTotal(site, o.id).then((r) => [o.id, r])),
      );
      const refundsByOrder = new Map(refundPairs);
      const buckets = new Map();
      for (const o of orders) {
        const d = new Date(o.date_created || o.date_paid || from);
        const key = bucketKey(d, interval);
        const cur = buckets.get(key) || { date: key, revenue: 0, orders: 0, items: 0 };
        let gross = 0;
        if (Array.isArray(o.line_items)) {
          for (const li of o.line_items) {
            gross += Number(li.subtotal || 0);
            cur.items += Number(li.quantity || 0);
          }
        }
        let coupons = 0;
        if (Array.isArray(o.coupon_lines)) {
          for (const cl of o.coupon_lines) coupons += Number(cl.discount || 0);
        }
        const refund = refundsByOrder.get(o.id);
        const refunds = refund ? refund.lineRefunds : 0;
        cur.revenue += gross - coupons - refunds;
        cur.orders += 1;
        buckets.set(key, cur);
      }
      const points = Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
      return { limited: true, points };
    } catch {
      return { limited: true, points: [] };
    }
  }
}

function bucketKey(d, interval) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  if (interval === "month") return `${yyyy}-${mm}-01`;
  if (interval === "week") {
    // ISO week start (Monday) at UTC.
    const dow = (d.getUTCDay() + 6) % 7; // 0=Mon
    const monday = new Date(Date.UTC(yyyy, d.getUTCMonth(), d.getUTCDate() - dow));
    return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, "0")}-${String(monday.getUTCDate()).padStart(2, "0")}`;
  }
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Top products by items sold.
 */
export async function getTopProducts(site, { from, to, limit = 10 }) {
  try {
    const data = await wcGet(site, "wc-analytics/reports/products", {
      after: fmtIsoDate(from),
      before: fmtIsoDate(to),
      orderby: "items_sold",
      order: "desc",
      per_page: limit,
      extended_info: "true",
    });
    const arr = Array.isArray(data) ? data : [];
    if (arr.length === 0) {
      throw Object.assign(new Error("wc-analytics products empty"), { status: 404 });
    }
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
    if (e.status !== 404 && e.status !== 401 && e.status !== 403 && e.status !== 400) throw e;
    // Fallback: scan orders, aggregate by product.
    try {
      const orders = await scanOrders(site, {
        from, to,
        statuses: ["processing", "completed", "on-hold"],
      });
      const byProduct = new Map();
      for (const o of orders) {
        if (!Array.isArray(o.line_items)) continue;
        for (const li of o.line_items) {
          const id = Number(li.product_id || 0);
          if (!id) continue;
          const cur = byProduct.get(id) || {
            product_id: id,
            name: String(li.name || `#${id}`),
            items_sold: 0,
            net_revenue: 0,
          };
          cur.items_sold += Number(li.quantity || 0);
          cur.net_revenue += Number(li.total || 0);
          byProduct.set(id, cur);
        }
      }
      const products = Array.from(byProduct.values())
        .sort((a, b) => b.items_sold - a.items_sold)
        .slice(0, limit);
      return { limited: true, products };
    } catch {
      return { limited: true, products: [] };
    }
  }
}

/**
 * Orders breakdown by status.
 */
export async function getOrdersStats(site, { from, to }) {
  // Always use the per-status counts from wc/v3/orders since wc-analytics
  // doesn't expose per-status totals directly.
  const byStatus = await fetchStatusCounts(site, { from, to }).catch(() => ({}));
  const total = Object.values(byStatus).reduce((a, n) => a + n, 0);
  return {
    limited: false,
    total_orders: total,
    by_status: byStatus,
  };
}

async function fetchStatusCounts(site, { from, to }) {
  const statuses = ["processing", "completed", "on-hold", "refunded", "cancelled", "failed"];
  const base = normalizeUrl(site.store_url);
  const out = {};
  await Promise.all(statuses.map(async (status) => {
    try {
      const url = `${base}/wp-json/wc/v3/orders?status=${status}&per_page=1&after=${encodeURIComponent(fmtIsoDate(from))}&before=${encodeURIComponent(fmtIsoDate(to))}`;
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
      after: fmtIsoDate(from),
      before: fmtIsoDate(to),
    });
    const totals = data?.totals || {};
    const ordersStats = await wcGet(site, "wc-analytics/reports/orders/stats", {
      after: fmtIsoDate(from),
      before: fmtIsoDate(to),
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
    const totalC = Number(totals.customers_count || 0);
    if (totalC === 0) {
      throw Object.assign(new Error("wc-analytics customers empty"), { status: 404 });
    }
    return {
      limited: false,
      total_customers: totalC,
      new_customers: newOrders,
      returning_customers: returningOrders,
    };
  } catch (e) {
    if (e.status !== 404 && e.status !== 401 && e.status !== 403 && e.status !== 400) throw e;
    // Fallback: scan orders.
    try {
      const orders = await scanOrders(site, {
        from, to,
        statuses: ["processing", "completed", "on-hold"],
      });
      const ids = new Set();
      const guests = new Set();
      let returning = 0;
      let neu = 0;
      const seen = new Set();
      for (const o of orders) {
        const id = Number(o.customer_id || 0);
        const email = String(o.billing?.email || "").toLowerCase();
        const key = id > 0 ? `id:${id}` : email ? `e:${email}` : null;
        if (!key) continue;
        if (id > 0) ids.add(id); else if (email) guests.add(email);
        if (seen.has(key)) returning += 1; else { neu += 1; seen.add(key); }
      }
      return {
        limited: true,
        total_customers: ids.size + guests.size,
        new_customers: neu,
        returning_customers: returning,
      };
    } catch {
      return { limited: true, total_customers: 0, new_customers: 0, returning_customers: 0 };
    }
  }
}

/**
 * Top coupons.
 */
export async function getTopCoupons(site, { from, to, limit = 10 }) {
  try {
    const data = await wcGet(site, "wc-analytics/reports/coupons", {
      after: fmtIsoDate(from),
      before: fmtIsoDate(to),
      orderby: "orders_count",
      order: "desc",
      per_page: limit,
      extended_info: "true",
    });
    const arr = Array.isArray(data) ? data : [];
    if (arr.length === 0) throw Object.assign(new Error("empty"), { status: 404 });
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
    if (e.status !== 404 && e.status !== 401 && e.status !== 403 && e.status !== 400) throw e;
    // Fallback: scan orders, aggregate coupon_lines.
    try {
      const orders = await scanOrders(site, {
        from, to,
        statuses: ["processing", "completed", "on-hold"],
      });
      const byCode = new Map();
      for (const o of orders) {
        if (!Array.isArray(o.coupon_lines)) continue;
        for (const cl of o.coupon_lines) {
          const code = String(cl.code || "").toLowerCase();
          if (!code) continue;
          const cur = byCode.get(code) || {
            coupon_id: Number(cl.id || 0),
            code: String(cl.code || code),
            orders_count: 0,
            amount: 0,
          };
          cur.orders_count += 1;
          cur.amount += Number(cl.discount || 0);
          byCode.set(code, cur);
        }
      }
      const coupons = Array.from(byCode.values())
        .sort((a, b) => b.orders_count - a.orders_count)
        .slice(0, limit);
      return { limited: true, coupons };
    } catch {
      return { limited: true, coupons: [] };
    }
  }
}

/**
 * Get the store currency (from /wc/v3/data/currencies/current).
 */
export async function getStoreCurrency(site) {
  try {
    const data = await wcGet(site, "wc/v3/data/currencies/current");
    return String(data?.code || "GBP").toUpperCase();
  } catch {
    return "GBP";
  }
}
